import { useSyncExternalStore } from "react";
import type { AgentRecord, DaemonRecord, RegistryDelta, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import { PROTOCOL_VERSION } from "@cafe/protocol/version";
import { api, token, wsUrl, type SearchHit, type Snapshot, type ThreadDetail } from "./api.ts";

export interface State {
  loaded: boolean;
  connected: boolean;
  error?: string;
  host: string;
  displayName?: string;
  isRoot: boolean;
  rootOnline: boolean;
  router: string;
  registryVersion: number;
  agents: Record<string, AgentRecord>;
  daemons: DaemonRecord[];
  threads: ThreadMeta[];
  /** The running daemon still serves an older web build than the one on disk. */
  webStale?: boolean;
  /** The open Thread detail, kept live while open. */
  detail?: ThreadDetail & { loading?: boolean; loadingOlder?: boolean };
  /** Per-thread facts about the latest turn that ThreadMeta does not carry. */
  live: Record<string, LiveTurn>;
  /** Newest first, capped: the global "Live" page. */
  events: ThreadEnvelope[];
  /** The newest event id, used to resume Live after a WebSocket reconnect. */
  lastEventId?: string;
  /** The "Ask" composer on the feed; `to` prefilled by "Ask it". */
  composer?: { to?: string };
  /** Older threads fetched with "Load older" (beyond the snapshot's newest SNAPSHOT_LIMIT). */
  older: { loading: boolean; loaded: boolean; done: boolean };
  /** Feed search; results replace the list while `q` is non-empty. */
  search: { q: string; loading: boolean; results?: SearchResult[]; error?: string };
}

export interface SearchResult {
  meta: ThreadMeta;
  hits: SearchHit[];
}

/** The daemon's snapshot carries this many newest threads (server.ts / daemon.snapshot()). */
const SNAPSHOT_LIMIT = 200;
const OLDER_PAGE = 50;
export const SEARCH_LIMIT = 20;

export interface LiveTurn {
  orderId: string;
  /** When the latest Order (turn) was created. */
  startedAt: number;
  reason?: string;
  router?: string;
  mode?: string;
  targets?: string[];
  demoted?: string[];
  llmError?: string;
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
  events: [],
  older: { loading: false, loaded: false, done: false },
  search: { q: "", loading: false },
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
  const fresh = s.threads.map(norm);
  // A re-snapshot (reconnect) must not drop older threads the user already loaded.
  const ids = new Set(fresh.map((t) => t.threadId));
  const oldest = fresh.reduce((m, t) => Math.min(m, t.createdAt), Number.POSITIVE_INFINITY);
  const kept = state.threads.filter((t) => !ids.has(t.threadId) && t.createdAt < oldest);
  const done = kept.length > 0 ? state.older.done : fresh.length < SNAPSHOT_LIMIT;
  set({
    loaded: true,
    error: undefined,
    host: s.host,
    displayName: s.displayName,
    isRoot: s.isRoot,
    rootOnline: s.rootOnline,
    router: s.router,
    registryVersion: s.registryVersion,
    agents: Object.fromEntries(s.agents.map((a) => [a.agentId, a])),
    daemons: s.daemons,
    threads: [...fresh, ...kept],
    older: { ...state.older, done },
    webStale: s.webStale,
  });
}

/** Fetch the next page of threads older than everything loaded. */
export async function loadOlder(): Promise<void> {
  if (state.older.loading || state.older.done) return;
  const before = state.threads.reduce((m, t) => Math.min(m, t.createdAt), Number.MAX_SAFE_INTEGER);
  set((s) => ({ older: { ...s.older, loading: true } }));
  try {
    const page = (await api.threads(before, OLDER_PAGE)).map(norm);
    set((s) => {
      const ids = new Set(s.threads.map((t) => t.threadId));
      return { threads: [...s.threads, ...page.filter((t) => !ids.has(t.threadId))], older: { loading: false, loaded: true, done: page.length < OLDER_PAGE } };
    });
  } catch (err) {
    set((s) => ({ error: (err as Error).message, older: { ...s.older, loading: false } }));
  }
}

let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** Update the feed search; queries the daemon after a short pause in typing. */
export function setSearch(q: string): void {
  const seq = ++searchSeq;
  if (searchTimer) clearTimeout(searchTimer);
  if (!q.trim()) {
    set({ search: { q, loading: false } });
    return;
  }
  set((s) => ({ search: { ...s.search, q, loading: true, error: undefined } }));
  searchTimer = setTimeout(() => {
    api
      .search(q.trim(), SEARCH_LIMIT)
      .then((rows) => {
        if (seq !== searchSeq) return;
        set({ search: { q, loading: false, results: rows.map((r) => ({ meta: norm(r.meta), hits: r.hits })) } });
      })
      .catch((err) => {
        if (seq !== searchSeq) return;
        set({ search: { q, loading: false, error: (err as Error).message } });
      });
  }, 250);
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
    return { ...live, [env.threadId]: { ...cur, reason: ev.decision.reason, router: ev.decision.router, mode: ev.decision.mode, targets: ev.decision.targets, demoted: ev.decision.demoted, llmError: ev.decision.llmError } };
  }
  return live;
}

