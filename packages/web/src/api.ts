import type { AgentRecord, Attachment, ConnectorStatusRow, DaemonRecord, RoutingDecision, RoutingHint, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import { callerCredentialTransport } from "@cafe/protocol/urls";
import type { JoinHint } from "./join.ts";
import { authHeaders, authState, bootToken, tokenStore } from "./auth.ts";

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
  /** Features the serving Daemon advertises (v4-12); absent = an older build (support unconfirmed). */
  features?: string[];
  /** The daemon's in-memory web UI is older than the build on disk; restart it. */
  webStale?: boolean;
}

export interface ThreadDetail {
  meta: ThreadMeta;
  events: ThreadEnvelope[];
  /** There are older events before the returned page. */
  hasMore?: boolean;
}

export interface ChannelInfo {
  name: string;
  threads: number;
  lastActivityAt?: number;
  teams: { team: string; host: string }[];
  /** More than one team uses this channel; a message without a target is ambiguous (v4-13). */
  conflict?: boolean;
}

export interface TeamView {
  team: string;
  host: string;
  channel: string;
  hostOnline?: boolean;
  online: number;
  total: number;
  openThreads: number;
  lastActivityAt?: number;
  partial?: boolean;
  /** v4-13: the roster came from `.cafe`; its revision moves on every real change. */
  authoritative?: boolean;
  revision?: number;
  roster: {
    name: string;
    duty?: string;
    mode: string;
    dir: string;
    observer?: boolean;
    address?: string;
    status?: string;
    currentThread?: string;
  }[];
}

/**
 * The daemon token on another machine (#97): read once from a `#token=` / `?token=` link or the
 * token prompt, kept in this browser, and sent only as `Authorization: Bearer`.
 */
const boot = typeof location === "undefined" ? {} : bootToken(location.href, typeof localStorage === "undefined" ? undefined : localStorage);
if (boot.cleanUrl) history.replaceState(history.state, "", boot.cleanUrl);
export const token: string | undefined = boot.token;

/** Save a token typed into the prompt and start over with it. */
export function useToken(value: string): void {
  tokenStore(localStorage).set(value.trim());
  location.reload();
}

