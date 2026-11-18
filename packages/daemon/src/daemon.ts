import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import { ulid } from "ulid";
import WebSocket from "ws";
import {
  ACK_TIMEOUT_MS,
  AgentIdentity,
  BROADCAST_DEADLINE_MS,
  CreateOrderParams,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES,
  InitializeParams,
  MAX_ORDER_DEPTH,
  Methods,
  PROTOCOL_VERSION,
  RegistryDelta,
  formatAddress,
  type AgentRecord,
  type AgentStatus,
  type DaemonRecord,
  type Order,
  type Party,
  type RoutingDecision,
  type RoutingHint,
  type ThreadEnvelope,
  type ThreadEventBody,
  type ThreadMeta,
} from "@cafe/protocol";
import { Peer, RpcError } from "@cafe/protocol/peer";
import { type CafeConfig, saveConfig } from "./config.ts";
import { HINT_WINDOW_MS, computeHints, identityOf, orderKeywords } from "./hints.ts";
import { Registry } from "./registry.ts";
import { LlmRouter, RulesRouter, piComplete, type Router } from "./router.ts";
import { Store } from "./store.ts";

export interface DaemonOptions {
  config: CafeConfig;
  home: string;
  /** Override the router (tests inject a fake LLM). */
  router?: Router;
  /** Override the timing constants (tests). */
  timing?: Partial<Timing>;
  log?: (msg: string) => void;
}

export interface Timing {
  ackTimeoutMs: number;
  heartbeatIntervalMs: number;
  broadcastDeadlineMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Root: how often to recompute and push routing hints when there are new outcomes. */
  hintsIntervalMs: number;
  /** Direct links (Root offline): give up connecting to another Daemon after this long. */
  linkConnectTimeoutMs: number;
  /** Direct links: close an outgoing link after this long without traffic. */
  linkIdleMs: number;
}

/** Recompute hints at least this often even without new outcomes, so time decay shows. */
const HINTS_MAX_AGE_MS = 3600_000;

/** Live delivery state of one Order on its origin Daemon. */
interface Tracking {
  order: Order;
  status: "open" | "done" | "failed" | "cancelled";
  /** Any final reply received for this Order. */
  replied: boolean;
  decision?: RoutingDecision;
  /** per-target state */
  targets: Map<string, "pending" | "acked" | "done" | "failed">;
  candidates: string[];
  timers: Map<string, ReturnType<typeof setTimeout>>;
  deadline?: ReturnType<typeof setTimeout>;
}

type DaemonEvents = {
  thread: [ThreadEnvelope, ThreadMeta | undefined];
  registry: [RegistryDelta];
  daemons: [DaemonRecord[]];
};

/**
 * One Daemon per Host. With `config.mode === "root"` it is also the Root Daemon:
 * it owns the authoritative Registry and relays every Order (ADR-0001, ADR-0002).
 */
export class Daemon extends EventEmitter<DaemonEvents> {
  readonly config: CafeConfig;
  readonly store: Store;
  readonly registry = new Registry();
  readonly isRoot: boolean;
  /** Headless Barista process supervisor (set by runDaemon). */
  supervisor?: import("./supervisor.ts").Supervisor;
  readonly host: string;
  private router: Router;
  private timing: Timing;
  readonly log: (msg: string) => void;

  /** Local Agent connections by agentId. */
  private agents = new Map<string, Peer>();
  /** Customer subscriptions: threadId → peers wanting thread/event. */
  private subscribers = new Map<string, Set<Peer>>();
  /** Orders originated here. */
  private tracking = new Map<string, Tracking>();
  /** Thread metadata cache for threads seen here (origin or relay). */
  private metas = new Map<string, ThreadMeta>();
  private uis = new Set<Peer>();
  /** Orders seen here (origin or relayed), for parent/chain lookup. */
  private knownOrders = new Map<string, Order>();
  /** Agents registered on this Host (authoritative local set, survives Registry snapshots). */
  private local = new Map<string, AgentRecord>();

  /** Root side: connected child Daemons by host. */
  private children = new Map<string, Peer>();
  private daemonRecords = new Map<string, DaemonRecord>();
  /** Child side: uplink to the Root. */
  private uplink?: Peer;
  private uplinkSocket?: WebSocket;
  private reconnectDelay = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private rootHost?: string;

  /** Routing hints computed from this Daemon's own outcomes (agent_events). */
  private localHints: Record<string, RoutingHint> = {};
  private localHintsAt = 0;
  private hintsDirty = true;
  /** Child side: the network-wide hints last pushed by the Root. */
  private rootHints?: Record<string, RoutingHint>;
  private pushedHints = "";
  private hintsTimer?: ReturnType<typeof setInterval>;

  // Direct links between Daemons, used only while the Root is offline (ADR-0004).
  /** host → ws URL of other Daemons, learned from the Root and kept across restarts. */
  private peerUrls = new Map<string, string>();
  /** Outgoing direct links by host. */
  private links = new Map<string, { peer: Peer; ws: WebSocket; lastUsed: number }>();
  private linking = new Map<string, Promise<Peer>>();
  /** Direct links taking part in each Thread (both directions). */
  private threadLinks = new Map<string, Set<Peer>>();
  /** Threads that went direct while the Root was offline; sent to the Root when it is back. */
  private backfill = new Set<string>();
  private linkSweep?: ReturnType<typeof setInterval>;

  constructor(opts: DaemonOptions) {
    super();
    this.config = opts.config;
    this.isRoot = opts.config.mode === "root";
    this.host = opts.config.host;
    this.store = new Store(opts.home);
    this.log = opts.log ?? ((m) => console.error(`[cafe ${this.host}] ${m}`));
    this.timing = {
      ackTimeoutMs: ACK_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      broadcastDeadlineMs: BROADCAST_DEADLINE_MS,
      reconnectMinMs: 500,
      reconnectMaxMs: 30_000,
      hintsIntervalMs: 30_000,
      linkConnectTimeoutMs: 3000,
      linkIdleMs: 5 * 60_000,
      ...opts.timing,
    };
    this.router = opts.router ?? new RulesRouter();
    this.registry.on("delta", (d) => {
      this.emit("registry", d);
      this.store.saveRegistry(this.registry.version, this.registry.all());
      for (const ui of this.uis) ui.notify(Methods.registryDelta, d);
    });
    // Replica restored from disk; the Root will resync on connect.
    const cached = this.store.loadRegistry();
    if (!this.isRoot && cached.records.length) this.registry.applySnapshot(cached.version, cached.records.filter((r) => r.host !== this.host));
    this.daemonRecords.set(this.host, { host: this.host, url: this.url(), isRoot: this.isRoot, online: true, connectedAt: Date.now(), lastSeenAt: Date.now() });
    if (this.isRoot) {
      this.hintsTimer = setInterval(() => this.pushHints(), this.timing.hintsIntervalMs);
      this.hintsTimer.unref?.();
    } else {
      for (const [h, u] of Object.entries(this.store.getKv<Record<string, string>>("peerUrls") ?? {})) this.peerUrls.set(h, u);
      for (const id of this.store.getKv<string[]>("backfill") ?? []) this.backfill.add(id);
      this.linkSweep = setInterval(() => this.sweepLinks(), Math.min(this.timing.linkIdleMs, 60_000));
      this.linkSweep.unref?.();
    }
  }

