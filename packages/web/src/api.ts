import type { AgentRecord, DaemonRecord, RoutingDecision, RoutingHint, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";

export interface Snapshot {
  host: string;
  isRoot: boolean;
  rootOnline: boolean;
  router: string;
  registryVersion: number;
  agents: AgentRecord[];
  daemons: DaemonRecord[];
  threads: ThreadMeta[];
}

export interface ThreadDetail {
  meta: ThreadMeta;
  events: ThreadEnvelope[];
}

/** Daemons on the LAN require the shared token; open the UI with `?token=…` and it is reused for every call. */
export const token: string | undefined = new URLSearchParams(location.search).get("token") ?? undefined;

function withToken(path: string): string {
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? String(res.status), data.message ?? data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export interface AgentStats {
  answered: number;
  declined: number;
  failed: number;
  lastAnsweredAt?: number;
}

export interface BaristaInfo {
  dir: string;
  agent: string;
  slot: number;
  pid?: number;
  restarts: number;
  startedAt?: number;
  running: boolean;
}

export interface RouterState {
  ok: boolean;
  router: string;
  model?: string;
  error?: string;
}

export interface SearchHit {
  orderId: string;
  who: string;
  text: string;
  at: number;
}

export const api = {
  snapshot: () => call<Snapshot>("GET", "/api/snapshot"),
  /** Threads created before `before` (ms), newest first. */
  threads: (before: number, limit: number) => call<ThreadMeta[]>("GET", `/api/threads?before=${before}&limit=${limit}`),
  /** Full-text search over questions and answers (all threads, not only the loaded ones). */
  search: (q: string, limit: number) => call<{ meta: ThreadMeta; hits: SearchHit[] }[]>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  thread: (id: string) => call<ThreadDetail>("GET", `/api/threads/${encodeURIComponent(id)}`),
  /** New question, or a follow-up when `threadId` is set (rejects with `thread_busy` while a turn is open). */
  createOrder: (p: { body: string; to?: string; kind?: "order" | "notice"; threadId?: string }) =>
    call<{ orderId: string; threadId: string; decision: RoutingDecision }>("POST", "/api/orders", { ...p, as: "web" }),
  cancel: (threadId: string) => call<{}>("POST", `/api/threads/${encodeURIComponent(threadId)}/cancel`),
  kick: (agentId: string) => call<{}>("DELETE", `/api/agents/${encodeURIComponent(agentId)}`),
  agentStats: (since: number) => call<Record<string, AgentStats>>("GET", `/api/agents/stats?since=${since}`),
  /** Last 7 days per Barista identity (`name@host`); survives Barista restarts. */
  routingHints: () => call<{ learn: boolean; hints: Record<string, RoutingHint> }>("GET", "/api/routing/hints"),
  health: () => call<{ ok: boolean; host: string; isRoot: boolean; router: string; model?: string; error?: string; version?: string }>("GET", "/api/health"),
  /** pi's model catalogue for the routing picker. */
  routerModels: (search?: string) => call<{ models: string[] }>("GET", `/api/router/models${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  /** Apply a model, or clear to rules with null. A bad model is rolled back by the daemon. */
  setRouterModel: (model: string | null) => call<RouterState>("POST", "/api/router", { model }),
  /** Local Host display name and its aliases; internal ids never change. */
  setHostIdentity: (displayName: string, aliases: string[]) => call<{ host: string; displayName?: string; aliases: string[] }>("POST", "/api/host", { displayName, aliases }),
  renameHost: (host: string, displayName: string) => call<unknown>("POST", "/api/hosts/rename", { host, displayName }),
  renameAgent: (address: string, displayName: string) => call<unknown>("POST", "/api/agents/rename", { address, displayName }),
  aliasAgent: (address: string, alias: string) => call<unknown>("POST", "/api/agents/rename", { address, alias }),
  baristas: () => call<BaristaInfo[]>("GET", "/api/baristas"),
  stopBarista: (dir: string) => call<{ stopped: boolean }>("DELETE", `/api/baristas?dir=${encodeURIComponent(dir)}`),
};

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return withToken(`${proto}//${location.host}/ws`);
}
