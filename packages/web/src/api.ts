import type { AgentRecord, Attachment, DaemonRecord, RoutingDecision, RoutingHint, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";

export interface Snapshot {
  host: string;
  displayName?: string;
  aliases?: string[];
  isRoot: boolean;
  rootOnline: boolean;
  router: string;
  registryVersion: number;
  agents: AgentRecord[];
  daemons: DaemonRecord[];
  threads: ThreadMeta[];
  /** The daemon's in-memory web UI is older than the build on disk; restart it. */
  webStale?: boolean;
}

export interface ThreadDetail {
  meta: ThreadMeta;
  events: ThreadEnvelope[];
  /** There are older events before the returned page. */
  hasMore?: boolean;
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

/** A saved config.yml value the running daemon has not applied yet. */
export interface ConfigDiffRow {
  key: string;
  file: unknown;
  running: unknown;
  mode: "hot" | "restart-required";
}

/** Machine-level checks shared with the CLI doctor. */
export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
  next?: string;
}

export interface RuntimeConfig {
  mode: "root" | "daemon";
  host: string;
  displayName?: string;
  port: number;
  advertise?: string;
  root?: string;
  router: { model?: string; fallback?: string; learn?: boolean; timeoutMs?: number; concurrency?: number };
  retention?: { days?: number };
  discovery?: boolean;
  pending: ConfigDiffRow[];
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
  thread: (id: string, opts?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.before) qs.set("before", opts.before);
    const q = qs.toString();
    return call<ThreadDetail>("GET", `/api/threads/${encodeURIComponent(id)}${q ? `?${q}` : ""}`);
  },
  /** New question, or a follow-up when `threadId` is set (rejects with `thread_busy` while a turn is open). */
  createOrder: (p: { body: string; to?: string; kind?: "order" | "notice"; threadId?: string; attachments?: Attachment[] }) =>
    call<{ orderId: string; threadId: string; decision: RoutingDecision }>("POST", "/api/orders", { ...p, as: "web", origin: "human" }),
  cancel: (threadId: string) => call<{}>("POST", `/api/threads/${encodeURIComponent(threadId)}/cancel`),
  kick: (agentId: string) => call<{}>("DELETE", `/api/agents/${encodeURIComponent(agentId)}`),
  agentStats: (since: number) => call<Record<string, AgentStats>>("GET", `/api/agents/stats?since=${since}`),
  /** Last 7 days per Barista identity (`name@host`); survives Barista restarts. */
  routingHints: () => call<{ learn: boolean; hints: Record<string, RoutingHint> }>("GET", "/api/routing/hints"),
  health: () => call<{ ok: boolean; host: string; isRoot: boolean; router: string; model?: string; error?: string; version?: string }>("GET", "/api/health"),
  /** Events after `after` from the daemon's recent ring (WebSocket reconnect backfill). */
  eventHistory: (after: string) => call<{ events: ThreadEnvelope[]; gap: boolean }>("GET", `/api/events/history?after=${encodeURIComponent(after)}`),
  /** pi's model catalogue for the routing picker. */
  routerModels: (search?: string) => call<{ models: string[] }>("GET", `/api/router/models${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  /** Apply a model, or clear to rules with null. A bad model is rolled back by the daemon. */
  setRouterModel: (model: string | null) => call<RouterState>("POST", "/api/router", { model }),
  /** Local Host display name and its aliases; internal ids never change. */
  setHostIdentity: (displayName: string, aliases: string[], removeAliases: string[] = []) =>
    call<{ host: string; displayName?: string; aliases: string[]; legacyAliases?: string[] }>("POST", "/api/host", { displayName, aliases, removeAliases }),
  renameHost: (host: string, displayName: string) => call<unknown>("POST", "/api/hosts/rename", { host, displayName }),
  testHost: (host: string) => call<{ host: string; online: boolean; latencyMs?: number; version?: string; error?: string }>("POST", "/api/hosts/test", { host }),
  reconnectHost: (host: string) => call<{ host: string; online: boolean; latencyMs?: number; version?: string; error?: string }>("POST", "/api/hosts/reconnect", { host }),
  renameAgent: (address: string, displayName: string) => call<unknown>("POST", "/api/agents/rename", { address, displayName }),
  aliasAgent: (address: string, alias: string) => call<unknown>("POST", "/api/agents/rename", { address, alias }),
  removeAgentAlias: (address: string, removeAlias: string) => call<unknown>("POST", "/api/agents/rename", { address, removeAlias }),
  baristas: () => call<BaristaInfo[]>("GET", "/api/baristas"),
  /** Start a supervised Barista. `bin` picks pi (default) or omp; `agent` picks codex or claude. */
  startBarista: (p: { dir: string; bin?: "pi" | "omp"; agent?: "codex" | "claude"; access?: "read-only" | "workspace-write" }) =>
    call<BaristaInfo[]>("POST", "/api/baristas", p),
  stopBarista: (dir: string) => call<{ stopped: boolean }>("DELETE", `/api/baristas?dir=${encodeURIComponent(dir)}`),
  /** Root and a masked token for the Settings panel; never the full secret. */
  settings: () => call<{ root?: string; tokenHint?: string; tokenSet: boolean }>("GET", "/api/settings"),
  /** What the daemon is running plus config.yml changes it has not applied yet. */
  config: () => call<RuntimeConfig>("GET", "/api/config"),
  saveConfig: (p: { advertise?: string | null; retentionDays?: number | null }) =>
    call<{ ok: boolean; restartRequired: boolean; pending: RuntimeConfig["pending"] }>("POST", "/api/config", p),
  doctor: () => call<{ ok: boolean; checks: DoctorCheck[] }>("GET", "/api/doctor"),
  /** Upload one file before creating the Order; the returned metadata goes on the Order. */
  uploadAttachment: async (file: File): Promise<Attachment> => {
    const res = await fetch(withToken(`/api/artifacts?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || "application/octet-stream")}`), {
      method: "POST",
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error ?? String(res.status), data.message ?? data.error ?? `${res.status} ${res.statusText}`);
    return data.attachment as Attachment;
  },
  attachmentUrl: (id: string) => withToken(`/api/artifacts/${encodeURIComponent(id)}`),
};

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return withToken(`${proto}//${location.host}/ws`);
}