  /** Initialise the LLM router if configured. Separate from the constructor because it is async. */
  async initRouter(): Promise<void> {
    const model = this.config.router.model;
    if (!model || this.router.name !== "rules") return;
    try {
      this.router = new LlmRouter(await piComplete(model));
      this.log(`router: llm (${model})`);
    } catch (err) {
      this.log(`router: llm unavailable (${(err as Error).message}); using rules`);
    }
  }

  url(): string {
    return `ws://${this.config.advertise ?? lanAddress()}:${this.config.port}`;
  }

  get rootOnline(): boolean {
    return this.isRoot || (this.uplink !== undefined && !this.uplink.isClosed);
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** Attach a freshly accepted socket. `local` = loopback (no token required). */
  accept(ws: WebSocket, local: boolean): void {
    const peer = new Peer(ws);
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("close", () => {
      peer.closed();
      this.onPeerClosed(peer);
    });
    ws.on("error", () => ws.close());
    peer.on(Methods.initialize, (raw) => {
      const p = InitializeParams.parse(raw);
      if (!local && p.token !== this.config.token) throw new RpcError("unauthorized", "bad token");
      peer.meta.kind = p.kind;
      if (p.kind === "daemon") return this.onChildDaemon(peer, p);
      if (p.kind === "peer") {
        peer.meta.host = p.host;
        if (p.host && p.url && !this.isRoot) this.learnPeers([{ host: p.host, url: p.url }]);
        this.bindLink(peer);
        return { protocolVersion: PROTOCOL_VERSION, host: this.host, isRoot: this.isRoot };
      }
      if (p.kind === "ui") this.uis.add(peer);
      return { protocolVersion: PROTOCOL_VERSION, host: this.host, isRoot: this.isRoot };
    });
    this.bindAgentMethods(peer);
  }

  private onPeerClosed(peer: Peer): void {
    this.uis.delete(peer);
    if (peer.meta.kind === "peer") this.dropLink(peer);
    for (const subs of this.subscribers.values()) subs.delete(peer);
    // A Root shutting down does not mark its children's Agents offline: they may keep working over direct links.
    if (peer.meta.kind === "daemon" && peer.meta.host && !this.stopped) {
      const host = peer.meta.host as string;
      if (this.children.get(host) === peer) {
        this.children.delete(host);
        const rec = this.daemonRecords.get(host);
        if (rec) rec.online = false;
        // Agents behind a disconnected Daemon go offline in the Registry.
        const offline = this.registry.all().filter((r) => r.host === host).map((r) => ({ ...r, status: "offline" as const }));
        if (offline.length) this.broadcastDelta(this.registry.upsert(offline));
        this.emitDaemons();
        this.log(`daemon ${host} disconnected`);
      }
    }
    const agentId = peer.meta.agentId as string | undefined;
    if (agentId && this.agents.get(agentId) === peer) {
      this.agents.delete(agentId);
      this.local.delete(agentId);
      this.unregister(agentId);
      // Fail anything that agent was working on.
      for (const t of this.tracking.values()) {
        const s = t.targets.get(agentId);
        if (s === "pending" || s === "acked") this.targetFailed(t, agentId, "agent disconnected");
      }
    }
  }

  private bindAgentMethods(peer: Peer): void {
    peer.on(Methods.agentRegister, (raw) => {
      const { resumeAgentId, ...identity } = AgentIdentity.parse(raw);
      // Resume a previous identity (reconnect, daemon restart) when it is not held by a live connection.
      const prev = resumeAgentId && !this.agents.has(resumeAgentId) ? (this.local.get(resumeAgentId) ?? this.registry.get(resumeAgentId)) : undefined;
      const resumable = prev && prev.host === this.host && prev.name === identity.name ? prev : undefined;
      const now = Date.now();
      const record: AgentRecord = {
        ...identity,
        agentId: resumable?.agentId ?? resumeAgentId ?? ulid(),
        address: resumable?.address ?? formatAddress(identity.name, this.registry.nextInstance(identity.name, this.host), this.host),
        host: this.host,
        status: "idle",
        registeredAt: now,
        lastSeenAt: now,
      };
      peer.meta.agentId = record.agentId;
      peer.meta.party = { id: record.agentId, address: record.address, host: this.host } satisfies Party;
      this.agents.set(record.agentId, peer);
      this.local.set(record.agentId, record);
      this.publishAgents([record]);
      this.log(`registered ${record.address} (${identity.mode}, ${identity.role})`);
      return record;
    });
    peer.on(Methods.agentStatus, (raw: { status: AgentStatus }) => {
      const rec = peer.meta.agentId ? this.local.get(peer.meta.agentId) : undefined;
      if (rec && rec.status !== raw.status) {
        const next = { ...rec, status: raw.status, lastSeenAt: Date.now() };
        this.local.set(rec.agentId, next);
        this.publishAgents([next]);
      }
      return {};
    });
    peer.on(Methods.agentsList, () => this.registry.all());
    peer.on(Methods.orderCreate, (raw) => this.createOrder(CreateOrderParams.parse(raw), peer));
    peer.on(Methods.orderAck, (p: { orderId: string; threadId: string }) => this.agentEvent(peer, p, { type: "order.acked", agentId: peer.meta.agentId }));
    peer.on(Methods.orderHeartbeat, (p: { orderId: string; threadId: string; note?: string }) =>
      this.agentEvent(peer, p, { type: "order.heartbeat", agentId: peer.meta.agentId, note: p.note }),
    );
    peer.on(Methods.orderReply, (p: { orderId: string; threadId: string; text: string; final?: boolean }) =>
      this.agentEvent(peer, p, { type: "order.replied", agentId: peer.meta.agentId, text: p.text, final: p.final ?? true }),
    );
    peer.on(Methods.orderDecline, (p: { orderId: string; threadId: string; reason: string; unavailable?: boolean }) =>
      this.agentEvent(peer, p, { type: "order.declined", agentId: peer.meta.agentId, reason: p.reason, ...(p.unavailable ? { unavailable: true } : {}) }),
    );
    peer.on(Methods.orderCancel, (p: { threadId: string }) => this.cancel(p.threadId, peer.meta.party?.address ?? "customer"));
    peer.on("thread/subscribe", (p: { threadId: string }) => {
      this.subscribe(p.threadId, peer);
      return {};
    });
  }

  private agentEvent(peer: Peer, p: { orderId: string; threadId: string }, event: ThreadEventBody): {} {
    if (!peer.meta.agentId) throw new RpcError("not_registered", "agent/register first");
    this.recordEvent({ eventId: ulid(), threadId: p.threadId, orderId: p.orderId, host: this.host, at: Date.now(), event });
    return {};
  }

  subscribe(threadId: string, peer: Peer): void {
    let s = this.subscribers.get(threadId);
    if (!s) this.subscribers.set(threadId, (s = new Set()));
    s.add(peer);
  }

  // -------------------------------------------------------------------------
  // Registry publication
  // -------------------------------------------------------------------------

  private publishAgents(records: AgentRecord[]): void {
    if (this.isRoot) this.broadcastDelta(this.registry.upsert(records));
    else if (this.rootOnline) this.uplink!.notify(Methods.registryUpsert, { records });
    else this.registry.upsert(records); // Root down: keep a local view; resynced on reconnect.
  }

  private unregister(agentId: string): void {
    if (this.isRoot) this.broadcastDelta(this.registry.remove([agentId]));
    else if (this.rootOnline) this.uplink!.notify(Methods.registryRemove, { agentIds: [agentId] });
    else this.registry.remove([agentId]);
  }

  private broadcastDelta(delta: RegistryDelta): void {
    for (const child of this.children.values()) child.notify(Methods.registryDelta, delta);
  }

  // -------------------------------------------------------------------------
  // Orders (origin side)
  // -------------------------------------------------------------------------

  async createOrder(p: CreateOrderParams, peer?: Peer): Promise<{ orderId: string; threadId: string; decision: RoutingDecision }> {
    const from: Party = peer?.meta.party ?? { id: `cli:${ulid()}`, address: `${p.as ?? "cli"}@${this.host}`, host: this.host };
    const parent = p.parentOrderId ? this.knownOrders.get(p.parentOrderId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_ORDER_DEPTH) throw new RpcError("too_deep", `order depth ${depth} exceeds ${MAX_ORDER_DEPTH}`);

    // Follow-up: continue an existing Thread.
    let prior: ThreadMeta | undefined;
    if (p.threadId) {
      prior = this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
      if (!prior) throw new RpcError("not_found", `unknown thread ${p.threadId}`);
      if ([...this.tracking.values()].some((x) => x.order.threadId === p.threadId && x.status === "open")) {
        throw new RpcError("thread_busy", "the previous question in this thread is still open; wait or cancel it first");
      }
    }
    const order: Order = {
      orderId: ulid(),
      threadId: prior?.threadId ?? ulid(),
      kind: p.kind,
      from,
      to: p.to,
      body: p.body,
      parentOrderId: p.parentOrderId,
      chain: [...(parent?.chain ?? []), ...(parent ? [parent.from.id] : [])],
      depth,
      deadlineMs: p.deadlineMs,
      createdAt: Date.now(),
      turn: prior ? prior.turns + 1 : 1,
      history: prior ? this.history(prior) : [],
    };
    this.knownOrders.set(order.orderId, order);
    if (peer) this.subscribe(order.threadId, peer);

    // Capture who answered before the new turn resets the Thread's reply list.
    const answeredBefore = prior ? [...new Set(prior.replies.map((r) => r.agentId))] : [];
    const t: Tracking = { order, status: "open", replied: false, targets: new Map(), candidates: [], timers: new Map() };
    this.tracking.set(order.orderId, t);
    this.emitEvent(order, { type: "order.created", order });

    const decision = await this.route(order, answeredBefore);
    t.decision = decision;
    t.candidates = [...decision.candidates];
    this.emitEvent(order, { type: "order.routed", decision });
    if (decision.targets.length === 0) {
      this.emitEvent(order, { type: "order.failed", reason: "no barista available" });
      this.close(t, "failed");
      return { orderId: order.orderId, threadId: order.threadId, decision };
    }
    for (const id of decision.targets) this.dispatch(t, id);
    if (decision.mode !== "unicast" || order.kind === "notice") {
      t.deadline = setTimeout(() => this.finishOnDeadline(t), order.deadlineMs ?? this.timing.broadcastDeadlineMs);
    }
    return { orderId: order.orderId, threadId: order.threadId, decision };
  }

  private eligible(order: Order): AgentRecord[] {
    const excluded = new Set([order.from.id, ...order.chain]);
    return this.registry
      .all()
      .filter((r) => r.role === "barista" && r.status !== "offline" && !excluded.has(r.agentId))
      .filter((r) => this.rootOnline || r.host === this.host || this.peerUrls.has(r.host));
  }

  /** Earlier turns of a Thread, oldest first, bounded for prompt size. */
  private history(meta: ThreadMeta): Order["history"] {
    const out: Order["history"] = [];
    for (const env of this.store.readEvents(meta.file)) {
      const ev = env.event;
      if (ev.type === "order.created") out.push({ from: ev.order.from.address, role: "customer", text: ev.order.body.slice(0, 4000) });
      else if (ev.type === "order.replied" && ev.final) out.push({ from: this.registry.get(ev.agentId)?.address ?? ev.agentId, role: "barista", text: ev.text.slice(0, 4000) });
    }
    return out.slice(-12);
  }

  private async route(order: Order, answeredBefore: string[] = []): Promise<RoutingDecision> {
    const candidates = this.eligible(order);
    if (answeredBefore.length && !order.to) {
      const answered = answeredBefore.filter((id) => candidates.some((c) => c.agentId === id));
      if (answered.length) {
        return {
          targets: answered,
          mode: answered.length === 1 ? "unicast" : "multicast",
          reason: `follow-up to ${answered.map((id) => this.registry.get(id)?.address ?? id).join(", ")}, who answered earlier in this thread`,
          router: "followup",
          candidates: [],
        };
      }
    }
    if (order.to) {
      const ids = this.registry.resolve(order.to).filter((id) => candidates.some((c) => c.agentId === id));
      return {
        targets: ids,
        mode: ids.length === 1 ? "unicast" : "multicast",
        reason: ids.length ? `explicit address ${order.to}` : `no online barista at ${order.to}`,
        router: "explicit",
        candidates: [],
      };
    }
    if (this.router.name === "rules" && this.config.router.fallback === "root" && !this.isRoot && this.rootOnline) {
      try {
        return await this.uplink!.request<RoutingDecision>(Methods.routeDecide, { order, candidates: candidates.map((c) => c.agentId) }, 60_000);
      } catch (err) {
        this.log(`root route/decide failed: ${(err as Error).message}`);
      }
    }
    return this.router.decide({ order, candidates, hints: this.hintsFor(candidates) });
  }

  private dispatch(t: Tracking, agentId: string): void {
    t.targets.set(agentId, "pending");
    const rec = this.registry.get(agentId);
    if (!rec) return this.targetFailed(t, agentId, "unknown agent");
    if (t.order.kind === "order") this.armAck(t, agentId);
    this.deliver(t.order, agentId);
  }

  /** Send an Order towards an Agent: via the Root when it is online (ADR-0001), else locally or directly (ADR-0004). */
  private deliver(order: Order, agentId: string): void {
    const rec = this.registry.get(agentId);
    if (!rec) return;
    if (this.isRoot) {
      if (rec.host === this.host) return this.deliverLocal(order, agentId);
      const child = this.children.get(rec.host);
      if (!child) return this.relayFailure(order, agentId, `daemon ${rec.host} offline`);
      child.notify(Methods.orderRelay, { order, agentId });
      return;
    }
    if (this.rootOnline) {
      this.uplink!.notify(Methods.orderRelay, { order, agentId });
      return;
    }
    if (rec.host === this.host) return this.deliverLocal(order, agentId);
    if (this.peerUrls.has(rec.host)) return void this.deliverDirect(order, agentId, rec.host);
    this.relayFailure(order, agentId, "root_unreachable");
  }

  // -------------------------------------------------------------------------
  // Direct links (Root offline only, ADR-0004)
  // -------------------------------------------------------------------------

  private async deliverDirect(order: Order, agentId: string, host: string): Promise<void> {
    try {
      const link = await this.link(host);
      this.joinThread(order.threadId, link);
      this.markBackfill(order.threadId);
      link.notify(Methods.orderRelay, { order, agentId });
    } catch (err) {
      this.log(`direct link to ${host} failed: ${(err as Error).message}`);
      this.relayFailure(order, agentId, "root_unreachable");
    }
  }

  /** An open outgoing link to `host`, connecting on demand. */
  private link(host: string): Promise<Peer> {
    const cur = this.links.get(host);
    if (cur && !cur.peer.isClosed) {
      cur.lastUsed = Date.now();
      return Promise.resolve(cur.peer);
    }
    const pending = this.linking.get(host);
    if (pending) return pending;
    const url = this.peerUrls.get(host);
    if (!url) return Promise.reject(new Error(`no address for ${host}`));
    const attempt = new Promise<Peer>((resolve, reject) => {
      const ws = new WebSocket(`${url}/ws`);
      const peer = new Peer(ws);
      peer.meta.kind = "peer";
      peer.meta.host = host;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("connect timeout"));
      }, this.timing.linkConnectTimeoutMs);
      this.bindLink(peer);
      ws.on("message", (data) => void peer.receive(data.toString()));
      ws.on("error", () => {});
      ws.on("close", () => {
        clearTimeout(timer);
        peer.closed();
        this.dropLink(peer);
        if (this.links.get(host)?.peer === peer) this.links.delete(host);
        reject(new Error("connection closed"));
      });
      ws.on("open", async () => {
        try {
          await peer.request(Methods.initialize, { protocolVersion: PROTOCOL_VERSION, kind: "peer", token: this.config.token, host: this.host, url: this.url() });
          clearTimeout(timer);
          this.links.set(host, { peer, ws, lastUsed: Date.now() });
          this.log(`direct link to ${host} open`);
          resolve(peer);
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err as Error);
        }
      });
    }).finally(() => this.linking.delete(host));
    this.linking.set(host, attempt);
    return attempt;
  }

  /** Handlers shared by both ends of a direct link. */
  private bindLink(peer: Peer): void {
    peer.on(Methods.orderRelay, (x: { order: Order; agentId: string }) => {
      this.joinThread(x.order.threadId, peer);
      this.adoptOrder(x.order);
      this.deliverLocal(x.order, x.agentId);
    });
    peer.on(Methods.threadEvent, (env: ThreadEnvelope) => {
      this.touchLink(peer);
      this.recordEvent(env, { from: peer });
    });
  }

  private joinThread(threadId: string, peer: Peer): void {
    let set = this.threadLinks.get(threadId);
    if (!set) this.threadLinks.set(threadId, (set = new Set()));
    set.add(peer);
  }

  private dropLink(peer: Peer): void {
    for (const [id, set] of this.threadLinks) {
      set.delete(peer);
      if (set.size === 0) this.threadLinks.delete(id);
    }
  }

  private touchLink(peer: Peer): void {
    const host = peer.meta.host as string | undefined;
    const cur = host ? this.links.get(host) : undefined;
    if (cur?.peer === peer) cur.lastUsed = Date.now();
  }

  private sweepLinks(): void {
    const now = Date.now();
    for (const [host, l] of this.links) {
      if (now - l.lastUsed < this.timing.linkIdleMs) continue;
      this.links.delete(host);
      l.ws.close();
    }
  }

  private learnPeers(list: { host: string; url: string }[]): void {
    let changed = false;
    for (const d of list) {
      if (d.host === this.host || !d.url || this.peerUrls.get(d.host) === d.url) continue;
      this.peerUrls.set(d.host, d.url);
      changed = true;
    }
    if (changed) this.store.setKv("peerUrls", Object.fromEntries(this.peerUrls));
  }

  private markBackfill(threadId: string): void {
    if (this.rootOnline || this.backfill.has(threadId)) return;
    this.backfill.add(threadId);
    this.store.setKv("backfill", [...this.backfill]);
  }

  /** After reconnecting: give the Root the Threads it missed while we went direct. */
  private async flushBackfill(): Promise<void> {
    for (const id of [...this.backfill]) {
      if (!this.rootOnline) return;
      const meta = this.metas.get(id) ?? this.store.getThread(id);
      try {
        if (meta) await this.uplink!.request(Methods.threadBackfill, { events: this.store.readEvents(meta.file) }, 30_000);
        this.backfill.delete(id);
        this.store.setKv("backfill", [...this.backfill]);
      } catch (err) {
        this.log(`backfill of ${id} failed: ${(err as Error).message}`);
        return;
      }
    }
  }

  private deliverLocal(order: Order, agentId: string): void {
    const peer = this.agents.get(agentId);
    if (!peer) return this.relayFailure(order, agentId, "agent not connected");
    peer.notify(Methods.orderDeliver, { order });
    this.emitEvent(order, { type: "order.delivered", agentId });
  }

  private relayFailure(order: Order, agentId: string, reason: string): void {
    this.emitEvent(order, { type: "order.failed", agentId, reason });
  }

  private armAck(t: Tracking, agentId: string): void {
    this.clearTimer(t, agentId);
    t.timers.set(agentId, setTimeout(() => this.targetFailed(t, agentId, "no ack"), this.timing.ackTimeoutMs));
  }

  private armHeartbeat(t: Tracking, agentId: string): void {
    this.clearTimer(t, agentId);
    t.timers.set(
      agentId,
      setTimeout(() => this.targetFailed(t, agentId, "lost (missed heartbeats)"), this.timing.heartbeatIntervalMs * HEARTBEAT_MISSES),
    );
  }

  private clearTimer(t: Tracking, agentId: string): void {
    const timer = t.timers.get(agentId);
    if (timer) clearTimeout(timer);
    t.timers.delete(agentId);
  }

  private targetFailed(t: Tracking, agentId: string, reason: string, emit = true): void {
    if (t.status !== "open") return;
    const state = t.targets.get(agentId);
    if (state === "done" || state === "failed") return;
    this.clearTimer(t, agentId);
    t.targets.set(agentId, "failed");
    if (emit) this.emitEvent(t.order, { type: "order.failed", agentId, reason }, { skipTrack: true });
    // Unicast: try the next candidate.
    if (t.decision?.mode === "unicast") {
      const next = t.candidates.shift();
      if (next) return this.dispatch(t, next);
    }
    this.maybeClose(t);
  }

  /** Apply an event to origin tracking. */
  private track(env: ThreadEnvelope): void {
    const t = this.tracking.get(env.orderId);
    if (!t) return;
    const ev = env.event;
    switch (ev.type) {
      case "order.acked":
        if (t.targets.get(ev.agentId) === "pending") t.targets.set(ev.agentId, "acked");
        this.armHeartbeat(t, ev.agentId);
        break;
      case "order.heartbeat":
        if (t.targets.get(ev.agentId) === "acked") this.armHeartbeat(t, ev.agentId);
        break;
      case "order.replied":
        if (ev.final) {
          t.replied = true;
          this.clearTimer(t, ev.agentId);
          t.targets.set(ev.agentId, "done");
          this.maybeClose(t);
        } else this.armHeartbeat(t, ev.agentId);
        break;
      case "order.declined":
        this.clearTimer(t, ev.agentId);
        t.targets.set(ev.agentId, "done");
        if (t.decision?.mode === "unicast" && !this.hasReply(t)) {
          const next = t.candidates.shift();
          if (next) {
            this.dispatch(t, next);
            break;
          }
        }
        this.maybeClose(t);
        break;
      case "order.failed":
        if (ev.agentId) this.targetFailed(t, ev.agentId, ev.reason, false);
        break;
    }
  }

  private maybeClose(t: Tracking): void {
    if (t.order.kind === "notice") return; // closed by deadline
    const states = [...t.targets.values()];
    if (states.some((s) => s === "pending" || s === "acked")) return;
    const anyReply = this.hasReply(t);
    this.close(t, anyReply ? "done" : "failed");
  }

  private hasReply(t: Tracking): boolean {
    return t.replied;
  }

  private finishOnDeadline(t: Tracking): void {
    if (t.status !== "open") return;
    if (t.order.kind === "notice") return this.close(t, "done");
    for (const [id, s] of t.targets) if (s === "pending" || s === "acked") this.targetFailed(t, id, "deadline");
    this.maybeClose(t);
  }

  private close(t: Tracking, status: "done" | "failed" | "cancelled"): void {
    if (t.status !== "open") return;
    t.status = status;
    for (const timer of t.timers.values()) clearTimeout(timer);
    t.timers.clear();
    if (t.deadline) clearTimeout(t.deadline);
    this.emitEvent(t.order, { type: "order.closed", status });
    // Keep closed Orders briefly for late events, then drop them.
    setTimeout(() => this.tracking.delete(t.order.orderId), 60_000).unref?.();
  }

  cancel(threadId: string, by: string): {} {
    const t = [...this.tracking.values()].find((x) => x.order.threadId === threadId && x.status === "open");
    if (!t) throw new RpcError("not_found", `no open question on thread ${threadId} at this daemon`);
    this.emitEvent(t.order, { type: "order.cancelled", by });
    this.close(t, "cancelled");
    return {};
  }

  // -------------------------------------------------------------------------
  // Events: record locally, update metadata, fan out.
  // -------------------------------------------------------------------------

  private emitEvent(order: Order, event: ThreadEventBody, opts: { skipTrack?: boolean } = {}): void {
    const env: ThreadEnvelope = { eventId: ulid(), threadId: order.threadId, orderId: order.orderId, host: this.host, at: Date.now(), event };
    this.recordEvent(env, opts);
  }

  /** Entry point for every event, local or relayed. Idempotent on eventId. */
  private seen = new Set<string>();
  recordEvent(env: ThreadEnvelope, opts: { skipTrack?: boolean; from?: Peer } = {}): void {
    if (this.stopped || this.seen.has(env.eventId)) return;
    this.seen.add(env.eventId);
    if (this.seen.size > 50_000) this.seen = new Set([...this.seen].slice(-25_000));

    const meta = this.updateMeta(env);
    if (meta) {
      this.store.appendEvent(meta.file, env);
      this.store.putThread(meta);
    }
    // Fan out first: tracking may synchronously emit follow-up events (e.g. order.closed).

    for (const s of this.subscribers.get(env.threadId) ?? []) if (s !== opts.from) s.notify(Methods.threadEvent, env);
    for (const ui of this.uis) ui.notify(Methods.threadEvent, { env, meta });
    if (this.isRoot) this.fanOutToChildren(env, opts.from);
    else if (this.rootOnline && opts.from !== this.uplink) this.uplink!.notify(Methods.threadEvent, env);
    for (const l of this.threadLinks.get(env.threadId) ?? []) {
      if (l === opts.from || l.isClosed) continue;
      this.touchLink(l);
      l.notify(Methods.threadEvent, env);
    }
    this.emit("thread", env, meta);
    if (env.event.type === "order.cancelled") this.notifyCancelled(env);
    if (env.event.type === "order.replied" && env.event.final) this.recordOutcome(env, env.event.agentId, "answered");
    else if (env.event.type === "order.declined") this.recordOutcome(env, env.event.agentId, "declined", env.event.unavailable);
    else if (env.event.type === "order.failed" && env.event.agentId) this.recordOutcome(env, env.event.agentId, "failed");
    if (!opts.skipTrack) this.track(env);
  }

  /** `noTopic`: count the outcome but do not tie it to the Order's keywords (operational declines). */
  private recordOutcome(env: ThreadEnvelope, agentId: string, kind: "answered" | "declined" | "failed", noTopic?: boolean): void {
    const rec = this.registry.get(agentId) ?? this.local.get(agentId);
    const order = this.knownOrders.get(env.orderId);
    this.store.recordAgentEvent(agentId, kind, env.at, env.threadId, {
      identity: rec ? identityOf(rec) : undefined,
      tokens: order && !noTopic ? orderKeywords(order.body) : undefined,
    });
    this.hintsDirty = true;
  }

  // -------------------------------------------------------------------------
  // Routing hints (docs/specs/v2-1-routing-hints.md)
  // -------------------------------------------------------------------------

  /** Hints from this Daemon's own outcomes, recomputed lazily. */
  private ownHints(): Record<string, RoutingHint> {
    const now = Date.now();
    if (!this.hintsDirty && now - this.localHintsAt < HINTS_MAX_AGE_MS) return this.localHints;
    const rows = this.store.outcomes(now - HINT_WINDOW_MS).map((r) => {
      const rec = r.identity ? undefined : (this.registry.get(r.agentId) ?? this.local.get(r.agentId));
      return { identity: r.identity ?? (rec ? identityOf(rec) : r.agentId), kind: r.kind, at: r.at, tokens: r.tokens };
    });
    this.localHints = computeHints(rows, now);
    this.localHintsAt = now;
    this.hintsDirty = false;
    return this.localHints;
  }

  /** Hints by identity: the Root's network-wide view while it is online, else our own. */
  routingHints(): Record<string, RoutingHint> {
    if (!this.isRoot && this.rootOnline && this.rootHints) return this.rootHints;
    return this.ownHints();
  }

  private hintsFor(candidates: AgentRecord[]): Map<string, RoutingHint> | undefined {
    if (!this.config.router.learn) return undefined;
    const all = this.routingHints();
    const out = new Map<string, RoutingHint>();
    for (const c of candidates) {
      const h = all[identityOf(c)];
      if (h) out.set(c.agentId, h);
    }
    return out.size ? out : undefined;
  }

  /** Root: push hints to child Daemons when they changed. */
  private pushHints(force?: Peer): void {
    if (!this.isRoot) return;
    const hints = this.ownHints();
    const json = JSON.stringify(hints);
    if (force) return force.notify(Methods.hintsUpdate, { hints });
    if (json === this.pushedHints) return;
    this.pushedHints = json;
    for (const child of this.children.values()) child.notify(Methods.hintsUpdate, { hints });
  }

  /** Tell local Agents that were sent this Order that it was cancelled. Every Host in the Thread sees the event. */
  private notifyCancelled(env: ThreadEnvelope): void {
    if (env.event.type !== "order.cancelled") return;
    const meta = this.metas.get(env.threadId);
    for (const id of meta?.targets ?? []) {
      this.agents.get(id)?.notify(Methods.orderCancelled, { orderId: env.orderId, threadId: env.threadId, by: env.event.by });
    }
  }

  /** Root: forward an event to every Host taking part in the Thread, except where it came from. */
  private fanOutToChildren(env: ThreadEnvelope, from?: Peer): void {
    const meta = this.metas.get(env.threadId);
    const hosts = new Set<string>();
    if (meta) {
      hosts.add(meta.from.host);
      for (const id of meta.targets) {
        const r = this.registry.get(id);
        if (r) hosts.add(r.host);
      }
    }
    hosts.delete(this.host);
    for (const h of hosts) {
      const child = this.children.get(h);
      if (child && child !== from) child.notify(Methods.threadEvent, env);
    }
  }

  /**
   * A relayed Order arrived for a Thread this Daemon has not seen yet (its
   * `order.created` was fanned out before the targets were known). Start the
   * local Thread copy from the Order itself.
   */
  private adoptOrder(order: Order): void {
    this.knownOrders.set(order.orderId, order);
    if (this.metas.has(order.threadId) || this.store.getThread(order.threadId)) return;
    const env: ThreadEnvelope = { eventId: `${order.orderId}:created`, threadId: order.threadId, orderId: order.orderId, host: order.from.host, at: order.createdAt, event: { type: "order.created", order } };
    const meta = this.updateMeta(env)!;
    this.store.appendEvent(meta.file, env);
    this.store.putThread(meta);
    for (const ui of this.uis) ui.notify(Methods.threadEvent, { env, meta });
  }

  private updateMeta(env: ThreadEnvelope): ThreadMeta | undefined {
    const ev = env.event;
    let meta = this.metas.get(env.threadId) ?? this.store.getThread(env.threadId);
    if (!meta) {
      if (ev.type !== "order.created") return undefined;
      meta = {
        threadId: env.threadId,
        orderId: env.orderId,
        kind: ev.order.kind,
        from: ev.order.from,
        targets: [],
        status: "routing",
        summary: ev.order.body.slice(0, 200),
        createdAt: ev.order.createdAt,
        file: this.store.threadFile(env.threadId, ev.order.createdAt),
        turns: 0,
        replies: [],
        declines: [],
      };
    }
    this.metas.set(env.threadId, meta);
    meta.lastActivityAt = env.at;
    const addr = (id: string) => this.registry.get(id)?.address;
    if (ev.type === "order.created") {
      this.knownOrders.set(ev.order.orderId, ev.order);
      // A new turn: the Thread now reflects this Order.
      if (ev.order.orderId !== meta.orderId || meta.turns === 0) {
        meta.orderId = ev.order.orderId;
        meta.turns = Math.max(meta.turns + 1, ev.order.turn);
        meta.turnStartedAt = ev.order.createdAt;
        meta.reason = undefined;
        meta.router = undefined;
        meta.status = "routing";
        meta.replies = [];
        meta.declines = [];
        meta.closedAt = undefined;
      }
      return meta;
    }
    // Late events from an earlier turn are recorded but do not change the Thread's state.
    if (env.orderId !== meta.orderId) return meta;
    switch (ev.type) {
      case "order.routed":
        meta.mode = ev.decision.mode;
        meta.reason = ev.decision.reason;
        meta.router = ev.decision.router;
        for (const id of ev.decision.targets) if (!meta.targets.includes(id)) meta.targets.push(id);
        meta.status = "delivering";
        break;
      case "order.delivered":
        if (!meta.targets.includes(ev.agentId)) meta.targets.push(ev.agentId);
        break;
      case "order.acked":
        if (meta.status === "delivering" || meta.status === "routing") meta.status = "working";
        break;
      case "order.replied":
        meta.firstReplyAt ??= env.at;
        if (ev.final) meta.replies.push({ agentId: ev.agentId, address: addr(ev.agentId), text: ev.text.slice(0, 600), at: env.at });
        break;
      case "order.declined":
        meta.declines.push({ agentId: ev.agentId, address: addr(ev.agentId), reason: ev.reason.slice(0, 300), at: env.at });
        break;
      case "order.closed":
        meta.status = ev.status;
        meta.closedAt = env.at;
        break;
    }
    return meta;
  }

  // -------------------------------------------------------------------------
  // Recovery after a restart
  // -------------------------------------------------------------------------

  /**
   * Re-arm delivery tracking for Orders that originated here and were still open
   * when the Daemon stopped. Baristas resume their agentId on reconnect, so acks,
   * heartbeats and replies keep flowing; if they do not, the usual ack/heartbeat
   * timeouts fail the Order.
   */
  recover(): number {
    let n = 0;
    for (const meta of this.store.listThreads(1000)) {
      if (meta.status === "done" || meta.status === "failed" || meta.status === "cancelled") continue;
      const events = this.store.readEvents(meta.file).filter((e) => e.orderId === meta.orderId);
      const created = events.find((e) => e.event.type === "order.created")?.event;
      if (!created || created.type !== "order.created") continue;
      const order = created.order;
      if (order.from.host !== this.host) continue;
      this.metas.set(meta.threadId, meta);
      this.knownOrders.set(order.orderId, order);
      for (const e of events) this.seen.add(e.eventId);
      const t: Tracking = { order, status: "open", replied: false, targets: new Map(), candidates: [], timers: new Map() };
      this.tracking.set(order.orderId, t);
      n++;
      const routed = events.find((e) => e.event.type === "order.routed")?.event;
      if (!routed || routed.type !== "order.routed") {
        this.emitEvent(order, { type: "order.failed", reason: "daemon restarted before routing finished" });
        this.close(t, "failed");
        continue;
      }
      t.decision = routed.decision;
      for (const id of routed.decision.targets) t.targets.set(id, "pending");
      for (const { event: ev } of events) {
        if (ev.type === "order.delivered" && !t.targets.has(ev.agentId)) t.targets.set(ev.agentId, "pending");
        else if (ev.type === "order.acked" && t.targets.get(ev.agentId) === "pending") t.targets.set(ev.agentId, "acked");
        else if (ev.type === "order.replied" && ev.final) {
          t.targets.set(ev.agentId, "done");
          t.replied = true;
        } else if (ev.type === "order.declined") t.targets.set(ev.agentId, "done");
        else if (ev.type === "order.failed" && ev.agentId) t.targets.set(ev.agentId, "failed");
      }
      t.candidates = routed.decision.candidates.filter((id) => !t.targets.has(id));
      for (const [id, st] of t.targets) {
        if (st === "pending") this.armAck(t, id);
        else if (st === "acked") this.armHeartbeat(t, id);
      }
      if (routed.decision.mode !== "unicast" || order.kind === "notice") {
        const remaining = order.createdAt + (order.deadlineMs ?? this.timing.broadcastDeadlineMs) - Date.now();
        t.deadline = setTimeout(() => this.finishOnDeadline(t), Math.max(0, remaining));
      }
      this.maybeClose(t);
    }
    if (n) this.log(`recovered ${n} open order(s)`);
    return n;
  }

  // -------------------------------------------------------------------------
  // Root side
  // -------------------------------------------------------------------------

  private onChildDaemon(peer: Peer, p: InitializeParams) {
    if (!this.isRoot) throw new RpcError("not_root", "this daemon is not the root");
    const host = p.host!;
    const prev = this.children.get(host);
    if (prev && prev !== peer) prev.close();
    this.children.set(host, peer);
    peer.meta.host = host;
    const now = Date.now();
    this.daemonRecords.set(host, { host, url: p.url ?? "", isRoot: false, online: true, connectedAt: now, lastSeenAt: now });
    if (p.url && this.config.knownDaemons[host] !== p.url) {
      this.config.knownDaemons[host] = p.url;
      saveConfig(this.config, this.store.home);
    }
    peer.on(Methods.registryUpsert, (x: { records: AgentRecord[] }) => {
      this.broadcastDelta(this.registry.upsert(x.records.map((r) => ({ ...r, host }))));
    });
    peer.on(Methods.registryRemove, (x: { agentIds: string[] }) => {
      const own = x.agentIds.filter((id) => this.registry.get(id)?.host === host);
      this.broadcastDelta(this.registry.remove(own));
    });
    peer.on("registry/sync", (x: { records: AgentRecord[] }) => {
      // Child reports its full local set after (re)connecting: replace that host's entries.
      const stale = this.registry.all().filter((r) => r.host === host && !x.records.some((n) => n.agentId === r.agentId)).map((r) => r.agentId);
      if (stale.length) this.broadcastDelta(this.registry.remove(stale));
      if (x.records.length) this.broadcastDelta(this.registry.upsert(x.records.map((r) => ({ ...r, host }))));
      return {};
    });
    peer.on(Methods.orderRelay, (x: { order: Order; agentId: string }) => {
      this.knownOrders.set(x.order.orderId, x.order);
      this.deliver(x.order, x.agentId);
    });
    peer.on(Methods.threadEvent, (env: ThreadEnvelope) => this.recordEvent(env, { from: peer }));
    peer.on("agent/kick", (x: { agentId: string }) => this.kick(x.agentId));
    peer.on(Methods.threadBackfill, (x: { events: ThreadEnvelope[] }) => {
      // Skip events already on file (the Root may have restarted and lost its in-memory dedupe set).
      const first = x.events[0];
      const meta = first ? (this.metas.get(first.threadId) ?? this.store.getThread(first.threadId)) : undefined;
      const known = new Set(meta ? this.store.readEvents(meta.file).map((e) => e.eventId) : []);
      for (const env of x.events) if (!known.has(env.eventId)) this.recordEvent(env, { from: peer, skipTrack: true });
      return {};
    });
    peer.on(Methods.routeDecide, async (x: { order: Order; candidates: string[] }) => {
      const cands = x.candidates.map((id) => this.registry.get(id)).filter((r): r is AgentRecord => !!r);
      return this.router.decide({ order: x.order, candidates: cands, hints: this.hintsFor(cands) });
    });
    this.emitDaemons();
    this.log(`daemon ${host} connected (${p.url})`);
    // Send snapshot after the initialize response.
    queueMicrotask(() => {
      peer.notify(Methods.registrySnapshot, { version: this.registry.version, records: this.registry.all() });
      this.pushHints(peer);
    });
    return { protocolVersion: PROTOCOL_VERSION, host: this.host, isRoot: true, registryVersion: this.registry.version };
  }

  /** Root: after moving to a new address, tell every known Daemon where it is now. */
  async announceRoot(): Promise<void> {
    if (!this.isRoot) return;
    const me = `${this.config.advertise ?? lanAddress()}:${this.config.port}`;
    for (const [host, url] of Object.entries(this.config.knownDaemons)) {
      if (this.children.has(host)) continue;
      try {
        const res = await fetch(`${url.replace(/^ws/, "http")}/api/root`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
          body: JSON.stringify({ root: me }),
          signal: AbortSignal.timeout(3000),
        });
        this.log(`announced root to ${host}: ${res.status}`);
      } catch (err) {
        this.log(`announce to ${host} failed: ${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Child side: uplink to the Root
  // -------------------------------------------------------------------------

  connectRoot(): void {
    if (this.isRoot || !this.config.root || this.stopped) return;
    const target = this.config.root;
    const ws = new WebSocket(`ws://${target}/ws`);
    this.uplinkSocket = ws;
    const peer = new Peer(ws);
    ws.on("open", async () => {
      try {
        const hello = await peer.request<{ host: string }>(Methods.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          kind: "daemon",
          token: this.config.token,
          host: this.host,
          url: this.url(),
          registryVersion: this.registry.version,
        });
        this.uplink = peer;
        this.rootHost = hello.host;
        this.reconnectDelay = 0;
        this.setRootOnline(true);
        await peer.request("registry/sync", { records: [...this.local.values()] });
        void this.flushBackfill();
        this.log(`connected to root ${target}`);
      } catch (err) {
        this.log(`root handshake failed: ${(err as Error).message}`);
        ws.close();
      }
    });
    peer.on(Methods.registrySnapshot, (x: { version: number; records: AgentRecord[] }) => {
      const remote = x.records.filter((r) => r.host !== this.host);
      this.registry.applySnapshot(x.version, [...remote, ...this.local.values()]);
    });
    peer.on(Methods.daemonsChanged, (list: DaemonRecord[]) => this.learnPeers(list));
    peer.on(Methods.hintsUpdate, (x: { hints: Record<string, RoutingHint> }) => {
      this.rootHints = x.hints;
    });
    peer.on(Methods.registryDelta, (raw) => {
      const d = RegistryDelta.parse(raw);
      if (!this.registry.applyDelta(d)) {
        // Gap: re-request a full snapshot by reconnecting.
        ws.close();
      }
    });
    peer.on(Methods.orderRelay, (x: { order: Order; agentId: string }) => {
      this.adoptOrder(x.order);
      this.deliverLocal(x.order, x.agentId);
    });
    peer.on(Methods.threadEvent, (env: ThreadEnvelope) => this.recordEvent(env, { from: peer }));
    peer.on("agent/kick", (x: { agentId: string }) => this.agents.get(x.agentId)?.close());
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("error", () => {});
    ws.on("close", () => {
      peer.closed();
      if (this.uplinkSocket !== ws) return;
      const wasOnline = this.uplink === peer;
      this.uplink = undefined;
      this.rootHints = undefined;
      if (wasOnline) {
        this.setRootOnline(false);
        this.log("root connection lost");
      }
      this.scheduleReconnect();
    });
  }

  private setRootOnline(online: boolean): void {
    const rec = this.daemonRecords.get("__root__") ?? { host: this.rootHost ?? "root", url: `ws://${this.config.root}`, isRoot: true, online, lastSeenAt: Date.now() };
    rec.online = online;
    if (this.rootHost) rec.host = this.rootHost;
    rec.url = `ws://${this.config.root}`;
    rec.lastSeenAt = Date.now();
    if (online) rec.connectedAt = Date.now();
    this.daemonRecords.set("__root__", rec);
    if (!online) {
      // Remote agents become unreachable unless their Daemon can be reached directly (ADR-0004).
      const remote = this.registry.all().filter((r) => r.host !== this.host && r.status !== "offline" && !this.peerUrls.has(r.host));
      if (remote.length) this.registry.upsert(remote.map((r) => ({ ...r, status: "offline" as const })));
    }
    this.emitDaemons();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectDelay = Math.min(this.timing.reconnectMaxMs, this.reconnectDelay ? this.reconnectDelay * 2 : this.timing.reconnectMinMs);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connectRoot(), this.reconnectDelay);
  }

  /** Change the Root address at runtime (CLI `cafe root set`, or Root dial-back). Persists to config.yml. */
  setRoot(addr: string): void {
    if (this.isRoot) throw new RpcError("is_root", "this daemon is the root");
    this.config.root = addr;
    saveConfig(this.config, this.store.home);
    this.reconnectDelay = 0;
    const old = this.uplinkSocket;
    this.uplinkSocket = undefined;
    old?.close();
    this.uplink = undefined;
    this.connectRoot();
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  daemons(): DaemonRecord[] {
    // The listening port is only known after the server starts.
    const self = this.daemonRecords.get(this.host);
    if (self) self.url = this.url();
    return [...this.daemonRecords.values()];
  }

  private emitDaemons(): void {
    const list = this.daemons();
    this.emit("daemons", list);
    for (const ui of this.uis) ui.notify(Methods.daemonsChanged, list);
    // Children keep every Daemon's address so they can go direct while the Root is offline (ADR-0004).
    if (this.isRoot) for (const child of this.children.values()) child.notify(Methods.daemonsChanged, list);
  }

  snapshot() {
    return {
      host: this.host,
      isRoot: this.isRoot,
      rootOnline: this.rootOnline,
      router: this.router.name,
      registryVersion: this.registry.version,
      agents: this.registry.all(),
      daemons: this.daemons(),
      threads: this.store.listThreads(200),
    };
  }

  thread(threadId: string) {
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!meta) return undefined;
    return { meta, events: this.store.readEvents(meta.file) };
  }

  /** Disconnect an Agent (web UI "kick"). Remote Agents are kicked via the Root. */
  kick(agentId: string): void {
    const local = this.agents.get(agentId);
    if (local) return local.close();
    const rec = this.registry.get(agentId);
    if (!rec) throw new RpcError("not_found", `unknown agent ${agentId}`);
    if (this.isRoot) this.children.get(rec.host)?.notify("agent/kick", { agentId });
    else if (this.rootOnline) this.uplink!.notify("agent/kick", { agentId });
    else throw new RpcError("root_unreachable", "root offline");
  }

  stop(): void {
    this.stopped = true;
    this.registry.removeAllListeners();
    this.removeAllListeners();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.hintsTimer);
    clearInterval(this.linkSweep);
    for (const l of this.links.values()) l.ws.close();
    this.uplinkSocket?.close();
    for (const t of this.tracking.values()) {
      for (const timer of t.timers.values()) clearTimeout(timer);
      if (t.deadline) clearTimeout(t.deadline);
    }
    for (const p of this.agents.values()) p.close();
    for (const p of this.children.values()) p.close();
    this.store.close();
  }
}

export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === "IPv4" && !ni.internal) return ni.address;
  }
  return "127.0.0.1";
}
