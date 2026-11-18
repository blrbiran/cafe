import type { AgentRecord, DaemonRecord, RoutingDecision, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";

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

export const api = {
  snapshot: () => call<Snapshot>("GET", "/api/snapshot"),
  thread: (id: string) => call<ThreadDetail>("GET", `/api/threads/${encodeURIComponent(id)}`),
  /** New question, or a follow-up when `threadId` is set (rejects with `thread_busy` while a turn is open). */
  createOrder: (p: { body: string; to?: string; kind?: "order" | "notice"; threadId?: string }) =>
    call<{ orderId: string; threadId: string; decision: RoutingDecision }>("POST", "/api/orders", { ...p, as: "web" }),
  cancel: (threadId: string) => call<{}>("POST", `/api/threads/${encodeURIComponent(threadId)}/cancel`),
  kick: (agentId: string) => call<{}>("DELETE", `/api/agents/${encodeURIComponent(agentId)}`),
};

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return withToken(`${proto}//${location.host}/ws`);
}
