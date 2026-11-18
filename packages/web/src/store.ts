import { useSyncExternalStore } from "react";
import type { AgentRecord, DaemonRecord, RegistryDelta, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import { api, token, wsUrl, type Snapshot, type ThreadDetail } from "./api.ts";

export interface State {
  loaded: boolean;
  connected: boolean;
  error?: string;
  host: string;
  isRoot: boolean;
  rootOnline: boolean;
  router: string;
  registryVersion: number;
  agents: Record<string, AgentRecord>;
  daemons: DaemonRecord[];
  threads: ThreadMeta[];
  /** The open Thread detail, kept live while open. */
  detail?: ThreadDetail & { loading?: boolean };
  /** Per-thread facts about the latest turn that ThreadMeta does not carry. */
  live: Record<string, LiveTurn>;
  /** The "Ask" composer on the feed; `to` prefilled by "Ask it". */
  composer?: { to?: string };
}

export interface LiveTurn {
  orderId: string;
  /** When the latest Order (turn) was created. */
  startedAt: number;
  reason?: string;
  router?: string;
  mode?: string;
  targets?: string[];
  demoted?: string[];
}

let state: State = {
  loaded: false,
  connected: false,
  host: "",
  isRoot: false,
  rootOnline: false,
  router: "",
  registryVersion: 0,
  agents: {},
  daemons: [],
  threads: [],
  live: {},
};

const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export function getState(): State {
  return state;
}

/** Threads written by older daemons lack the newer list fields. */
function norm(m: ThreadMeta): ThreadMeta {
  return { ...m, turns: m.turns ?? 1, replies: m.replies ?? [], declines: m.declines ?? [] };
}

function applySnapshot(s: Snapshot): void {
  set({
    loaded: true,
    error: undefined,
    host: s.host,
    isRoot: s.isRoot,
    rootOnline: s.rootOnline,
    router: s.router,
    registryVersion: s.registryVersion,
    agents: Object.fromEntries(s.agents.map((a) => [a.agentId, a])),
    daemons: s.daemons,
    threads: s.threads.map(norm),
  });
}

function upsertThread(raw: ThreadMeta): void {
  const meta = norm(raw);
  set((s) => {
    const i = s.threads.findIndex((t) => t.threadId === meta.threadId);
    const threads = i >= 0 ? s.threads.map((t, j) => (j === i ? meta : t)) : [meta, ...s.threads];
    const detail = s.detail && s.detail.meta.threadId === meta.threadId ? { ...s.detail, meta } : s.detail;
    return { threads, detail };
  });
}

/** Fold one event into the per-thread latest-turn facts. */
function foldLive(live: Record<string, LiveTurn>, env: ThreadEnvelope): Record<string, LiveTurn> {
  const ev = env.event;
  const cur = live[env.threadId];
  if (ev.type === "order.created") {
    if (cur && cur.startedAt > ev.order.createdAt) return live;
    return { ...live, [env.threadId]: { orderId: ev.order.orderId, startedAt: ev.order.createdAt } };
  }
  if (ev.type === "order.routed" && cur && cur.orderId === env.orderId) {
    return { ...live, [env.threadId]: { ...cur, reason: ev.decision.reason, router: ev.decision.router, mode: ev.decision.mode, targets: ev.decision.targets, demoted: ev.decision.demoted } };
  }
  return live;
}

function liveFromEvents(events: ThreadEnvelope[], live: Record<string, LiveTurn>): Record<string, LiveTurn> {
  let next = live;
  for (const e of events) next = foldLive(next, e);
  return next;
}

function appendEvent(env: ThreadEnvelope): void {
  set((s) => ({ live: foldLive(s.live, env) }));
  set((s) => {
    if (!s.detail || s.detail.meta.threadId !== env.threadId) return {};
    if (s.detail.events.some((e) => e.eventId === env.eventId)) return {};
    return { detail: { ...s.detail, events: [...s.detail.events, env] } };
  });
}

function applyDelta(d: RegistryDelta): void {
  set((s) => {
    const agents = { ...s.agents };
    for (const r of d.upsert) agents[r.agentId] = r;
    for (const id of d.remove) delete agents[id];
    return { agents, registryVersion: Math.max(s.registryVersion, d.version) };
  });
}

function onNotification(method: string, params: any): void {
  switch (method) {
    case "thread/event": {
      const { env, meta } = params as { env: ThreadEnvelope; meta?: ThreadMeta };
      if (meta) upsertThread(meta);
      appendEvent(env);
      break;
    }
    case "registry/delta":
      applyDelta(params as RegistryDelta);
      break;
    case "daemons/changed": {
      const daemons = params as DaemonRecord[];
      const root = daemons.find((d) => d.isRoot);
      set((s) => ({ daemons, rootOnline: s.isRoot || !!root?.online }));
      break;
    }
  }
}

async function refresh(): Promise<void> {
  try {
    applySnapshot(await api.snapshot());
    const open = state.detail?.meta.threadId;
    if (open) await openThread(open);
  } catch (err) {
    set({ error: (err as Error).message });
  }
}

let ws: WebSocket | undefined;
let retry = 0;
let started = false;

function connect(): void {
  const sock = new WebSocket(wsUrl());
  ws = sock;
  let nextId = 1;
  sock.addEventListener("open", () => {
    sock.send(JSON.stringify({ id: nextId++, method: "initialize", params: { protocolVersion: 1, kind: "ui", token } }));
  });
  sock.addEventListener("message", (e) => {
    let frame: any;
    try {
      frame = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if ("method" in frame) {
      if (!("id" in frame)) onNotification(frame.method, frame.params);
      return;
    }
    // Response to initialize: we are subscribed; take a fresh snapshot so nothing between load and subscribe is lost.
    if ("error" in frame) {
      set({ error: frame.error?.message ?? "initialize failed" });
      return;
    }
    retry = 0;
    set({ connected: true });
    void refresh();
  });
  sock.addEventListener("close", () => {
    if (ws !== sock) return;
    set({ connected: false });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  });
}

/** Start the live store once: snapshot over HTTP, then deltas over the WebSocket. */
export function start(): void {
  if (started) return;
  started = true;
  void refresh();
  connect();
}

export async function openThread(threadId: string): Promise<void> {
  if (state.detail?.meta.threadId !== threadId) {
    const meta = state.threads.find((t) => t.threadId === threadId);
    set({ detail: meta ? { meta, events: [], loading: true } : undefined });
  }
  try {
    const d = await api.thread(threadId);
    set((s) => {
      // Merge in any live events that arrived while fetching.
        const pending = s.detail?.meta.threadId === threadId ? s.detail.events : [];
      const ids = new Set(d.events.map((e) => e.eventId));
      const events = [...d.events, ...pending.filter((e) => !ids.has(e.eventId))].sort((a, b) => a.at - b.at);
      return { detail: { meta: norm(d.meta), events }, live: liveFromEvents(events, s.live) };
    });
  } catch (err) {
    set({ error: (err as Error).message, detail: undefined });
  }
}

export function closeThread(): void {
  set({ detail: undefined });
}

/** Address of an agent id, or the id itself if unknown. */
export function addressOf(agents: Record<string, AgentRecord>, id: string): string {
  return agents[id]?.address ?? id.slice(-8);
}

const fetching = new Set<string>();

/** Fill `live` for a thread loaded from the snapshot (no events seen yet). Deduplicated, best effort. */
export function ensureLive(threadId: string): void {
  if (state.live[threadId] || fetching.has(threadId)) return;
  // Newer daemons put the latest turn's timing and routing reason on the thread record itself.
  const meta = state.threads.find((t) => t.threadId === threadId);
  if (meta?.turnStartedAt !== undefined && meta.reason !== undefined) {
    const turn: LiveTurn = { orderId: meta.orderId, startedAt: meta.turnStartedAt, reason: meta.reason, router: meta.router, mode: meta.mode, targets: meta.targets };
    set((s) => ({ live: { ...s.live, [threadId]: turn } }));
    return;
  }
  fetching.add(threadId);
  api
    .thread(threadId)
    .then((d) => set((s) => ({ live: liveFromEvents(d.events, s.live) })))
    .catch(() => {})
    .finally(() => fetching.delete(threadId));
}

export function openComposer(to?: string): void {
  set({ composer: { to } });
}

export function closeComposer(): void {
  set({ composer: undefined });
}

export function isActive(status: string): boolean {
  return status === "routing" || status === "delivering" || status === "working";
}

/** The agent name part of an Address (`billing#1@host` → `billing`). */
export function nameOf(address: string): string {
  return address.replace(/[#@].*$/, "");
}
