import type { ThreadEnvelope } from "@cafe/protocol";

export interface CafeHttpClientOptions {
  /** `host:port` (or `http(s)://host:port`); defaults to CAFE_DAEMON or 127.0.0.1:4777. */
  daemon?: string;
  token?: string;
}

export interface SendOrderOptions {
  body: string;
  /** Continue an existing cafe Thread (a follow-up). */
  threadId?: string;
  /** Platform event id; the Daemon returns the first Order for a repeated key. */
  idempotencyKey?: string;
  origin?: "human" | "agent";
  via?: { id?: string; address: string; name?: string };
  as?: string;
  /** Uploaded metadata (`uploadAttachment`) to carry on the Order. Contents never go on the wire. */
  attachments?: Array<Record<string, unknown>>;
}

export interface CreatedOrder {
  orderId: string;
  threadId: string;
  decision: { mode: string; reason: string; targets: string[] };
}

export interface ThreadResponse {
  meta: { threadId: string; status: string; turns: number; [key: string]: unknown };
  events: ThreadEnvelope[];
}

export interface StreamOptions {
  /** Stop when this Order closes (default: the latest Order in the Thread). */
  orderId?: string;
  signal?: AbortSignal;
}

function errorFrom(status: number, body: unknown): Error {
  const b = (body ?? {}) as { error?: string; message?: string };
  const code = b.error ?? String(status);
  return new Error(b.message ? `${code}: ${b.message}` : code);
}

/**
 * Thin HTTP/SSE view of a cafe Daemon. A connector uses it to send Orders,
 * read Threads and follow replies; it deliberately does not hide the wire.
 */
export class CafeHttpClient {
  readonly base: string;
  private token?: string;

  constructor(opts: CafeHttpClientOptions = {}) {
    const daemon = opts.daemon ?? process.env.CAFE_DAEMON ?? "127.0.0.1:4777";
    this.base = /^https?:\/\//.test(daemon) ? daemon.replace(/\/+$/, "") : `http://${daemon}`;
    this.token = opts.token ?? process.env.CAFE_TOKEN;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers(init.headers as Record<string, string>) });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    if (!res.ok) throw errorFrom(res.status, body);
    return body as T;
  }

  /** Create an Order as an Agent relaying a platform message. */
  sendOrder(o: SendOrderOptions): Promise<CreatedOrder> {
    return this.request<CreatedOrder>("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        body: o.body,
        kind: "order",
        origin: o.origin ?? "agent",
        ...(o.threadId ? { threadId: o.threadId } : {}),
        ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}),
        ...(o.via ? { via: o.via } : {}),
        ...(o.as ? { as: o.as } : {}),
        ...(o.attachments?.length ? { attachments: o.attachments } : {}),
      }),
    });
  }

  /**
   * Upload one file to the Daemon's staging area; the returned metadata goes on an Order or reply.
   * A connector downloads from its platform and hands the bytes here — the Daemon owns validation.
   */
  async uploadAttachment(file: { bytes: Uint8Array; name: string; mime: string }): Promise<Record<string, unknown>> {
    const q = `?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.mime)}`;
    const res = await fetch(`${this.base}/api/artifacts${q}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/octet-stream" }),
      body: Buffer.from(file.bytes),
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    if (!res.ok) throw errorFrom(res.status, body);
    const attachment = (body as { attachment?: Record<string, unknown> }).attachment;
    if (!attachment) throw new Error(`upload of ${file.name} returned no attachment`);
    return attachment;
  }

  getThread(threadId: string): Promise<ThreadResponse> {
    return this.request<ThreadResponse>(`/api/threads/${encodeURIComponent(threadId)}`);
  }

  /** Follow a Thread over SSE until the server closes the stream (the Order closed). */
  async *streamThread(threadId: string, opts: StreamOptions = {}): AsyncGenerator<ThreadEnvelope> {
    const query = opts.orderId ? `?orderId=${encodeURIComponent(opts.orderId)}` : "";
    const res = await fetch(`${this.base}/api/threads/${encodeURIComponent(threadId)}/stream${query}`, {
      headers: this.headers({ accept: "text/event-stream", "content-type": "text/plain" }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { message: text };
      }
      throw errorFrom(res.status, body);
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        yield JSON.parse(data.slice(6)) as ThreadEnvelope;
      }
    }
  }
}