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
    threads: s.threads,
  });
}

function upsertThread(meta: ThreadMeta): void {
  set((s) => {
    const i = s.threads.findIndex((t) => t.threadId === meta.threadId);
    const threads = i >= 0 ? s.threads.map((t, j) => (j === i ? meta : t)) : [meta, ...s.threads];
    const detail = s.detail && s.detail.meta.threadId === meta.threadId ? { ...s.detail, meta } : s.detail;
    return { threads, detail };
  });
}

function appendEvent(env: ThreadEnvelope): void {
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
      const live = s.detail?.meta.threadId === threadId ? s.detail.events : [];
      const ids = new Set(d.events.map((e) => e.eventId));
      return { detail: { meta: d.meta, events: [...d.events, ...live.filter((e) => !ids.has(e.eventId))].sort((a, b) => a.at - b.at) } };
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
