import type { Frame, Response } from "./index.ts";
import { isNotification, isRequest, isResponse } from "./index.ts";

/** Minimal socket surface shared by `ws` (Node) and browser WebSocket adapters. */
export interface FrameSocket {
  send(data: string): void;
  close(): void;
}

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Handler = (params: any, peer: Peer) => unknown | Promise<unknown>;

/**
 * Symmetric request/response/notification endpoint over one socket.
 * Feed inbound text frames to `receive()`; call `closed()` when the socket closes.
 */
export class Peer {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, Handler>();
  private fallback?: (method: string, params: any, peer: Peer) => unknown | Promise<unknown>;
  /** Free-form slot for connection state (kind, agentId, host...). */
  meta: Record<string, any> = {};
  isClosed = false;
  private socket: FrameSocket;

  constructor(socket: FrameSocket) {
    this.socket = socket;
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  onAny(handler: (method: string, params: any, peer: Peer) => unknown | Promise<unknown>): this {
    this.fallback = handler;
    return this;
  }

  request<R = any>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<R> {
    if (this.isClosed) return Promise.reject(new RpcError("closed", "connection closed"));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.isClosed) return;
    this.write({ method, params });
  }

  async receive(raw: string): Promise<void> {
    let frame: Frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (isResponse(frame)) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (p.timer) clearTimeout(p.timer);
      if ("error" in frame) p.reject(new RpcError(frame.error.code, frame.error.message));
      else p.resolve(frame.result);
      return;
    }
    const handler = this.handlers.get(frame.method);
    const run = handler ? () => handler(frame.params, this) : this.fallback ? () => this.fallback!(frame.method, frame.params, this) : undefined;
    if (isRequest(frame)) {
      if (!run) return this.respond({ id: frame.id, error: { code: "unknown_method", message: frame.method } });
      try {
        const result = await run();
        this.respond({ id: frame.id, result: result ?? null });
      } catch (err) {
        const e = err as Error & { code?: string };
        this.respond({ id: frame.id, error: { code: e.code ?? "error", message: e.message } });
      }
    } else if (isNotification(frame) && run) {
      try {
        await run();
      } catch {
        // notifications have no reply channel
      }
    }
  }

  closed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError("closed", "connection closed"));
    }
    this.pending.clear();
  }

  close(): void {
    this.socket.close();
    this.closed();
  }

  private respond(r: Response): void {
    if (!this.isClosed) this.write(r);
  }

  private write(f: Frame): void {
    try {
      this.socket.send(JSON.stringify(f));
    } catch {
      this.closed();
    }
  }
}
