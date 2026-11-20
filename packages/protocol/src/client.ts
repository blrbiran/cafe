import {
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  Methods,
  PROTOCOL_VERSION,
  type AgentIdentity,
  type AgentRecord,
  type AgentStatus,
  type Attachment,
  type CreateOrderParams,
  type Order,
  type RoutingDecision,
  type ThreadEnvelope,
} from "./index.ts";
import { Peer } from "./peer.ts";

export interface ClientOptions {
  /** `host:port` of the Daemon; defaults to the local one. */
  daemon?: string;
  token?: string;
  /** Reconnect automatically and re-register (long-lived agents). */
  reconnect?: boolean;
  /** cafe release of this client, for the daemon's mismatch message. */
  cafeVersion?: string;
  /** Longest wait between reconnect attempts. Default: 5 s for a Daemon on this machine, 30 s otherwise. */
  reconnectMaxMs?: number;
  log?: (msg: string) => void;
}

/** A local Daemon restarts in seconds (launchd, `cafe daemon start`); do not leave its Agents waiting 30 s. */
export function defaultReconnectMaxMs(daemon: string): number {
  const host = daemon.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ? 5_000 : 30_000;
}

export interface OrderHandle {
  order: Order;
  /** Attachments downloaded to this Host, with the absolute path when available. */
  attachments?: Array<Attachment & { path?: string }>;
  ack(): Promise<void>;
  heartbeat(note?: string): Promise<void>;
  reply(text: string, final?: boolean): Promise<void>;
  /** `unavailable`: declined for an operational reason (timeout, shutdown, crash), not because the topic is not ours. */
  decline(reason: string, opts?: { unavailable?: boolean }): Promise<void>;
}

type Listener<T> = (x: T) => void;

/**
 * Agent-side connection to a Daemon. Registers an identity, receives Orders,
 * and can create Orders as a Customer. Uses the global WebSocket (Node ≥ 22, browsers).
 */
export class CafeClient {
  private opts: Required<Pick<ClientOptions, "daemon" | "reconnect">> & ClientOptions;
  private peer?: Peer;
  private ws?: WebSocket;
  private identity?: AgentIdentity;
  private closedByUser = false;
  private retry = 0;
  private orderListeners = new Set<Listener<OrderHandle>>();
  private cancelListeners = new Set<Listener<{ orderId: string; threadId: string; by: string }>>();
  private eventListeners = new Set<Listener<ThreadEnvelope>>();
  /** Recent events, so a listener attached after a fast thread closed can still read it. */
  private recent: ThreadEnvelope[] = [];
  private connectListeners = new Set<Listener<AgentRecord | undefined>>();
  record?: AgentRecord;

  constructor(opts: ClientOptions = {}) {
    this.opts = { daemon: `127.0.0.1:${DEFAULT_PORT}`, reconnect: false, ...opts };
  }

  get connected(): boolean {
    return !!this.peer && !this.peer.isClosed;
  }

  /** An Order delivered to this Agent was cancelled by its Customer; stop working on it. */
  onCancel(fn: Listener<{ orderId: string; threadId: string; by: string }>): () => void {
    this.cancelListeners.add(fn);
    return () => this.cancelListeners.delete(fn);
  }

  onOrder(fn: Listener<OrderHandle>): () => void {
    this.orderListeners.add(fn);
    return () => this.orderListeners.delete(fn);
  }

  onThreadEvent(fn: Listener<ThreadEnvelope>): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Thread events already seen by this client (newest last), for late subscribers. */
  recentEvents(threadId?: string): ThreadEnvelope[] {
    return (threadId ? this.recent.filter((e) => e.threadId === threadId) : this.recent).slice();
  }

  onConnect(fn: Listener<AgentRecord | undefined>): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  /** Connect and (optionally) register. Resolves once registered. */
  async connect(identity?: AgentIdentity): Promise<AgentRecord | undefined> {
    this.identity = identity;
    this.closedByUser = false;
    return this.open();
  }