function liveFromEvents(events: ThreadEnvelope[], live: Record<string, LiveTurn>): Record<string, LiveTurn> {
  let next = live;
  for (const e of events) next = foldLive(next, e);
  return next;
}

function appendEvent(env: ThreadEnvelope): void {
  pendingEvents.push(env);
  if (flushScheduled) return;
  flushScheduled = true;
  // Coalesce a burst (SSE/backfill often delivers several) into one set() and one array copy (#33).
  queueMicrotask(() => {
    flushScheduled = false;
    const batch = pendingEvents;
    pendingEvents = [];
    if (!batch.length) return;
    appendEvents(batch);
  });
}

let pendingEvents: ThreadEnvelope[] = [];
let flushScheduled = false;

function appendEvents(batch: ThreadEnvelope[]): void {
  // The same envelope can arrive twice (replay + live): keep the first of each id.
  const uniq: ThreadEnvelope[] = [];
  const inBatch = new Set<string>();
  for (const e of batch) {
    if (inBatch.has(e.eventId)) continue;
    inBatch.add(e.eventId);
    uniq.push(e);
  }
  set((s) => {
    let live = s.live;
    for (const env of uniq) live = foldLive(live, env);
    // Global Live page: newest first, bounded; the same envelopes can be replayed on reconnect.
    const seen = new Set(s.events.map((e) => e.eventId));
    const fresh = uniq.filter((e) => !seen.has(e.eventId));
    const events = [...[...fresh].sort((a, b) => b.at - a.at), ...s.events].slice(0, 300);
    const lastEventId = uniq[uniq.length - 1]!.eventId;
    const openId = s.detail?.meta.threadId;
    const mine = openId ? uniq.filter((e) => e.threadId === openId) : [];
    if (!s.detail || !mine.length) return { live, events, lastEventId };
    const known = new Set(s.detail.events.map((e) => e.eventId));
    const add = mine.filter((e) => !known.has(e.eventId));
    if (!add.length) return { live, events, lastEventId };
    return { live, events, lastEventId, detail: { ...s.detail, events: [...s.detail.events, ...add] } };
  });
}

/** Merge two arrays that are each sorted by `at` without a full sort. */
function mergeByAt<T extends { at: number }>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i]!.at <= b[j]!.at)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
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
    await backfillEvents();
  } catch (err) {
    set({ error: (err as Error).message });
  }
}

/** After a reconnect the WebSocket only resumes from now; fill the gap from the daemon's ring. */
async function backfillEvents(): Promise<void> {
  const after = state.lastEventId;
  if (!after) return;
  try {
    const { events, gap } = await api.eventHistory(after);
    if (gap) return; // too old for the ring; the snapshot already resynced the thread list
    for (const env of events) appendEvent(env);
  } catch {
    // Backfill is best-effort; live events keep arriving through the socket.
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
    sock.send(JSON.stringify({ id: nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, kind: "ui", token } }));
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

/** Re-fetch the snapshot after a settings write (display names, router). */
export async function refreshStore(): Promise<void> {
  await refresh();
}

export async function openThread(threadId: string): Promise<void> {
  if (state.detail?.meta.threadId !== threadId) {
    const meta = state.threads.find((t) => t.threadId === threadId);
    set({ detail: meta ? { meta, events: [], loading: true } : undefined });
  }
  try {
    const d = await api.thread(threadId, { limit: 100 });
    set((s) => {
      // Merge in any live events that arrived while fetching.
        const pending = s.detail?.meta.threadId === threadId ? s.detail.events : [];
      const known = new Set(d.events.map((e) => e.eventId));
      const events = mergeByAt(
        d.events,
        pending.filter((e) => !known.has(e.eventId)),
      );
      return { detail: { meta: norm(d.meta), events, hasMore: d.hasMore }, live: liveFromEvents(events, s.live) };
    });
  } catch (err) {
    set({ error: (err as Error).message, detail: undefined });
  }
}

export function closeThread(): void {
  set({ detail: undefined });
}

/** Fetch the page before the oldest event currently loaded (long conversations). */
export async function loadOlderEvents(): Promise<void> {
  const d = state.detail;
  if (!d || d.loading || d.loadingOlder || !d.hasMore) return;
  const oldest = d.events[0]?.eventId;
  if (!oldest) return;
  set({ detail: { ...d, loadingOlder: true } });
  try {
    const page = await api.thread(d.meta.threadId, { limit: 100, before: oldest });
    set((s) => {
      const cur = s.detail;
      if (!cur || cur.meta.threadId !== d.meta.threadId) return {};
      const known = new Set(cur.events.map((e) => e.eventId));
      return { detail: { ...cur, events: [...page.events.filter((e) => !known.has(e.eventId)), ...cur.events], hasMore: page.hasMore, loadingOlder: false } };
    });
  } catch (err) {
    set({ detail: { ...d, loadingOlder: false }, error: (err as Error).message });
  }
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