/** "Forget the token on this browser" in Settings. */
export function forgetToken(): void {
  tokenStore(localStorage).clear();
  location.reload();
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function orderOwnerKey(): string | undefined {
  try {
    const storageKey = "cafe-order-owner";
    const saved = localStorage.getItem(storageKey);
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(storageKey, key);
    return key;
  } catch {
    return undefined;
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, ownerKey?: string): Promise<T> {
  if (ownerKey && callerCredentialTransport(location.origin) === "remote-plaintext") {
    throw new ApiError("tls_required", "caller credentials require loopback access or the HTTPS Cafe address");
  }
  const res = await fetch(path, {
    method,
    signal,
    headers: { ...authHeaders(token), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(ownerKey ? { "x-cafe-order-owner": ownerKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) authState.markRequired();
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
  snapshot: (channel?: string) => call<Snapshot>("GET", `/api/snapshot${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`),
  connectors: (signal: AbortSignal) => call<ConnectorStatusRow[]>("GET", "/api/connectors", undefined, signal),
  /** Threads created before `before` (ms), newest first. */
  threads: (before: number, limit: number, channel?: string) => call<ThreadMeta[]>("GET", `/api/threads?before=${before}&limit=${limit}${channel ? `&channel=${encodeURIComponent(channel)}` : ""}`),
  /** Full-text search over questions and answers (all threads, not only the loaded ones). */
  search: (q: string, limit: number, channel?: string) => call<{ meta: ThreadMeta; hits: SearchHit[] }[]>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}${channel ? `&channel=${encodeURIComponent(channel)}` : ""}`),
  /** Teams replicated to this daemon (v4-11). */
  teams: () => call<TeamView[]>("GET", "/api/teams"),
  /** Channel index: counts plus the teams using each channel. */
  channels: () => call<ChannelInfo[]>("GET", "/api/channels"),
  /** One channel's Threads, newest activity first (observer/Web paging). */
  channelThreads: (name: string, opts: { after?: number; before?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.after) qs.set("after", String(opts.after));
    if (opts.before) qs.set("before", String(opts.before));
    if (opts.limit) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return call<{ threads: ThreadMeta[]; hasMore: boolean; exists: boolean }>("GET", `/api/channels/${encodeURIComponent(name)}/threads${q ? `?${q}` : ""}`);
  },
  thread: (id: string, opts?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.before) qs.set("before", opts.before);
    const q = qs.toString();
    return call<ThreadDetail>("GET", `/api/threads/${encodeURIComponent(id)}${q ? `?${q}` : ""}`);
  },
  /** Clarification/assignment sub-Threads of one Thread (v4-13, #112). */
  children: async (parentThreadId: string) => {
    const result = await call<ThreadMeta[] | { children: ThreadMeta[]; partial: boolean }>("GET", `/api/threads?parent=${encodeURIComponent(parentThreadId)}&limit=200&view=1`);
    return Array.isArray(result) ? { children: result, partial: false } : result;
  },
  /** New question, or a follow-up when `threadId` is set (rejects with `thread_busy` while a turn is open). */
  createOrder: (p: { body: string; to?: string; broadcast?: boolean; kind?: "order" | "notice"; threadId?: string; channel?: string; attachments?: Attachment[] }) =>
    call<{ orderId: string; threadId: string; decision: RoutingDecision }>("POST", "/api/orders", { ...p, as: "web", origin: "human" }, undefined, orderOwnerKey()),
  answerClarification: (parent: string, child: string, clarificationOrderId: string, text: string) =>
    call<{ orderId: string }>("POST", `/api/threads/${encodeURIComponent(parent)}/clarifications/${encodeURIComponent(child)}/answer`, { clarificationOrderId, text }, undefined, orderOwnerKey()),
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
  renameHost: (host: string, displayName: string, aliases: string[] = [], removeAliases: string[] = []) =>
    call<unknown>("POST", "/api/hosts/rename", { host, displayName, aliases, removeAliases }),
  testHost: (host: string) => call<{ host: string; online: boolean; via?: "direct" | "uplink"; address?: string; latencyMs?: number; version?: string; error?: string; code?: string }>("POST", "/api/hosts/test", { host }),
  forgetHost: (host: string) => call<{ host: string; agents: number; config: string[] }>("POST", "/api/hosts/forget", { host }),
  reconnectHost: (host: string) => call<{ host: string; online: boolean; latencyMs?: number; version?: string; error?: string; code?: string }>("POST", "/api/hosts/reconnect", { host }),
  /** Root only: pin the address other machines use for `host`; `null` forgets it (#75). */
  setHostAddress: (host: string, url: string | null) => call<DaemonRecord & { verified?: boolean; error?: string; code?: string }>("POST", "/api/hosts/address", { host, url }),
  renameAgent: (address: string, displayName: string) => call<unknown>("POST", "/api/agents/rename", { address, displayName }),
  aliasAgent: (address: string, alias: string) => call<unknown>("POST", "/api/agents/rename", { address, alias }),
  removeAgentAlias: (address: string, removeAlias: string) => call<unknown>("POST", "/api/agents/rename", { address, removeAlias }),
  baristas: () => call<BaristaInfo[]>("GET", "/api/baristas"),
  /** Start a supervised Barista. `bin` picks pi (default) or omp; `agent` picks codex or claude. */
  startBarista: (p: { dir: string; bin?: "pi" | "omp"; agent?: "codex" | "claude"; access?: "read-only" | "workspace-write" }) =>
    call<BaristaInfo[]>("POST", "/api/baristas", p),
  stopBarista: (dir: string) => call<{ stopped: boolean }>("DELETE", `/api/baristas?dir=${encodeURIComponent(dir)}`),
  /** Root and a masked token for the Settings panel; never the full secret. */
  settings: () => call<{ root?: string; tokenHint?: string; tokenSet: boolean; join?: JoinHint; web?: { https: string[] } }>("GET", "/api/settings"),
  /** Public (no token needed): the CA, its fingerprint and the TLS port, or nulls when TLS is off. */
  tls: () => call<{ ca: string | null; fingerprint256: string | null; tlsPort?: number }>("GET", "/api/tls"),
  /** What the daemon is running plus config.yml changes it has not applied yet. */
  config: () => call<RuntimeConfig>("GET", "/api/config"),
  saveConfig: (p: { advertise?: string | null; retentionDays?: number | null }) =>
    call<{ ok: boolean; restartRequired: boolean; pending: RuntimeConfig["pending"] }>("POST", "/api/config", p),
  doctor: () => call<{ ok: boolean; checks: DoctorCheck[] }>("GET", "/api/doctor"),
  /** Upload one file before creating the Order; the returned metadata goes on the Order. */
  uploadAttachment: (file: File, onProgress?: (pct: number) => void): Promise<Attachment> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/artifacts?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || "application/octet-stream")}`);
      for (const [k, v] of Object.entries(authHeaders(token))) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || "{}") as { attachment?: Attachment; error?: string; message?: string };
        if (xhr.status === 401) authState.markRequired();
        if (xhr.status >= 200 && xhr.status < 300 && data.attachment) resolve(data.attachment);
        else reject(new ApiError(data.error ?? String(xhr.status), data.message ?? data.error ?? `${xhr.status} ${xhr.statusText}`));
      };
      xhr.onerror = () => reject(new ApiError("network", "upload failed"));
      xhr.send(file);
    }),
  attachmentUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}`,
  /**
   * A link cannot carry a header, so with a token the file is fetched and handed to the browser
   * as a download; on this machine (no token) the plain link is enough.
   */
  downloadAttachment: async (id: string, name: string): Promise<void> => {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`, { headers: authHeaders(token) });
    if (res.status === 401) authState.markRequired();
    if (!res.ok) throw new ApiError(String(res.status), `${res.status} ${res.statusText}`);
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  },
  /** Controlled-update state left by `cafe update` (v4-2). */
  update: () =>
    call<{ current?: string; lastGood?: string; pending?: string; running?: { version?: string }; log?: Array<{ at: number; action: string; ok: boolean; error?: string }> }>("GET", "/api/update"),
};

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