  private open(): Promise<AgentRecord | undefined> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.opts.daemon}/ws`);
      this.ws = ws;
      const peer = new Peer(ws);
      let settled = false;
      peer.on(Methods.orderCancelled, (x: { orderId: string; threadId: string; by: string }) => {
        for (const fn of this.cancelListeners) fn(x);
      });
      peer.on(Methods.orderDeliver, ({ order, attachmentPaths }: { order: Order; attachmentPaths?: Record<string, string> }) => {
        const h = this.handle(order, attachmentPaths);
        for (const fn of this.orderListeners) fn(h);
      });
      peer.on(Methods.threadEvent, (env: ThreadEnvelope) => {
        this.recent.push(env);
        if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
        for (const fn of this.eventListeners) fn(env);
      });
      ws.addEventListener("message", (e) => void peer.receive(String(e.data)));
      ws.addEventListener("open", async () => {
        try {
          await peer.request(Methods.initialize, { protocolVersion: PROTOCOL_VERSION, kind: "agent", token: this.opts.token, cafeVersion: this.opts.cafeVersion });
          this.peer = peer;
          this.retry = 0;
          // Keep the same agentId across reconnects so in-flight Orders stay attributable.
          const identity = this.identity ? { ...this.identity, resumeAgentId: this.record?.agentId ?? this.identity.resumeAgentId } : undefined;
          this.record = identity ? await peer.request<AgentRecord>(Methods.agentRegister, identity) : undefined;
          for (const fn of this.connectListeners) fn(this.record);
          settled = true;
          resolve(this.record);
        } catch (err) {
          settled = true;
          reject(err);
          ws.close();
        }
      });
      // Node's WebSocket fires only `error` (no `close`) when the connection attempt
      // fails, so a reconnect chain driven by `close` alone stops after one failure.
      let gone = false;
      const onGone = () => {
        if (gone) return;
        gone = true;
        peer.closed();
        if (this.ws !== ws) return;
        this.peer = undefined;
        if (!settled) {
          settled = true;
          reject(new Error(`cannot connect to cafe daemon at ${this.opts.daemon}`));
        }
        if (this.opts.reconnect && !this.closedByUser) {
          const delay = Math.min(this.opts.reconnectMaxMs ?? defaultReconnectMaxMs(this.opts.daemon), 500 * 2 ** this.retry++);
          setTimeout(() => this.open().catch((e) => this.opts.log?.(`reconnect failed: ${(e as Error).message}`)), delay);
        }
      };
      ws.addEventListener("close", onGone);
      ws.addEventListener("error", () => {
        onGone();
        try {
          ws.close();
        } catch {}
      });
    });
  }

  private handle(order: Order, attachmentPaths?: Record<string, string>): OrderHandle {
    const base = { orderId: order.orderId, threadId: order.threadId };
    return {
      order,
      ...(order.attachments?.length
        ? { attachments: order.attachments.map((a) => ({ ...a, ...(attachmentPaths?.[a.id] ? { path: attachmentPaths[a.id] } : {}) })) }
        : {}),
      ack: () => this.req(Methods.orderAck, base),
      heartbeat: (note) => this.req(Methods.orderHeartbeat, { ...base, note }),
      reply: (text, final = true) => this.req(Methods.orderReply, { ...base, text, final }),
      decline: (reason, opts) => this.req(Methods.orderDecline, { ...base, reason, ...(opts?.unavailable ? { unavailable: true } : {}) }),
    };
  }

  private async req(method: string, params: unknown): Promise<void> {
    if (!this.peer) throw new Error("not connected to cafe daemon");
    await this.peer.request(method, params);
  }

  async setStatus(status: AgentStatus): Promise<void> {
    if (this.peer && this.record) await this.peer.request(Methods.agentStatus, { status });
  }

  /**
   * External session id stored by this Agent's Daemon for a cafe Thread (bridged Codex / Claude Baristas).
   * Keyed by `kind`, this Agent's directory and the Thread, so any slot of the same Barista can resume it.
   */
  async getSession(threadId: string, kind: string): Promise<string | undefined> {
    if (!this.peer) throw new Error("not connected to cafe daemon");
    const r = await this.peer.request<{ sessionId?: string }>(Methods.agentSessionGet, { threadId, kind });
    return r.sessionId;
  }

  async setSession(threadId: string, kind: string, sessionId: string): Promise<void> {
    await this.req(Methods.agentSessionSet, { threadId, kind, sessionId });
  }

  async agents(): Promise<AgentRecord[]> {
    if (!this.peer) throw new Error("not connected to cafe daemon");
    return this.peer.request(Methods.agentsList, {});
  }

  /** Create an Order as a Customer; Thread events arrive via onThreadEvent. */
  async ask(params: Partial<CreateOrderParams> & { body: string }): Promise<{ orderId: string; threadId: string; decision: RoutingDecision }> {
    if (!this.peer) throw new Error("not connected to cafe daemon");
    return this.peer.request(Methods.orderCreate, { kind: "order", ...params }, 120_000);
  }

  async cancel(threadId: string): Promise<void> {
    await this.req(Methods.orderCancel, { threadId });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.peer?.closed();
    this.peer = undefined;
  }
}

/** Keep an Order alive while long work runs: sends a heartbeat every interval until stopped. */
export function keepAlive(h: OrderHandle, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  const t = setInterval(() => void h.heartbeat().catch(() => {}), intervalMs);
  return () => clearInterval(t);
}
