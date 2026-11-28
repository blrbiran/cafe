import * as nodeTls from "node:tls";
import { daemonWsUrl } from "./urls.ts";
import {
  CURRENT_FEATURES,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  Methods,
  PROTOCOL_VERSION,
  type AgentIdentity,
  type AgentRecord,
  type AgentStatus,
  type Attachment,
  type ChannelDigest,
  type CreateOrderParams,
  type Order,
  type RoutingDecision,
  type TeamContext,
  type TeamRosterUpdate,
  type ThreadEnvelope,
  renderTeamPlaybook,
} from "./index.ts";
import { Peer, RpcError } from "./peer.ts";

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
  /**
   * TLS transport (v4-6). When set, the socket uses `wss://` and the Root CA is added to the trust
   * store — via the per-client `WebSocket` options under Node's `ws`-compatible API, or by extending
   * the process-wide default CA list (Node ≥ 22.19), never by disabling verification.
   */
  tls?: { ca?: string; caFingerprint?: string; servername?: string };
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
  reply(text: string, final?: boolean, attachments?: Attachment[]): Promise<void>;
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
  private readonly resumeProof = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  private closedByUser = false;
  private retry = 0;
  private readonly clarificationDeliveries = new Map<string, boolean>();
  private orderListeners = new Set<Listener<OrderHandle>>();
  private cancelListeners = new Set<Listener<{ orderId: string; threadId: string; by: string }>>();
  private eventListeners = new Set<Listener<ThreadEnvelope>>();
  private digestListeners = new Set<Listener<ChannelDigest>>();
  /** Digest ids already dispatched on this connection (reconnect/replay protection). */
  private seenDigests = new Set<string | number>();
  /** `(publisher, channel, since)` already dispatched; catches a replayed window with a new id. */
  private seenSince = new Set<string>();
  /** Process-local revision guard; registration is the reconnect catch-up. */
  private teamRosterRevision?: number;
  /** The playbook/roster from `agent/register` (v4-13); absent on an older daemon. */
  private _teamContext?: TeamContext;
  private teamContextListeners = new Set<Listener<TeamContext>>();
  private rosterListeners = new Set<Listener<TeamRosterUpdate>>();
  /** What the connected Daemon advertises (v4-12); undefined = it did not say. */
  private daemonFeatures?: string[];
  private daemonVersion?: string;
  private daemonHost?: string;
  /** Feature support proven by the registration echo when the Daemon advertises nothing. */
  private echoed = new Set<string>();
  private warnings: string[] = [];
  private warningListeners = new Set<Listener<string>>();
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

  /** Features the connected Daemon advertises; undefined means it did not advertise any (v4-12). */
  get features(): string[] | undefined {
    return this.daemonFeatures;
  }

  /** `true`/`false` when known (advertised or proven by the registration echo); undefined otherwise. */
  supports(feature: string): boolean | undefined {
    if (this.daemonFeatures) return this.daemonFeatures.includes(feature);
    return this.echoed.has(feature) ? true : undefined;
  }

  /** A mixed-release warning raised on this connection (v4-12); not an error. */
  onWarning(fn: Listener<string>): () => void {
    this.warningListeners.add(fn);
    return () => this.warningListeners.delete(fn);
  }

  /** Take the warnings raised so far (a tool result prepends them once). */
  drainWarnings(): string[] {
    return this.warnings.splice(0);
  }

  private warn(text: string): void {
    this.warnings.push(text);
    for (const fn of this.warningListeners) fn(text);
  }

  private who(): string {
    return `daemon ${this.daemonHost ?? this.opts.daemon} (cafe ${this.daemonVersion ?? "unknown"})`;
  }

  /** Actionable copy: restart if the capable build is already installed, otherwise upgrade there. */
  private upgradeHint(what: string): string {
    return `${what}. If that Host already runs a newer cafe, restart it there (cafe daemon restart); otherwise upgrade cafe on it first, then restart.`;
  }

  private warnIgnored(feature: string, effect: string): void {
    const state = this.supports(feature);
    if (state === true) return;
    const claim = state === false ? "does not support" : "does not advertise";
    this.warn(this.upgradeHint(`${this.who()} ${claim} ${feature}; ${effect}`));
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

  /** A channel digest for an observer (v4-11). One summarized notification, not an Order. */
  onDigest(fn: Listener<ChannelDigest>): () => void {
    this.digestListeners.add(fn);
    return () => this.digestListeners.delete(fn);
  }

  /** The team playbook/roster delivered with registration (v4-13); undefined for a loose team. */
  get teamContext(): TeamContext | undefined {
    return this._teamContext;
  }

  /** Fires once per registration that carried a team context (and again after a reconnect). */
  onTeamContext(fn: Listener<TeamContext>): () => void {
    this.teamContextListeners.add(fn);
    if (this._teamContext) fn(this._teamContext);
    return () => this.teamContextListeners.delete(fn);
  }

  /** A roster change pushed by the daemon; never an Order and never a turn by itself. */
  onRoster(fn: Listener<TeamRosterUpdate>): () => void {
    this.rosterListeners.add(fn);
    return () => this.rosterListeners.delete(fn);
  }

  private setTeamContext(ctx: TeamContext | undefined): void {
    this._teamContext = ctx;
    if (ctx) for (const fn of this.teamContextListeners) fn(ctx);
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

  /**
   * Open the WebSocket with the right scheme. Plaintext uses the global `WebSocket`; TLS adds the
   * Root CA to Node's default trust store before the handshake (`tls.setDefaultCACertificates`,
   * Node ≥ 22.19). The CA is *added*, never swapped for "accept everything", so a leaf outside it
   * still fails.
   */
  private connectSocket(): WebSocket {
    const url = daemonWsUrl(this.opts.daemon, { tls: !!this.opts.tls });
    if (this.opts.tls?.ca) applyCa(this.opts.tls.ca);
    return new WebSocket(url);
  }

  private open(): Promise<AgentRecord | undefined> {
    return new Promise((resolve, reject) => {
      this.seenDigests.clear();
      this.seenSince.clear();
      this._teamContext = undefined;
      this.teamRosterRevision = undefined;
      this.echoed.clear();
      this.daemonFeatures = undefined;
      const ws = this.connectSocket();
      this.ws = ws;
      const peer = new Peer(ws);
      let settled = false;
      peer.on(Methods.orderCancelled, (x: { orderId: string; threadId: string; by: string }) => {
        for (const fn of this.cancelListeners) fn(x);
      });
      peer.on(Methods.orderDeliver, ({ order, attachmentPaths, assignmentId }: { order: Order; attachmentPaths?: Record<string, string>; assignmentId?: string }) => {
        const h = this.handle(order, attachmentPaths, assignmentId);
        if (order.clarificationRecipient) {
          const prior = this.clarificationDeliveries.get(order.orderId);
          if (prior !== undefined) {
            if (prior) void h.ack().catch(() => {});
            return;
          }
          this.clarificationDeliveries.set(order.orderId, false);
          if (this.clarificationDeliveries.size > 512) this.clarificationDeliveries.delete(this.clarificationDeliveries.keys().next().value!);
        }
        for (const fn of this.orderListeners) fn(h);
      });
      peer.on(Methods.threadEvent, (env: ThreadEnvelope) => {
        this.recent.push(env);
        if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
        for (const fn of this.eventListeners) fn(env);
      });
      peer.on(Methods.channelDigest, ({ digest }: { digest: ChannelDigest }) => {
        // A reconnect may replay a digest. The id is a publisher-local sequence (`host:seq` since
        // v4-13), so the sets are cleared on every open. `(publisher, channel, since)` also
        // catches the same window re-sent under a new id.
        const publisher = String(digest.digestId).split(":")[0] ?? "";
        const sinceKey = `${publisher}|${digest.channel}|${digest.since}`;
        if (this.seenDigests.has(digest.digestId) || this.seenSince.has(sinceKey)) return;
        this.seenDigests.add(digest.digestId);
        this.seenSince.add(sinceKey);
        if (this.seenDigests.size > 1000) {
          const oldest = this.seenDigests.values().next().value;
          if (oldest !== undefined) this.seenDigests.delete(oldest);
        }
        if (this.seenSince.size > 1000) {
          const oldest = this.seenSince.values().next().value;
          if (oldest !== undefined) this.seenSince.delete(oldest);
        }
        for (const fn of this.digestListeners) fn(digest);
      });
      peer.on(Methods.teamRoster, ({ update }: { update: TeamRosterUpdate }) => {
        if (this.teamRosterRevision !== undefined && update.revision <= this.teamRosterRevision) return;
        this.teamRosterRevision = update.revision;
        if (update.removedTeam) this.setTeamContext(undefined);
        else if (this._teamContext) {
          const orchestrator = update.members.find((member) => member.duty === "orchestrator")?.name ?? this._teamContext.orchestrator;
          // Re-render the playbook so it names the new roster and front door; the static rules do not change.
          this.setTeamContext({
            ...this._teamContext,
            revision: update.revision,
            roster: update.members,
            orchestrator,
            playbook: renderTeamPlaybook({
              team: this._teamContext.team,
              channel: this._teamContext.channel,
              self: { name: this._teamContext.self.name, ...(this._teamContext.self.duty ? { duty: this._teamContext.self.duty } : {}), online: true },
              orchestrator,
              roster: update.members,
            }),
          });
        }
        for (const fn of this.rosterListeners) fn(update);
      });
      ws.addEventListener("message", (e) => void peer.receive(String(e.data)));
      ws.addEventListener("open", async () => {
        try {
          const hello = await peer.request<{ host?: string; cafeVersion?: string; features?: string[] }>(Methods.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            kind: "agent",
            token: this.opts.token,
            cafeVersion: this.opts.cafeVersion,
            features: [...CURRENT_FEATURES],
          });
          this.daemonFeatures = Array.isArray(hello.features) ? hello.features : undefined;
          this.daemonVersion = hello.cafeVersion;
          this.daemonHost = hello.host;
          this.peer = peer;
          this.retry = 0;
          // Keep the same agentId across reconnects so in-flight Orders stay attributable.
          const identity = this.identity ? { ...this.identity, resumeAgentId: this.record?.agentId ?? this.identity.resumeAgentId } : undefined;
          if (identity) {
            // A confirmed-incapable Daemon is refused before publishing the identity (v4-12 D3).
            if (identity.observer && this.supports("digests") === false) {
              throw new RpcError("unsupported_capability", this.upgradeHint(`${this.who()} does not support digests; observer registration was refused`));
            }
            // v4-13: a team member against a daemon that would treat `to: <team>` as a multicast
            // or strip the team front-door semantics must not connect as a member.
            if (identity.team && this.supports("team-sessions") !== true) {
              // Same cleanup as the observer refusal: never look connected after a refused identity.
              this.peer = undefined;
              peer.closed();
              try {
                ws.close();
              } catch {
                // already closing
              }
              throw new RpcError("unsupported_capability", this.upgradeHint(`${this.who()} does not support team-sessions; team registration was refused`));
            }
            const registered = await peer.request<AgentRecord & { teamContext?: TeamContext }>(Methods.agentRegister, { ...identity, resumeProof: this.resumeProof });
            this.teamRosterRevision = registered.teamContext?.revision;
            this.record = registered;
            this.setTeamContext(registered.teamContext);
            // With no advertisement, the echo still proves support: an old Daemon strips these.
            const lost: string[] = [];
            if (identity.observer && this.record.observer) this.echoed.add("digests");
            if (identity.observer && !this.record.observer) lost.push("observer");
            if (identity.team && this.record.team) this.echoed.add("teams");
            if (identity.team && !this.record.team) lost.push("team");
            if (identity.channels?.length && this.record.channels?.length) this.echoed.add("channels");
            if (identity.channels?.length && !this.record.channels?.length) lost.push("channels");
            if (identity.duty && !this.record.duty) lost.push("duty");
            if (lost.includes("observer")) {
              // Never stay connected as a routable Barista when the caller asked to observe. The
              // close below removes the record; the local filter (v4-12 D5) kept it off the network.
              this.record = undefined;
              this.peer = undefined;
              peer.closed();
              try {
                ws.close();
              } catch {
                // already closing
              }
              throw new RpcError("unsupported_capability", this.upgradeHint(`${this.who()} ignored observer: true; observer registration was refused`));
            }
            if (lost.length) this.warn(this.upgradeHint(`${this.who()} did not keep ${lost.join(", ")} on the registration; this session is an ordinary Barista`));
          }
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

  private handle(order: Order, attachmentPaths?: Record<string, string>, assignmentId?: string): OrderHandle {
    const base = { orderId: order.orderId, threadId: order.threadId, ...(assignmentId ? { assignmentId } : {}) };
    return {
      order,
      ...(order.attachments?.length
        ? { attachments: order.attachments.map((a) => ({ ...a, ...(attachmentPaths?.[a.id] ? { path: attachmentPaths[a.id] } : {}) })) }
        : {}),
      ack: async () => {
        if (!order.clarificationRecipient) return this.req(Methods.orderAck, base);
        await this.ackClarification(order, base);
        this.clarificationDeliveries.set(order.orderId, true);
      },
      heartbeat: (note) => this.req(Methods.orderHeartbeat, { ...base, note }),
      reply: (text, final = true, attachments) => this.req(Methods.orderReply, { ...base, text, final, ...(attachments?.length ? { attachments } : {}) }),
      decline: (reason, opts) => this.req(Methods.orderDecline, { ...base, reason, ...(opts?.unavailable ? { unavailable: true } : {}) }),
    };
  }

  /** Keep the original handler waiting across a transient disconnect. */
  private async ackClarification(order: Order, params: { orderId: string; threadId: string; assignmentId?: string }): Promise<void> {
    const until = order.createdAt + (order.deadlineMs ?? 300_000);
    for (;;) {
      const peer = this.peer;
      if (peer && this.connected) {
        try {
          await peer.request(Methods.orderAck, params);
          return;
        } catch (err) {
          if (!peer.isClosed && this.peer === peer) throw err;
        }
      }
      const remaining = until - Date.now();
      if (!this.opts.reconnect || this.closedByUser || remaining <= 0) throw new Error("could not confirm receipt of the clarification answer");
      if (this.peer && this.peer !== peer && this.connected) continue;
      await new Promise<void>((resolve, reject) => {
        const off = this.onConnect(() => {
          clearTimeout(timeout);
          off();
          resolve();
        });
        const timeout = setTimeout(() => {
          off();
          reject(new Error("clarification answer acknowledgment timed out"));
        }, remaining);
        // An outstanding network acknowledgment should not keep a closed CLI process alive.
        if (typeof timeout === "object") timeout.unref?.();
      });
    }
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
    // v4-13: a field the daemon cannot honour is refused BEFORE an Order exists. A silent
    // downgrade (an escalation that becomes a normal ask, a team message that broadcasts) is
    // worse than an error because the sender believes the wrong semantics succeeded.
    const need = (feature: string, used: boolean, effect: string): void => {
      if (!used || this.supports(feature) === true) return;
      throw new RpcError("unsupported_capability", this.upgradeHint(`${this.who()} does not support ${feature}; ${effect}`));
    };
    need("escalate", params.escalate === true, "the clarification would become a normal routed ask");
    need("collect", params.collect === "all", "the thread may close on the first answer instead of waiting for every target");
    need("channels", !!params.channel && params.channel !== "default", `channel #${params.channel} would be ignored`);
    const ownTeam = !!params.to && (params.to === this.identity?.team || params.to === this.record?.team);
    need("team-sessions", ownTeam, `to: ${params.to} would reach every member instead of the orchestrator`);
    const res = await this.peer.request<{ orderId: string; threadId: string; decision: RoutingDecision }>(Methods.orderCreate, { kind: "order", ...params }, 120_000);
    this.askedOrders.delete(res.threadId);
    this.askedOrders.set(res.threadId, res.orderId);
    if (this.askedOrders.size > 1024) this.askedOrders.delete(this.askedOrders.keys().next().value!);
    if (params.escalate) {
      // The daemon advertised escalate; if the decision still did not reach the parent, say so.
      const reachedParent = res.decision.router === "explicit" && /escalate/i.test(res.decision.reason);
      if (!reachedParent) this.warnIgnored("escalate", "the question became a normal routed ask instead of a sub-Thread to the parent");
    }
    return res;
  }

  async report(params: { threadId: string; orderId: string; text: string }): Promise<void> {
    await this.req("order/report", params);
  }

  async resumeOrderResults(threadId: string, orderId: string): Promise<ThreadEnvelope[]> {
    if (!this.peer) throw new Error("not connected to cafe daemon");
    return this.peer.request("order/resume-results", { threadId, orderId });
  }

  private readonly askedOrders = new Map<string, string>();

  async cancel(threadId: string, orderId = this.askedOrders.get(threadId)): Promise<void> {
    if (!orderId) throw new RpcError("bad_request", "give the exact Order ID to cancel");
    await this.req("order/cancel-exact", { threadId, orderId });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.peer?.closed();
    this.peer = undefined;
  }
}

/**
 * The interval `keepAlive()` uses when no explicit one is passed.
 * `CAFE_HEARTBEAT_INTERVAL_MS` is a test hook: the test daemon's lease is the FAST
 * 200 ms × 3, far below production's 30 s × 3, so an unmodified Bridge would lose
 * any Order that takes longer than 600 ms (#6).
 */
export function heartbeatIntervalMs(): number {
  const ms = Number(process.env.CAFE_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : HEARTBEAT_INTERVAL_MS;
}

/**
 * Add a CA to Node's default trust store so the global `fetch`/`WebSocket` accept the Daemon's leaf
 * (v4-6 §2). Idempotent and additive: the system roots stay trusted, and verification is never
 * turned off. A no-op outside Node (the Web UI never calls this — it stays on plaintext 4777).
 */
const appliedCas = new Set<string>();
function applyCa(caPem: string): void {
  if (appliedCas.has(caPem)) return;
  try {
    // `setDefaultCACertificates` is Node ≥ 22.19 only; Bun (omp) lacks it. Detect rather than assume,
    // so importing this module never throws under an alternate runtime.
    const set = (nodeTls as { setDefaultCACertificates?: (certs: string[]) => void }).setDefaultCACertificates;
    const get = (nodeTls as { getCACertificates?: (kind: string) => string[] }).getCACertificates;
    if (typeof set !== "function" || typeof get !== "function") return;
    // Additive: the system roots stay trusted, and verification is never turned off.
    set([...get("default"), caPem]);
    appliedCas.add(caPem);
  } catch {
    // A runtime without this API keeps the system roots only; the handshake then fails closed
    // rather than silently trusting everything.
  }
}

/** Keep an Order alive while long work runs: sends a heartbeat every interval until stopped. */
export function keepAlive(h: OrderHandle, intervalMs = heartbeatIntervalMs()): () => void {
  const t = setInterval(() => void h.heartbeat().catch(() => {}), intervalMs);
  return () => clearInterval(t);
}
