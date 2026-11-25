import { EventEmitter } from "node:events";
import { createHash, X509Certificate } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import WebSocket from "ws";
import { pushBounded } from "./bounded.ts";
import { pinnedIdentityCheck } from "./tls/trust.ts";
import { tlsAddressOf } from "./tls/bootstrap.ts";
import { localAddresses, missingSans, sanList } from "./tls/certs.ts";
import { routingStats as computeRoutingStats } from "./routing-stats.ts";
import { hintsFromSummary } from "./hints.ts";
import {
  ACK_TIMEOUT_MS,
  AgentIdentity,
  BROADCAST_DEADLINE_MS,
  CreateOrderParams,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES,
  InitializeParams,
  DEFAULT_THREAD_PAGE,
  MAX_ORDER_DEPTH,
  Methods,
  PROTOCOL_VERSION,
  RegistryDelta,
  formatAddress,
  parseAddress,
  type AgentRecord,
  type AgentStatus,
  type Attachment,
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
import { type CafeConfig, diffConfig, loadConfig, saveConfig } from "./config.ts";
import { HINT_WINDOW_MS, computeHints, identityOf, orderKeywords } from "./hints.ts";
import { Registry } from "./registry.ts";
import { LlmRouter, RulesRouter, piComplete, type Router } from "./router.ts";
import { Store } from "./store.ts";
import { summarize } from "./summary.ts";
import { describeFetchError } from "./net-errors.ts";

export interface DaemonOptions {
  config: CafeConfig;
  home: string;
  /** cafe release, exchanged in `initialize` (default "dev"). */
  version?: string;
  /** Override the router (tests inject a fake LLM). */
  router?: Router;
  /** Build the LLM router for a configured model (tests inject a fake). */
  routerFactory?: (model: string) => Promise<Router>;
  /** Override the timing constants (tests). */
  timing?: Partial<Timing>;
  log?: (msg: string) => void;
}

export interface Timing {
  ackTimeoutMs: number;
  heartbeatIntervalMs: number;
  broadcastDeadlineMs: number;
  /**
   * Upper bound for a unicast Order. Heartbeats only prove the Barista is alive, not that it will ever
   * answer; without this a queued Order could hold `cafe ask` open for hours (#60). Much longer than
   * the broadcast deadline because a single Barista may legitimately work for a while.
   */
  unicastDeadlineMs: number;
  /** After the first final answer in a multicast/broadcast, skip silent targets after this long (#39). */
  graceMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Root: how often to recompute and push routing hints when there are new outcomes. */
  hintsIntervalMs: number;
  /** Direct links (Root offline): give up connecting to another Daemon after this long. */
  linkConnectTimeoutMs: number;
  /** Direct links: close an outgoing link after this long without traffic. */
  linkIdleMs: number;
  /** How often to check the TLS leaf while running: expiry (v4-6 §5 B) and addresses it must name (#91). */
  leafCheckIntervalMs: number;
  /** A refused plaintext link counts as "still trying" (a doctor failure) for this long after its last attempt (#93). */
  refusedRecentMs: number;
  /** …and is forgotten this long after its last attempt (#93). */
  refusedForgetMs: number;
  /** A child waiting to join a TLS network retries enrolment after this, doubling (v4-6 §10.3). */
  enrolRetryBaseMs: number;
  /** …up to this. */
  enrolRetryMaxMs: number;
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
  /** Multicast/broadcast: after the first final answer, when to skip silent targets. */
  grace?: ReturnType<typeof setTimeout>;
}

/** Metadata keeps only recent reply/decline summaries; the JSONL log has the full history. */
const MAX_META_REPLIES = 50;
const MAX_META_DECLINES = 50;
/** Attachments of every turn, listed on the Thread (deduplicated by id). */
const MAX_META_ATTACHMENTS = 50;
/** Backfill reads a little before the outage began, for clock skew between Hosts (#31). */
const BACKFILL_SKEW_MS = 10 * 60_000;
/** Events per threadBackfill request, so a long outage is not one huge frame. */
const BACKFILL_BATCH = 500;
/** In-memory caches are bounded so a long-running Daemon does not grow with history (#31). */
function cacheLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const META_CACHE_MAX = () => cacheLimit("CAFE_META_CACHE_MAX", 2_000);
const KNOWN_ORDERS_MAX = () => cacheLimit("CAFE_KNOWN_ORDERS_MAX", 10_000);

/** How long `CreateOrderParams.idempotencyKey` keeps returning the first Order (v4-3 Q4). */
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 1000;

type CreatedOrder = { orderId: string; threadId: string; decision: RoutingDecision };

/** One in-flight or completed idempotent create, keyed by the caller's idempotencyKey. */
interface IdempotentOrder {
  at: number;
  expiresAt: number;
  /** The first request is still routing: concurrent duplicates await it. */
  pending?: Promise<CreatedOrder>;
  result?: CreatedOrder;
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
  /**
   * TLS state shared with the server and the CLI (v4-6): the CA PEM, its fingerprint and the
   * currently active leaf. Set by `runDaemon`; undefined when `security.mode: plaintext`.
   */
  tlsContext?: {
    ca: string;
    caFingerprint: string;
    /**
     * False while this Host is running on a temporary local CA because its Root was unreachable at
     * boot: agent traffic is TLS, but daemon-to-daemon links stay on their established scheme until
     * the real CA is enrolled.
     */
    network?: boolean;
    current(): { cert: string; key: string };
    replace(next: { cert: string; key: string }): void;
    /** Called after `replace`; the TLS listener swaps in the new leaf for new connections. */
    onRenew(fn: () => void): () => void;
    /**
     * Root only: issue a leaf for a child Host (has the CA key). Absent on a child, which asks the
     * Root for one over TLS with its token (`POST /api/tls/leaf`). `publicKey` (SPKI PEM) makes a
     * reissue keep the caller's key, so a peer's pin on that Host still matches.
     */
    issue?(sans: string[], publicKey?: string): Promise<{ cert: string; key: string }>;
    /**
     * Reissue this Host's leaf and swap it in (v4-6 §5 B). A long-running Daemon would otherwise
     * outlive its 90-day leaf and the whole fleet would fail closed at once. The renewal keeps the
     * existing key (so a peer's pin still matches) and writes through to disk.
     */
    renew?(sans?: string[]): Promise<void>;
    /**
     * Child only: this Host booted on a temporary local CA because its Root was unreachable. Calling
     * this enrols the Root's real CA and obtains a leaf from it, in place (v4-6 §3.3).
     */
    enrol?(): Promise<void>;
  };
  readonly host: string;
  readonly version: string;
  private router: Router;
  private routerFactory?: (model: string) => Promise<Router>;
  /** An explicitly injected router (tests) is not replaced by rules when no model is configured. */
  private hasInjectedRouter = false;
  /** Model the running LLM router was built for (undefined: rules). */
  routerModel?: string;
  private lastRouterError?: string;
  /** User-visible name for this Host; `host` stays the stable routing key. */
  private displayName: string;
  private hostAliases: string[];
  private hostLegacyAliases: string[];
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
  /** idempotencyKey → the first Order created with it (short window, bounded; v4-3 Q4). */
  private idempotentOrders = new Map<string, IdempotentOrder>();
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
  /** Set by `drain` for a controlled update: new Orders are refused until restart. */
  private draining = false;
  private rootHost?: string;
  /** cafe release of the Root, from the last handshake. */
  private rootVersion?: string;
  private rootDisplayName?: string;

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
  /** Threads the Root missed while it was offline → when that began (ms; 0 = the whole Thread). */
  private backfill = new Map<string, number>();
  private linkSweep?: ReturnType<typeof setInterval>;
  private pruneTimer?: ReturnType<typeof setTimeout>;
  private pruneInterval?: ReturnType<typeof setInterval>;
  /** Reply/Order attachments whose origin was unreachable: retry until pulled (v4-1 phase 2). */
  private pendingPulls = new Map<string, { a: Attachment; threadId: string }>();
  private pullTimer?: ReturnType<typeof setInterval>;
  private stagingTimer?: ReturnType<typeof setInterval>;

  constructor(opts: DaemonOptions) {
    super();
    this.config = opts.config;
    this.version = opts.version ?? "dev";
    this.isRoot = opts.config.mode === "root";
    this.host = opts.config.host;
    this.displayName = opts.config.displayName ?? opts.config.host;
    this.hostAliases = [...opts.config.aliases];
    this.hostLegacyAliases = [...(opts.config.legacyAliases ?? [])];
    this.store = new Store(opts.home);
    // Every SSE stream and Web UI attaches a "thread" listener; the default limit of 10 is far below
    // normal use (one tab per Thread, `cafe tail`, MCP) and the warning was hidden by --no-warnings (#70).
    this.setMaxListeners(0);
    this.startLagSampler();
    this.log = opts.log ?? ((m) => console.error(`[cafe ${this.host}] ${m}`));
    this.timing = {
      ackTimeoutMs: ACK_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      broadcastDeadlineMs: BROADCAST_DEADLINE_MS,
      unicastDeadlineMs: 10 * 60_000,
      graceMs: 2_000,
      reconnectMinMs: 500,
      reconnectMaxMs: 30_000,
      hintsIntervalMs: 30_000,
      linkConnectTimeoutMs: 3000,
      linkIdleMs: 5 * 60_000,
      leafCheckIntervalMs: 5 * 60_000,
      refusedRecentMs: 10 * 60_000,
      refusedForgetMs: 24 * 3600_000,
      enrolRetryBaseMs: 5_000,
      enrolRetryMaxMs: 5 * 60_000,
      ...opts.timing,
    };
    this.router = opts.router ?? new RulesRouter();
    this.hasInjectedRouter = opts.router !== undefined;
    this.routerFactory = opts.routerFactory;
    this.registry.on("delta", (d) => {
      this.emit("registry", d);
      this.store.saveRegistry(this.registry.version, this.registry.all());
      for (const ui of this.uis) ui.notify(Methods.registryDelta, d);
    });
    // Replica restored from disk; the Root will resync on connect.
    const cached = this.store.loadRegistry();
    if (!this.isRoot && cached.records.length) this.registry.applySnapshot(cached.version, cached.records.filter((r) => r.host !== this.host));
    this.daemonRecords.set(this.host, { host: this.host, hostId: this.host, displayName: this.displayName, aliases: this.hostAliases, legacyAliases: this.hostLegacyAliases, url: this.url(), isRoot: this.isRoot, online: true, connectedAt: Date.now(), lastSeenAt: Date.now(), version: this.version });
    this.schedulePrune();
    this.schedulePulls();
    this.stagingTimer = setInterval(() => {
      try {
        this.cleanStagedArtifacts();
      } catch (err) {
        this.log(`staging cleanup failed: ${(err as Error).message}`);
      }
    }, 24 * 3600_000);
    this.stagingTimer.unref?.();
    if (this.isRoot) {
      this.hintsTimer = setInterval(() => this.pushHints(), this.timing.hintsIntervalMs);
      this.hintsTimer.unref?.();
    } else {
      for (const [h, u] of Object.entries(this.store.getKv<Record<string, string>>("peerUrls") ?? {})) this.peerUrls.set(h, u);
      // `backfill` (ids) predates `backfillSince`; an id without a start is backfilled whole.
      const since = this.store.getKv<Record<string, number>>("backfillSince") ?? {};
      for (const id of this.store.getKv<string[]>("backfill") ?? []) this.backfill.set(id, since[id] ?? 0);
      // Show the Root's real host name before the first (re)connection.
      this.rootHost = this.store.getKv<string>("rootHost");
      this.linkSweep = setInterval(() => this.sweepLinks(), Math.min(this.timing.linkIdleMs, 60_000));
      this.linkSweep.unref?.();
    }
  }

  /**
   * Rebuild the router from the current config. Idempotent: switching models and
   * turning the LLM off both work while the daemon is running. The result says
   * what is actually running, so `/api/reload` and `cafe config set` can report it.
   */
  async initRouter(): Promise<{ ok: boolean; router: Router["name"]; model?: string; error?: string }> {
    const model = this.config.router.model;
    if (!model) {
      if (this.hasInjectedRouter) return { ok: true, router: this.router.name };
      const changed = this.router.name !== "rules";
      this.router = new RulesRouter();
      this.routerModel = undefined;
      this.lastRouterError = undefined;
      if (changed) this.log("router: rules");
      return { ok: true, router: "rules" };
    }
    if (this.router.name === "llm" && this.routerModel === model) return { ok: true, router: "llm", model };
    try {
      const build =
        this.routerFactory ??
        (async (m: string) =>
          new LlmRouter(await piComplete(m), new RulesRouter(), { timeoutMs: this.config.router.timeoutMs, concurrency: this.config.router.concurrency }));
      const built = await build(model);
      // The model was switched while this one loaded (a slow startup load): the newer choice stands.
      if (this.config.router.model !== model) return { ok: true, router: this.router.name, ...(this.routerModel ? { model: this.routerModel } : {}) };
      this.router = built;
      this.routerModel = model;
      this.lastRouterError = undefined;
      this.log(`router: llm (${model})`);
      return { ok: true, router: this.router.name, model };
    } catch (err) {
      if (this.config.router.model !== model) return { ok: true, router: this.router.name, ...(this.routerModel ? { model: this.routerModel } : {}) };
      this.lastRouterError = (err as Error).message;
      this.log(`router: llm unavailable (${this.lastRouterError}); using ${this.router.name}`);
      return { ok: false, router: this.router.name, model, error: this.lastRouterError };
    }
  }

  /** The startup router load, while it runs; routing waits for it so decisions do not change. */
  private routerLoading?: Promise<unknown>;

  /** Start loading the configured router without waiting for it (daemon startup). */
  startRouter(): void {
    const loading = this.initRouter().finally(() => {
      if (this.routerLoading === loading) this.routerLoading = undefined;
    });
    this.routerLoading = loading;
  }

  /** Wait until the startup router load (if any) has finished. */
  private async routerReady(): Promise<void> {
    if (this.routerLoading) await this.routerLoading;
  }

  /** What the router is actually doing now (config may differ from it). */
  routerStatus(): { router: string; model?: string; error?: string; routerLoading?: true } {
    return {
      router: this.router.name,
      ...(this.routerModel ? { model: this.routerModel } : {}),
      ...(this.lastRouterError ? { error: this.lastRouterError } : {}),
      ...(this.routerLoading ? { routerLoading: true as const } : {}),
    };
  }

  /**
   * Choose the router model at runtime. Unlike `setConfigValue` + reload, a model
   * the running daemon cannot load is rolled back here, so the config file and
   * the running router never disagree. `null` / "" turns the LLM off (rules).
   */
  async setRouterModel(model: string | null): Promise<{ ok: boolean; router: Router["name"]; model?: string; error?: string }> {
    const next = model?.trim() || undefined;
    const previous = this.config.router.model;
    if (next === previous) return this.initRouter();
    this.config.router.model = next;
    saveConfig(this.config, this.store.home);
    const applied = await this.initRouter();
    if (applied.ok) return applied;
    // Roll the config back and keep the previous router running; report the failure.
    this.config.router.model = previous;
    saveConfig(this.config, this.store.home);
    const restored = await this.initRouter();
    return { ok: false, router: restored.router, ...(restored.model ? { model: restored.model } : {}), error: applied.error };
  }

  /**
   * The address other Daemons use for this one. On a TLS network it names the TLS endpoint
   * (`wss://<advertise>:<tls port>`), so Root records, `knownDaemons` and the children's direct-link
   * addresses carry TLS too (v4-6 §10.3, #80). Plaintext mode keeps `ws://<advertise>:<port>`.
   */
  url(): string {
    const advertised = this.config.advertise ?? lanAddress();
    if (this.tlsContext?.network && this.tlsPort) return `wss://${hostWithPort(bareHost(advertised), this.tlsPort)}`;
    return `ws://${hostWithPort(advertised, this.config.port)}`;
  }

  /** The TLS listener's port (set by `runDaemon`); advertised in `/api/tls` and in `url()`. */
  tlsPort?: number;
  /** Why this child has not joined the TLS network yet (v4-6 §10.3); cleared once it has. */
  tlsWaiting?: string;

  /**
   * Hosts whose Daemon link arrived on the plaintext port while TLS is on, and was refused (#89).
   * Cleared when that Host next connects over TLS.
   */
  /** `host:port` (a main, plaintext-port address) → the `wss://` endpoint that Host answered with (#92). */
  private tlsEndpoints = new Map<string, string>();
  /** Root: the address each child reported in its latest handshake, so clearing a pin returns to it (#92). */
  private reportedUrls = new Map<string, string>();
  private refusedPlaintext = new Map<string, { host: string; kind: "daemon" | "peer"; at: number; version?: string; ownRecord?: boolean }>();

  /**
   * The refusals still worth reporting, each marked `recent` while that Host is still trying (#93). A
   * refusal nobody repeats for `refusedForgetMs` is dropped, with the Network-page record it alone
   * created: one probe must not keep `cafe doctor` failing forever.
   */
  private refusals(now = Date.now(), emit = true): Array<{ host: string; kind: "daemon" | "peer"; at: number; version?: string; recent: boolean }> {
    for (const [host, r] of this.refusedPlaintext) {
      if (now - r.at < this.timing.refusedForgetMs) continue;
      this.refusedPlaintext.delete(host);
      const rec = this.daemonRecords.get(host);
      if (rec && !rec.online) {
        if (r.ownRecord) this.daemonRecords.delete(host);
        else delete rec.refused;
        if (emit) this.emitDaemons();
      }
    }
    return [...this.refusedPlaintext.values()].map(({ ownRecord: _own, ...r }) => ({ ...r, recent: now - r.at < this.timing.refusedRecentMs }));
  }

  /** Transport state for `/api/health`, `cafe doctor` and `cafe daemon status`. */
  /** This Daemon's main (plaintext-port) address as other machines reach it: what `root:` / `cafe connect` take. */
  mainAddress(): string {
    return hostWithPort(this.config.advertise ?? lanAddress(), this.config.port);
  }

  /**
   * The names this Host's leaf must carry: host, `advertise`, every local IPv4 address and the
   * configured `security.tls.sans` (#91). Read live, so a VPN that comes up later, or a name a person
   * adds, is noticed by the renewal check and by `cafe doctor`.
   */
  desiredSans(): string[] {
    return sanList({ host: this.config.host, advertise: this.config.advertise, lan: localAddresses(), extra: this.config.security.tls.sans });
  }

  /** What another machine needs to join this Root with `cafe connect` (the token is read on the Root). */
  joinHint(): { address: string; caFingerprint?: string } {
    const fp = this.tlsStatus().caFingerprint;
    return { address: this.mainAddress(), ...(fp ? { caFingerprint: `sha256:${fp}` } : {}) };
  }

  tlsStatus(): {
    mode: "plaintext" | "tls";
    port?: number;
    network?: boolean;
    caFingerprint?: string;
    waiting?: string;
    refused?: Array<{ host: string; kind: "daemon" | "peer"; at: number; version?: string; recent: boolean }>;
  } {
    if (!this.tlsContext) return { mode: "plaintext" };
    const network = !!this.tlsContext.network;
    const refused = this.refusals();
    return {
      mode: "tls",
      ...(this.tlsPort ? { port: this.tlsPort } : {}),
      network,
      caFingerprint: this.tlsContext.caFingerprint,
      ...(!network ? { waiting: this.tlsWaiting ?? "enrolling the network CA" } : {}),
      ...(refused.length ? { refused } : {}),
    };
  }

  /**
   * Fail-closed on the accepting side (#89): with TLS on, a Daemon↔Daemon handshake (a child's
   * uplink, a direct link) must arrive on the TLS port. The token in that `initialize` frame has
   * already crossed the network in the clear, so the link is refused, not tolerated.
   */
  private refusePlaintextLink(p: InitializeParams): never {
    const host = p.host ?? "unknown host";
    const kind = p.kind === "daemon" ? "daemon" : "peer";
    const first = !this.refusedPlaintext.has(host);
    const ownRecord = this.refusedPlaintext.get(host)?.ownRecord ?? (kind === "daemon" && this.isRoot && !!p.host && !this.daemonRecords.has(p.host));
    this.refusedPlaintext.set(host, { host, kind, at: Date.now(), ownRecord, ...(p.cafeVersion ? { version: p.cafeVersion } : {}) });
    if (kind === "daemon" && this.isRoot && p.host) {
      // Show the Host as refused rather than letting it vanish; its plaintext address is not kept.
      const now = Date.now();
      const prev = this.daemonRecords.get(p.host);
      if (!prev || !prev.online || this.children.get(p.host) === undefined) {
        this.daemonRecords.set(p.host, {
          ...(prev ?? { host: p.host, hostId: p.host, displayName: p.displayName ?? p.host, aliases: [], legacyAliases: [], url: "", isRoot: false }),
          online: false,
          lastSeenAt: now,
          ...(p.cafeVersion ? { version: p.cafeVersion } : {}),
          refused: { reason: "plaintext", at: now },
        });
        this.emitDaemons();
      }
    }
    if (first) this.log(`tls: refused a plaintext ${kind === "daemon" ? "uplink" : "direct link"} from ${host}${p.cafeVersion ? ` (cafe ${p.cafeVersion})` : ""}; it must connect over TLS`);
    const tlsPort = this.tlsPort ? ` (TLS port ${this.tlsPort})` : "";
    throw new RpcError(
      "tls_required",
      `${this.host} requires TLS${tlsPort}, but ${host} connected in plaintext. On ${host}: upgrade cafe to ${this.version} or later, ` +
        "set security.mode to tls (cafe config set security.mode tls), and restart it (cafe daemon restart); it then joins over wss automatically",
    );
  }

  /**
   * The WebSocket base URL (no `/ws`) to dial another Daemon at `addr` — a `wss://` / `ws://` URL or a
   * bare `host:port` (v4-6 §10.3). On a TLS network a plaintext address (a hand-set pin, the Root's main
   * address, an older Daemon's self-report) is upgraded by asking that Host for its TLS port; it is
   * never dialled in plaintext. A Host still waiting to join the network dials nothing.
   */
  private async resolveDaemonUrl(addr: string): Promise<string> {
    const trimmed = addr.replace(/\/+$/, "").replace(/\/ws$/, "");
    if (!this.tlsContext) return /^wss?:\/\//.test(trimmed) ? trimmed : `ws://${trimmed}`;
    if (!this.tlsContext.network) throw new Error(`not on the TLS network yet (${this.tlsWaiting ?? "enrolling"}); nothing is sent in plaintext`);
    if (trimmed.startsWith("wss://")) return trimmed;
    const plain = trimmed.replace(/^ws:\/\//, "");
    try {
      const resolved = `wss://${await tlsAddressOf(plain, { ca: this.tlsContext.ca })}`;
      this.tlsEndpoints.set(plain, resolved);
      return resolved;
    } catch (err) {
      throw new Error(`cannot find the TLS port of ${plain}: ${(err as Error).message}`);
    }
  }

  /**
   * `fetch` for another Daemon's API. An `https://` target is verified against *this network's* CA
   * explicitly (and its SAN, by Node's default identity check), not the process-wide trust store,
   * which holds one extra CA at a time and would make a probe depend on whichever Daemon set it last.
   */
  private async daemonFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<{ ok: boolean; status: number; json(): Promise<any> }> {
    if (!url.startsWith("https://") || !this.tlsContext) return fetch(url, init);
    const { request } = await import("node:https");
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = request(
        { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port), path: u.pathname + u.search, method: init.method ?? "GET", headers: init.headers, ca: this.tlsContext!.ca, servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (init.signal) {
        if (init.signal.aborted) req.destroy(init.signal.reason as Error);
        init.signal.addEventListener("abort", () => req.destroy(init.signal!.reason as Error), { once: true });
      }
      req.end(init.body);
    });
  }

  /** `http(s)://host:port` for a Daemon's HTTP API, following the same rule as `resolveDaemonUrl`. */
  private async httpBase(addr: string): Promise<string> {
    return (await this.resolveDaemonUrl(addr)).replace(/^ws/, "http");
  }

  /** `ws` client options for a Daemon link: trust exactly the network's CA, never disable verification. */
  private linkOptions(peerAddr?: string): import("ws").ClientOptions {
    if (!this.tlsContext?.network) return {};
    // Per-peer leaf-key pin (v4-6 §5 A): the CA pin authenticates the trust anchor; a separate pin per
    // `host:port` catches an unexpected leaf issued under that CA (a compromised CA key, or the wrong
    // machine answering on an address). First contact records the key; after that a different key is
    // refused, naming both values so a person can verify the change out of band. `pinnedIdentityCheck`
    // also runs Node's SAN check — a custom `checkServerIdentity` replaces it, it does not add to it.
    const check = peerAddr
      ? pinnedIdentityCheck(
          peerAddr,
          () => this.config.security.tls.pins,
          (peer, keyFingerprint) => this.recordPeerPin(peer, keyFingerprint),
        )
      : undefined;
    // `ws` types `checkServerIdentity` as Node's older `CertMeta` signature, but it passes the option
    // straight to `tls.connect`, where it receives a `PeerCertificate` (the shape we use).
    return { ca: this.tlsContext.ca, ...(check ? { checkServerIdentity: check as unknown as import("ws").ClientOptions["checkServerIdentity"] } : {}) };
  }

  /** Persist a peer leaf-key pin learned on first contact (TOFU); later contacts are checked against it. */
  private recordPeerPin(peer: string, fingerprint: string): void {
    if (this.config.security.tls.pins[peer] === fingerprint) return;
    this.config.security.tls.pins[peer] = fingerprint;
    saveConfig(this.config, this.store.home);
    this.log(`tls: pinned ${peer} leaf ${fingerprint}`);
  }

  get rootOnline(): boolean {
    return this.isRoot || (this.uplink !== undefined && !this.uplink.isClosed);
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** Attach a freshly accepted socket. `local` = loopback (no token required). */
  accept(ws: WebSocket, local: boolean, secure = false): void {
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
      if (p.protocolVersion !== PROTOCOL_VERSION) throw new RpcError("protocol_mismatch", this.mismatchMessage(p));
      if ((p.kind === "daemon" || p.kind === "peer") && this.tlsContext) {
        if (!secure) this.refusePlaintextLink(p);
        if (p.host) this.refusedPlaintext.delete(p.host);
      }
      peer.meta.kind = p.kind;
      if (p.kind === "daemon") return this.onChildDaemon(peer, p);
      if (p.kind === "peer") {
        peer.meta.host = p.host;
        if (p.host && p.url && !this.isRoot) this.learnPeers([{ host: p.host, url: p.url }]);
        this.bindLink(peer);
        return { protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, host: this.host, displayName: this.displayName, aliases: this.hostAliases, isRoot: this.isRoot };
      }
      if (p.kind === "ui") this.uis.add(peer);
      return { protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, host: this.host, displayName: this.displayName, aliases: this.hostAliases, isRoot: this.isRoot };
    });
    this.bindAgentMethods(peer);
  }

  /** Why a connection from another cafe release was refused, with the fix. */
  private mismatchMessage(p: InitializeParams): string {
    const who = p.host ? `${p.host} (cafe ${p.cafeVersion ?? "unknown"})` : `this client (cafe ${p.cafeVersion ?? "unknown"})`;
    return `${who} speaks protocol ${p.protocolVersion}, but ${this.host} (cafe ${this.version}) speaks protocol ${PROTOCOL_VERSION}; install the same cafe release on both (npm i -g @blrbiran/cafe@${this.version})`;
  }

  private onPeerClosed(peer: Peer): void {
    this.uis.delete(peer);
    if (peer.meta.kind === "peer") this.dropLink(peer);
    // Drop the key with its last subscriber, as dropLink() does for threadLinks; otherwise every
    // thread ever subscribed keeps an empty Set for the life of the process (#85).
    for (const [threadId, subs] of this.subscribers) {
      subs.delete(peer);
      if (subs.size === 0) this.subscribers.delete(threadId);
    }
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
        aliases: resumable?.aliases ?? [],
        legacyAliases: resumable?.legacyAliases ?? [],
        ...(resumable?.displayName ? { displayName: resumable.displayName } : {}),
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
    peer.on(Methods.agentRename, (x: { agentId: string; displayName?: string; alias?: string; removeAlias?: string }) => {
      if (typeof x.agentId !== "string") throw new RpcError("bad_request", "agentId is required");
      if (x.displayName) return this.renameAgent(x.agentId, x.displayName);
      if (x.alias) return this.aliasAgent(x.agentId, x.alias);
      if (x.removeAlias) return this.removeAgentAlias(x.agentId, x.removeAlias);
      throw new RpcError("bad_request", "displayName, alias or removeAlias is required");
    });
    peer.on(Methods.orderCreate, (raw) => this.createOrder(CreateOrderParams.parse(raw), peer));
    peer.on(Methods.orderAck, (p: { orderId: string; threadId: string }) => this.agentEvent(peer, p, { type: "order.acked", agentId: peer.meta.agentId }));
    peer.on(Methods.orderHeartbeat, (p: { orderId: string; threadId: string; note?: string }) =>
      this.agentEvent(peer, p, { type: "order.heartbeat", agentId: peer.meta.agentId, note: p.note }),
    );
    peer.on(Methods.orderReply, (p: { orderId: string; threadId: string; text: string; final?: boolean; attachments?: Attachment[] }) => {
      // Reply blobs were uploaded to this daemon first; move them into the Thread
      // so the Customer's daemon can proxy the download (v4-1 phase 2).
      const attachments = p.attachments?.length ? this.commitAttachments(p.attachments, p.threadId) : undefined;
      return this.agentEvent(peer, p, { type: "order.replied", agentId: peer.meta.agentId, text: p.text, final: p.final ?? true, ...(attachments?.length ? { attachments } : {}) });
    });
    peer.on(Methods.orderDecline, (p: { orderId: string; threadId: string; reason: string; unavailable?: boolean }) =>
      this.agentEvent(peer, p, { type: "order.declined", agentId: peer.meta.agentId, reason: p.reason, ...(p.unavailable ? { unavailable: true } : {}) }),
    );
    peer.on(Methods.orderCancel, (p: { threadId: string }) => this.cancel(p.threadId, peer.meta.party?.address ?? "customer"));
    // Bridged Baristas (Codex / Claude) remember which external session continues a Thread (v3-1 Q79).
    const sessionKey = (p: { threadId?: unknown; kind?: unknown }) => {
      const rec = peer.meta.agentId ? this.local.get(peer.meta.agentId as string) : undefined;
      if (!rec) throw new RpcError("not_registered", "agent/register first");
      if (typeof p.threadId !== "string" || typeof p.kind !== "string") throw new RpcError("bad_request", "threadId and kind are required");
      return { kind: p.kind, cwd: rec.cwd, threadId: p.threadId };
    };
    peer.on(Methods.agentSessionGet, (p: { threadId: string; kind: string }) => {
      const k = sessionKey(p);
      return { sessionId: this.store.getAgentSession(k.kind, k.cwd, k.threadId) };
    });
    peer.on(Methods.agentSessionSet, (p: { threadId: string; kind: string; sessionId: string }) => {
      const k = sessionKey(p);
      if (typeof p.sessionId !== "string" || !p.sessionId) throw new RpcError("bad_request", "sessionId is required");
      this.store.setAgentSession(k.kind, k.cwd, k.threadId, p.sessionId);
      return {};
    });
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

  // -------------------------------------------------------------------------
  // Identity: display names and aliases (internal host/agent ids never change)
  // -------------------------------------------------------------------------

  /** Rename this Host (hot) and/or add/remove aliases. Addresses embed the stable `host`, not this name. */
  setHostIdentity(displayName?: string, addAliases: string[] = [], removeAliases: string[] = []): DaemonRecord {
    if (displayName) this.assertHostNameFree(displayName);
    for (const alias of addAliases.filter(Boolean)) this.assertHostNameFree(alias);
    for (const alias of removeAliases.filter(Boolean)) this.assertHostAliasRemovable(alias);
    if (displayName) {
      const next = displayName.trim();
      // The old display name stays routable but is not a display candidate any more.
      if (this.displayName && this.displayName !== next) this.hostLegacyAliases = [...new Set([...this.hostLegacyAliases, this.displayName])];
      this.displayName = next;
      this.config.displayName = this.displayName;
    }
    this.hostAliases = this.hostAliases.filter((a) => !removeAliases.includes(a));
    this.hostAliases = [...new Set([...this.hostAliases, ...addAliases.map((a) => a.trim()).filter(Boolean)])];
    this.config.aliases = this.hostAliases;
    this.config.legacyAliases = this.hostLegacyAliases;
    saveConfig(this.config, this.store.home);
    const rec = this.daemonRecords.get(this.host)!;
    rec.displayName = this.displayName;
    rec.aliases = this.hostAliases;
    rec.legacyAliases = this.hostLegacyAliases;
    this.emitDaemons();
    if (!this.isRoot && this.rootOnline) this.uplink!.notify(Methods.hostIdentity, { displayName: this.displayName, aliases: this.hostAliases, removeAliases, legacyAliases: this.hostLegacyAliases });
    this.log(`renamed host to ${this.displayName}${this.hostAliases.length ? ` (aliases: ${this.hostAliases.join(", ")})` : ""}`);
    return rec;
  }

  /** Root: rename another Daemon. Works while it is offline (the alias is applied on reconnect). */
  renameHost(host: string, displayName: string, opts: { aliases?: string[]; removeAliases?: string[] } = {}): DaemonRecord {
    if (!this.isRoot) throw new RpcError("not_root", "only the Root can rename another Host");
    const rec = this.daemonRecords.get(host);
    if (!rec) throw new RpcError("not_found", `no daemon '${host}'`);
    const name = displayName.trim() || rec.displayName || host;
    if (name !== (rec.displayName ?? rec.host)) this.assertHostNameFree(name, host);
    const add = (opts.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    for (const a of add) this.assertHostNameFree(a, host);
    const remove = new Set((opts.removeAliases ?? []).map((a) => a.trim()).filter(Boolean));
    for (const a of remove) {
      if (a === host || a === name || (rec.legacyAliases ?? []).includes(a))
        throw new RpcError("bad_request", `'${a}' is kept for routing and cannot be removed (only user-added aliases can)`);
    }
    const prev = rec.displayName ?? rec.host;
    const legacy = [...new Set([...(rec.legacyAliases ?? []), ...(prev !== name ? [prev] : []), host])];
    const aliases = [...new Set([...(rec.aliases ?? []), ...add])].filter((a) => a !== name && !legacy.includes(a) && !remove.has(a));
    rec.displayName = name;
    rec.aliases = aliases;
    rec.legacyAliases = legacy;
    this.config.hostNames[host] = { displayName: name, aliases, legacyAliases: legacy };
    saveConfig(this.config, this.store.home);
    this.children.get(host)?.notify(Methods.hostIdentity, { displayName: name, aliases, removeAliases: [...remove], legacyAliases: legacy });
    this.emitDaemons();
    return rec;
  }

  /** Rename a local Agent: the Address (and agentId) stay stable; the old name stays routable as a legacy alias. */
  renameAgent(agentId: string, displayName: string): AgentRecord {
    const rec = this.local.get(agentId);
    if (!rec) throw new RpcError("not_found", "not a local agent");
    this.assertAgentNameFree(displayName, rec.host, agentId);
    const name = displayName.trim();
    const prev = rec.displayName ?? rec.name;
    const legacyAliases = [...new Set([...rec.legacyAliases, ...(prev !== name ? [prev] : [])])];
    const aliases = rec.aliases.filter((a) => a !== name && !legacyAliases.includes(a));
    const next = { ...rec, displayName: name, aliases, legacyAliases };
    this.local.set(agentId, next);
    this.publishAgents([next]);
    return next;
  }

  /** Local agent or, at the Root, an Agent on a connected child (relayed over `agent/rename`). */
  async renameAgentAny(address: string, displayName: string): Promise<AgentRecord> {
    const ids = this.registry.resolve(this.normalizeAddress(address));
    const rec = ids.length ? this.registry.get(ids[0]!) : undefined;
    if (!rec) throw new RpcError("not_found", `no agent at '${address}'`);
    if (rec.host === this.host) return this.renameAgent(rec.agentId, displayName);
    const child = this.children.get(rec.host);
    if (!child) throw new RpcError("unreachable", `${rec.host} is not connected to the Root`);
    return child.request<AgentRecord>(Methods.agentRename, { agentId: rec.agentId, displayName });
  }

  /** Add an alias that still resolves to a local Agent (no rename). */
  aliasAgent(agentId: string, alias: string): AgentRecord {
    const rec = this.local.get(agentId);
    if (!rec) throw new RpcError("not_found", "not a local agent");
    this.assertAgentNameFree(alias, rec.host, agentId);
    const next = { ...rec, aliases: [...new Set([...rec.aliases, alias.trim()])] };
    this.local.set(agentId, next);
    this.publishAgents([next]);
    return next;
  }

  /** Remove a user-added alias. Automatic legacy aliases stay routable and cannot be removed this way. */
  removeAgentAlias(agentId: string, alias: string): AgentRecord {
    const rec = this.local.get(agentId);
    if (!rec) throw new RpcError("not_found", "not a local agent");
    const a = alias.trim();
    if (!rec.aliases.includes(a)) throw new RpcError("bad_request", `'${a}' is not a removable alias of ${rec.address}${rec.legacyAliases.includes(a) ? " (it is a legacy name kept for routing)" : ""}`);
    const next = { ...rec, aliases: rec.aliases.filter((x) => x !== a) };
    this.local.set(agentId, next);
    this.publishAgents([next]);
    return next;
  }

  /** Remove a user-added alias of this Host. Legacy names (and the stable host id) stay routable. */
  removeHostAlias(alias: string): DaemonRecord {
    const a = alias.trim();
    this.assertHostAliasRemovable(a);
    this.hostAliases = this.hostAliases.filter((x) => x !== a);
    this.config.aliases = this.hostAliases;
    saveConfig(this.config, this.store.home);
    const rec = this.daemonRecords.get(this.host)!;
    rec.aliases = this.hostAliases;
    this.emitDaemons();
    if (!this.isRoot && this.rootOnline) this.uplink!.notify(Methods.hostIdentity, { displayName: this.displayName, aliases: this.hostAliases, removeAliases: [a], legacyAliases: this.hostLegacyAliases });
    return rec;
  }

  private assertHostAliasRemovable(alias: string): void {
    const a = alias.trim();
    if (a === this.host || a === this.displayName || this.hostLegacyAliases.includes(a))
      throw new RpcError("bad_request", `'${a}' is kept for routing and cannot be removed (only user-added aliases can)`);
    if (!this.hostAliases.includes(a)) throw new RpcError("bad_request", `'${a}' is not an alias of this Host`);
  }

  async aliasAgentAny(address: string, alias: string): Promise<AgentRecord> {
    const ids = this.registry.resolve(this.normalizeAddress(address));
    const rec = ids.length ? this.registry.get(ids[0]!) : undefined;
    if (!rec) throw new RpcError("not_found", `no agent at '${address}'`);
    if (rec.host === this.host) return this.aliasAgent(rec.agentId, alias);
    const child = this.children.get(rec.host);
    if (!child) throw new RpcError("unreachable", `${rec.host} is not connected to the Root`);
    return child.request<AgentRecord>(Methods.agentRename, { agentId: rec.agentId, alias });
  }

  async removeAgentAliasAny(address: string, alias: string): Promise<AgentRecord> {
    const ids = this.registry.resolve(this.normalizeAddress(address));
    const rec = ids.length ? this.registry.get(ids[0]!) : undefined;
    if (!rec) throw new RpcError("not_found", `no agent at '${address}'`);
    if (rec.host === this.host) return this.removeAgentAlias(rec.agentId, alias);
    const child = this.children.get(rec.host);
    if (!child) throw new RpcError("unreachable", `${rec.host} is not connected to the Root`);
    return child.request<AgentRecord>(Methods.agentRename, { agentId: rec.agentId, removeAlias: alias });
  }

  /**
   * Root: a person's hand-set address for another Host. It beats the address that Host reports about
   * itself, and — once proven reachable — is what the Root broadcasts to children (#75). `null` clears it.
   */
  async setHostAddress(host: string, url: string | null): Promise<DaemonRecord & { verified?: boolean; error?: string; code?: string }> {
    if (!this.isRoot) throw new RpcError("not_root", "only the Root can set another Host's address");
    if (host === this.host) throw new RpcError("bad_request", "this is the Root itself; set `advertise` instead");
    const record = this.daemons().find((d) => d.host === host);
    if (!record && !host) throw new RpcError("bad_request", "host is required");
    if (url === null) {
      delete this.config.pinnedDaemons[host];
    } else {
      this.config.pinnedDaemons[host] = assertDaemonAddress(url).replace(/^ws:\/\//, "");
    }
    saveConfig(this.config, this.store.home);
    const rec = this.daemonRecords.get(host);
    // A cleared pin must fall back to the address the Root verified, not keep the stale pin (#75).
    // A cleared pin goes back to what the child itself reports, then to the address the Root verified —
    // never to an older remembered one (#75, #92).
    if (rec) rec.url = url === null ? (this.reportedUrls.get(host) ?? this.verifiedAddress(host) ?? rec.url) : this.pinnedAddress(host)!;
    this.emitDaemons();
    this.log(url === null ? `cleared pinned address for ${host}` : `pinned ${host} -> ${this.config.pinnedDaemons[host]}`);
    // Prove the new address before it reaches the children: a hand-typed Docker address is as useless
    // to them as a self-reported one (#75).
    // The probe result goes back to the caller, so "saved" is never shown for an address the Root
    // just failed to reach (#83).
    const probe = url !== null ? await this.rememberChildUrl(host, this.pinnedAddress(host)!) : undefined;
    const result = this.daemons().find((d) => d.host === host) ?? record!;
    return probe ? { ...result, ...probe } : result;
  }

  /** The pinned address if a person set one; also the only child address worth broadcasting. */
  private pinnedAddress(host: string): string | undefined {
    const pin = this.config.pinnedDaemons[host];
    if (!pin) return undefined;
    if (/^wss?:\/\//.test(pin)) return pin;
    // On a TLS network a pin is a main address: once the Host has told us its TLS port the address is
    // its `wss://` endpoint; until then it stays a bare `host:port`, which is upgraded when dialled —
    // never shown or used as `ws://` (#92).
    if (this.tlsContext?.network) return this.tlsEndpoints.get(pin) ?? pin;
    return `ws://${pin}`;
  }

  /**
   * A child address has been proven reachable from this Host (pinned, or probed before saving).
   * A pin counts only once the probe recorded it in `knownDaemons`; until then the last verified
   * address keeps being shared, so an unreachable pin never breaks the other children's direct links.
   */
  private verifiedAddress(host: string): string | undefined {
    const pinned = this.pinnedAddress(host);
    const known = this.config.knownDaemons[host];
    if (pinned && known === pinned) return pinned;
    // A plaintext address remembered before this network used TLS is stale: nothing dials it as is, and
    // handing it out made children (and the Network page) show `ws://<old address>` (#92).
    if (known && this.tlsContext?.network && known.startsWith("ws://")) return undefined;
    return known ? known : undefined;
  }

  /** What another Host actually remembered for `host`, for tests and diagnosis. */
  peerUrlFor(host: string): string | undefined {
    return this.peerUrls.get(host);
  }

  /**
   * Reachability check from this machine to another Host (Web "Test"). The direct address is tried
   * first; when it fails but that Host's uplink to this Root is up, the Host is online all the same —
   * the answer says so and names the address that failed (#92), instead of "unreachable" next to a
   * green "online".
   */
  async testHost(host: string): Promise<{ host: string; online: boolean; via?: "direct" | "uplink"; address?: string; latencyMs?: number; version?: string; error?: string; code?: string }> {
    if (host === this.host) return { host, online: true, latencyMs: 0, version: this.version };
    const rec = this.daemons().find((d) => d.host === host);
    const url = this.pinnedAddress(host) || rec?.url || (host === "root" && this.config.root ? `ws://${this.config.root}` : undefined) || this.config.knownDaemons[host];
    const viaUplink = (failure: { error?: string; code?: string }, address?: string) => ({
      host,
      online: true,
      via: "uplink" as const,
      ...(address ? { address } : {}),
      ...(rec?.version ? { version: rec.version } : {}),
      ...failure,
    });
    if (!url) {
      if (await this.uplinkAlive(host)) return viaUplink({ error: "no address to dial it directly" });
      throw new RpcError("not_found", `no daemon '${host}'`);
    }
    const address = url.replace(/^wss?:\/\//, "");
    const started = Date.now();
    try {
      const res = await this.daemonFetch(`${await this.httpBase(url)}/api/health`, {
        headers: { authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        const failure = { error: res.status === 401 ? "unauthorized: the hosts use different tokens" : `HTTP ${res.status}`, code: res.status === 401 ? "UNAUTHORIZED" : `HTTP_${res.status}` };
        return (await this.uplinkAlive(host)) ? viaUplink(failure, address) : { host, online: false, address, ...failure };
      }
      const info = (await res.json()) as { version?: string };
      return { host, online: true, via: "direct", address, latencyMs: Date.now() - started, ...(info.version ? { version: info.version } : {}) };
    } catch (err) {
      const failure = describeFetchError(err, address);
      return (await this.uplinkAlive(host)) ? viaUplink(failure, address) : { host, online: false, address, ...failure };
    }
  }

  /**
   * Root: does `host`'s uplink still answer? A round-trip, not the `children` map: a Host that just
   * stopped is still in the map until its close is processed. Any reply counts, including an
   * `unknown_method` error from an older Daemon.
   */
  private async uplinkAlive(host: string, timeoutMs = 1500): Promise<boolean> {
    const peer = this.children.get(host);
    if (!peer) return false;
    try {
      await peer.request("cafe/ping", {}, timeoutMs);
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      return code !== "closed" && code !== "timeout";
    }
  }

  /** Root: ask a known Host to dial back (used by the Web Network page). */
  async reconnectHost(host: string): Promise<{ host: string; online: boolean; latencyMs?: number; version?: string; error?: string; code?: string }> {
    if (!this.isRoot) throw new RpcError("not_root", "only the Root can reconnect another Host");
    if (this.children.has(host)) return this.testHost(host);
    const rec = this.daemons().find((d) => d.host === host);
    const url = this.pinnedAddress(host) || rec?.url || (host === "root" && this.config.root ? `ws://${this.config.root}` : undefined) || this.config.knownDaemons[host];
    if (!url) throw new RpcError("not_found", `no daemon '${host}'`);
    const me = this.mainAddress();
    try {
      await this.daemonFetch(`${await this.httpBase(url)}/api/root`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ root: me }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // testHost below reports the concrete failure.
    }
    await new Promise((r) => setTimeout(r, 300));
    return this.testHost(host);
  }

  /** Translate `name@alias` to `name@host` using Daemon display names and aliases. */
  private normalizeAddress(address: string): string {
    const a = parseAddress(address);
    if (!a?.host) return address;
    const rec = this.daemons().find((d) => d.host === a.host || d.displayName === a.host || d.aliases.includes(a.host!) || (d.legacyAliases ?? []).includes(a.host!));
    if (!rec || rec.host === a.host) return address;
    return `${a.name}${a.n === undefined ? "" : `#${a.n}`}@${rec.host}`;
  }

  /** Names appear in addresses, so `@` and `#` would make an Agent unreachable. */
  private cleanName(name: string, what: string): string {
    const n = name.trim();
    if (!n) throw new RpcError("bad_request", `${what} must not be empty`);
    if (/[@#]/.test(n)) throw new RpcError("bad_request", `${what} must not contain '@' or '#'`);
    return n;
  }

  /** Display names and aliases are alternate Host ids, so they must be unique network-wide. */
  private assertHostNameFree(name: string, exceptHost = this.host): void {
    const n = this.cleanName(name, "host name");
    for (const d of this.daemons()) {
      if (d.host === exceptHost) continue;
      if (d.host === n || d.displayName === n || (d.aliases ?? []).includes(n) || (d.legacyAliases ?? []).includes(n))
        throw new RpcError("conflict", `host name '${n}' is already used by ${d.host}`);
    }
  }

  /** Agent names resolve inside one Host's namespace, so only collisions on the same Host matter. */
  private assertAgentNameFree(name: string, host: string, exceptAgentId?: string): void {
    const n = this.cleanName(name, "agent name");
    const seen = new Map<string, AgentRecord>();
    for (const r of this.registry.all()) seen.set(r.agentId, r);
    for (const r of this.local.values()) seen.set(r.agentId, r);
    for (const r of seen.values()) {
      if (r.host !== host || r.agentId === exceptAgentId) continue;
      if (r.name === n || r.displayName === n || r.aliases.includes(n) || r.legacyAliases.includes(n))
        throw new RpcError("conflict", `agent name '${n}' is already used by ${r.address}`);
    }
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

  /**
   * Create an Order. `idempotencyKey` makes a repeated request inside a short
   * window return the first Order/Thread; the key is the caller's (a platform
   * event id for connectors, v4-3 Q4). Without a key nothing is deduplicated.
   */
  async createOrder(p: CreateOrderParams, peer?: Peer): Promise<CreatedOrder> {
    const key = p.idempotencyKey;
    if (!key) return this.createOrderInner(p, peer);
    const now = Date.now();
    this.pruneIdempotent(now);
    const hit = this.idempotentOrders.get(key);
    if (hit && hit.expiresAt > now) {
      if (hit.result) return hit.result;
      if (hit.pending) return hit.pending;
    }
    const entry: IdempotentOrder = { at: now, expiresAt: now + IDEMPOTENCY_WINDOW_MS };
    this.idempotentOrders.set(key, entry);
    entry.pending = this.createOrderInner(p, peer);
    try {
      const result = await entry.pending;
      entry.result = result;
      entry.pending = undefined;
      return result;
    } catch (err) {
      // A failed create is not a result: let the caller retry with the same key.
      this.idempotentOrders.delete(key);
      throw err;
    }
  }

  private pruneIdempotent(now: number): void {
    for (const [key, entry] of this.idempotentOrders) {
      if (entry.expiresAt <= now) this.idempotentOrders.delete(key);
    }
    // Bounded map: a burst larger than the cap evicts the oldest keys (Map keeps insertion order).
    while (this.idempotentOrders.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.idempotentOrders.keys().next().value;
      if (oldest === undefined) break;
      this.idempotentOrders.delete(oldest);
    }
  }

  private async createOrderInner(p: CreateOrderParams, peer?: Peer): Promise<CreatedOrder> {
    if (this.draining) throw new RpcError("daemon_draining", "the daemon is draining for an update; retry after it restarts");
    const from: Party = peer?.meta.party ?? { id: `cli:${ulid()}`, address: `${p.as ?? "cli"}@${this.host}`, host: this.host };
    const parent = p.parentOrderId ? this.knownOrders.get(p.parentOrderId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_ORDER_DEPTH) throw new RpcError("too_deep", `order depth ${depth} exceeds ${MAX_ORDER_DEPTH}`);

    // Follow-up: continue an existing Thread.
    let prior: ThreadMeta | undefined;
    if (p.threadId) {
      prior = this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
      if (!prior) throw new RpcError("not_found", `unknown thread ${p.threadId}`);
      const open = [...this.tracking.values()].find((x) => x.order.threadId === p.threadId && x.status === "open");
      if (open) {
        if (!p.replace) {
          throw new RpcError(
            "thread_busy",
            `the previous question in this thread is still open; wait, run \`cafe cancel ${p.threadId}\`, or pass replace: true to ask anyway`,
          );
        }
        // The person gave up on the stuck Order; record that instead of leaving it open forever (#60).
        this.emitEvent(open.order, { type: "order.cancelled", by: "replaced" });
        this.close(open, "cancelled");
      }
    }
    const threadId = prior?.threadId ?? ulid();
    // Blobs were uploaded to this daemon before the Order; move them into the Thread now.
    const attachments = p.attachments?.length ? this.commitAttachments(p.attachments, threadId) : undefined;
    const order: Order = {
      orderId: ulid(),
      threadId,
      kind: p.kind,
      from,
      // A registered Agent asking through the protocol is relaying on someone's behalf.
      origin: p.origin ?? (peer?.meta.party ? "agent" : "human"),
      via: p.via ?? (peer?.meta.party ? { id: peer.meta.party.id, address: peer.meta.party.address } : undefined),
      to: p.to,
      body: p.body,
      ...(attachments?.length ? { attachments } : {}),
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

    const decision = await this.route(order, answeredBefore, p.broadcast ?? false);
    t.decision = decision;
    t.candidates = [...decision.candidates];
    this.emitEvent(order, { type: "order.routed", decision });
    if (decision.targets.length === 0) {
      this.emitEvent(order, { type: "order.failed", reason: "no barista available" });
      this.close(t, "failed");
      return { orderId: order.orderId, threadId: order.threadId, decision };
    }
    for (const id of decision.targets) this.dispatch(t, id);
    // Every Order gets an upper bound (#60). Heartbeats prove the Barista is alive, not that it will
    // answer: without a deadline a queued unicast Order left `cafe ask` hanging indefinitely.
    // A notice is fire-and-forget and only needs to be collected, not answered.
    if (order.kind === "notice" || decision.mode !== "unicast") {
      t.deadline = setTimeout(() => this.finishOnDeadline(t), order.deadlineMs ?? this.timing.broadcastDeadlineMs);
    } else {
      t.deadline = setTimeout(() => this.finishOnDeadline(t), order.deadlineMs ?? this.timing.unicastDeadlineMs);
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
    for (const env of this.store.readEventsTail(meta.file, 200)) {
      const ev = env.event;
      if (ev.type === "order.created") out.push({ from: ev.order.from.address, role: "customer", text: ev.order.body.slice(0, 4000) });
      else if (ev.type === "order.replied" && ev.final) out.push({ from: this.registry.get(ev.agentId)?.address ?? ev.agentId, role: "barista", text: ev.text.slice(0, 4000) });
    }
    return out.slice(-12);
  }

  private async route(order: Order, answeredBefore: string[] = [], broadcast = false): Promise<RoutingDecision> {
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
      const ids = this.registry.resolve(this.normalizeAddress(order.to)).filter((id) => candidates.some((c) => c.agentId === id));
      return {
        targets: ids,
        mode: ids.length === 1 ? "unicast" : "multicast",
        reason: ids.length ? `explicit address ${order.to}` : `no online barista at ${order.to}`,
        router: "explicit",
        candidates: [],
      };
    }
    if (broadcast) {
      return {
        targets: candidates.map((c) => c.agentId),
        mode: "broadcast",
        reason: "customer asked everyone",
        router: "explicit",
        candidates: [],
      };
    }
    await this.routerReady();
    if (this.router.name === "rules" && this.config.router.fallback === "root" && !this.isRoot && this.rootOnline) {
      try {
        return await this.uplink!.request<RoutingDecision>(Methods.routeDecide, { order, candidates: candidates.map((c) => c.agentId), broadcast }, 60_000);
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
    this.deliver(this.forTarget(t.order, agentId, t.decision?.variants ?? t.order.variants), agentId);
  }

  /**
   * The Order one target receives. A multicast that the router split into sub-questions (v4-7 #39)
   * sends only that target's own text and never carries the other halves: `variants` is stripped so
   * a Barista's prompt cannot leak another target's question. The recorded Order keeps `body`.
   */
  private forTarget(order: Order, agentId: string, variants: Record<string, string> | undefined): Order {
    if (!variants) return order;
    const { variants: _drop, ...rest } = order;
    return { ...rest, body: variants[agentId] ?? order.body };
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
    const stored = this.peerUrls.get(host);
    if (!stored) return Promise.reject(new Error(`no address for ${host}`));
    const attempt = this.resolveDaemonUrl(stored).then((url) => new Promise<Peer>((resolve, reject) => {
      // On a TLS network `url` is always `wss://` (a plaintext address was upgraded above); the pin is
      // keyed by the TLS endpoint dialled, like the uplink's.
      const ws = new WebSocket(`${url}/ws`, this.linkOptions(url.replace(/^wss?:\/\//, "")));
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
          await peer.request(Methods.initialize, { protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, kind: "peer", token: this.config.token, host: this.host, url: this.url() });
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
    })).finally(() => this.linking.delete(host));
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
    this.backfill.set(threadId, Date.now());
    this.saveBackfill();
  }

  private saveBackfill(): void {
    // Both keys: an older release reads `backfill` as a list of ids.
    this.store.setKv("backfill", [...this.backfill.keys()]);
    this.store.setKv("backfillSince", Object.fromEntries(this.backfill));
  }

  /**
   * After reconnecting: give the Root the Threads it missed while we went direct — only the events
   * since the outage began (with a margin for clock skew between Hosts), in bounded batches (#31).
   */
  private async flushBackfill(): Promise<void> {
    for (const [id, since] of [...this.backfill]) {
      if (!this.rootOnline) return;
      const meta = this.metas.get(id) ?? this.store.getThread(id);
      try {
        if (meta) {
          const events = since ? this.store.readEventsSince(meta.file, since - BACKFILL_SKEW_MS) : this.store.readEvents(meta.file);
          for (let i = 0; i < events.length; i += BACKFILL_BATCH) {
            await this.uplink!.request(Methods.threadBackfill, { events: events.slice(i, i + BACKFILL_BATCH) }, 30_000);
          }
        }
        this.backfill.delete(id);
        this.saveBackfill();
      } catch (err) {
        this.log(`backfill of ${id} failed: ${(err as Error).message}`);
        return;
      }
    }
  }

  private deliverLocal(order: Order, agentId: string): void {
    const peer = this.agents.get(agentId);
    if (!peer) return this.relayFailure(order, agentId, "agent not connected");
    const foreign = (order.attachments ?? []).some((a) => a.host && a.host !== this.host);
    if (!foreign) return this.notifyLocal(order, agentId, peer);
    // The origin may be another Host: fetch the blobs before the Barista starts.
    const t = this.tracking.get(order.orderId);
    if (t) this.clearTimer(t, agentId);
    void this.pullAndDeliver(order, agentId, peer);
  }

  private async pullAndDeliver(order: Order, agentId: string, peer: Peer): Promise<void> {
    try {
      await this.pullAttachments(order);
    } catch (err) {
      this.log(`attachment pull failed for ${order.orderId}: ${(err as Error).message}`);
      this.relayFailure(order, agentId, `attachment_unavailable: ${(err as Error).message}`);
      return;
    }
    this.notifyLocal(order, agentId, peer);
    const t = this.tracking.get(order.orderId);
    if (t && order.kind === "order") this.armAck(t, agentId);
  }

  private notifyLocal(order: Order, agentId: string, peer: Peer): void {
    peer.notify(Methods.orderDeliver, { order, attachmentPaths: this.attachmentPaths(order) });
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
          // In a fan-out, one good answer is enough: give the others a short
          // grace window instead of holding the Thread to the deadline (#39).
          if (t.decision?.mode !== "unicast" && !t.grace && this.hasPending(t)) {
            t.grace = setTimeout(() => this.finishGrace(t), this.timing.graceMs);
          }
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

  private hasPending(t: Tracking): boolean {
    for (const s of t.targets.values()) if (s === "pending" || s === "acked") return true;
    return false;
  }

  /** The grace window expired: keep the answer, mark the silent targets as skipped. */
  private finishGrace(t: Tracking): void {
    if (t.status !== "open") return;
    t.grace = undefined;
    for (const [id, s] of t.targets) {
      if (s !== "pending" && s !== "acked") continue;
      this.clearTimer(t, id);
      t.targets.set(id, "done");
      // Reuses the decline event with `unavailable`, so it is auditable and does
      // not count against the Barista in routing hints.
      this.emitEvent(t.order, { type: "order.declined", agentId: id, reason: "skipped: another Barista answered first", unavailable: true }, { skipTrack: true });
    }
    this.maybeClose(t);
  }

  private finishOnDeadline(t: Tracking): void {
    if (t.status !== "open") return;
    if (t.order.kind === "notice") return this.close(t, "done");
    // A deadline is final: unlike an a refusal, there is no time left to try the next candidate.
    for (const [id, s] of t.targets) {
      if (s !== "pending" && s !== "acked") continue;
      this.clearTimer(t, id);
      t.targets.set(id, "failed");
      this.emitEvent(t.order, { type: "order.failed", agentId: id, reason: "deadline", unavailable: true }, { skipTrack: true });
    }
    this.maybeClose(t);
  }

  private close(t: Tracking, status: "done" | "failed" | "cancelled"): void {
    if (t.status !== "open") return;
    t.status = status;
    for (const timer of t.timers.values()) clearTimeout(timer);
    t.timers.clear();
    if (t.deadline) clearTimeout(t.deadline);
    if (t.grace) clearTimeout(t.grace);
    t.grace = undefined;
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

  /**
   * Controlled-update drain (#27): refuse new Orders and wait for the Orders
   * this daemon originated to finish. Whatever is still open after `timeoutMs`
   * is returned as retryable, never silently dropped. The daemon stays drained
   * until it restarts.
   */
  async drain(timeoutMs = 30_000): Promise<{ waitedMs: number; openThreads: number; retryable: string[] }> {
    this.draining = true;
    const start = Date.now();
    const open = () => [...this.tracking.values()].filter((t) => t.status === "open");
    while (Date.now() - start < timeoutMs && open().length) await new Promise((r) => setTimeout(r, 200));
    const still = open();
    return { waitedMs: Date.now() - start, openThreads: still.length, retryable: [...new Set(still.map((t) => t.order.threadId))] };
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Reply on behalf of a target Barista over HTTP (v4-1 phase 2: `cafe reply`).
   * The caller must name an agent that is actually a target of the open Order;
   * the daemon commits any staged blobs before recording the reply.
   */
  replyAs(threadId: string, p: { orderId?: string; agent: string; text: string; final?: boolean; attachments?: Attachment[] }): {} {
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!meta) throw new RpcError("not_found", `unknown thread ${threadId}`);
    const orderId = p.orderId ?? meta.orderId;
    const t = this.tracking.get(orderId);
    if (!t || t.status !== "open" || t.order.threadId !== threadId) throw new RpcError("not_open", `order ${orderId} is not open on this daemon`);
    const ids = this.registry.resolve(this.normalizeAddress(p.agent)).filter((id) => t.targets.has(id));
    if (!ids.length) throw new RpcError("bad_request", `${p.agent} is not a target of this order`);
    const attachments = p.attachments?.length ? this.commitAttachments(p.attachments, threadId) : undefined;
    this.emitEvent(t.order, {
      type: "order.replied",
      agentId: ids[0]!,
      text: p.text,
      final: p.final ?? true,
      ...(attachments?.length ? { attachments } : {}),
    });
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
  /** Cheap counters for /api/health (dogfooding probes, #31/#34): since this Daemon started. */
  /** When this daemon process started (ms); the *SinceStart metrics count from here. */
  readonly startedAt = Date.now();
  private stats = { events: 0, appendBytes: 0, metaWrites: 0, metaBytes: 0, snapshotMs: 0, searchMs: 0 };
  private loopLagMs = 0;
  /** Cost of the last routing-hint recompute, for /api/health (#68). */
  private hintMs = 0;
  private hintRows = 0;
  /** Live SSE/WebSocket clients, maintained by the server (#70). */
  readonly streamCounts = { sse: 0, ws: 0 };
  private lagTimer?: ReturnType<typeof setInterval>;
  private leafTimer?: ReturnType<typeof setInterval>;
  private enrolTimer?: ReturnType<typeof setTimeout>;

  /**
   * Reissue the leaf while running, once it is inside the renewal window (v4-6 §5 B). Called on a
   * timer and safe to call repeatedly: the renewal path is idempotent when the leaf is still fresh
   * only if the caller guards; here we always ask the issuer, and `ensureLeaf`-style freshness is
   * checked by the caller before invoking `renew`.
   */
  startLeafRenewalCheck(needsRenewal: () => boolean): void {
    clearInterval(this.leafTimer);
    let lastError: string | undefined;
    this.leafTimer = setInterval(() => {
      if (!this.tlsContext?.renew || !needsRenewal()) return;
      void this.tlsContext
        .renew()
        .then(() => {
          lastError = undefined;
          this.log(`tls: leaf renewed (names: ${this.desiredSans().join(", ")})`);
        })
        .catch((err) => {
          // A child whose Root is unreachable retries every tick; say so once, not every few minutes.
          const why = (err as Error).message;
          if (why !== lastError) this.log(`tls: leaf renewal failed (retrying): ${why}`);
          lastError = why;
        });
    }, this.timing.leafCheckIntervalMs);
    this.leafTimer.unref?.();
  }

  /**
   * Retry CA enrolment while this Host is waiting to join the TLS network (v4-6 §3.3, §10.3): the Root
   * may have been offline at boot, or not reachable yet. Backs off from `enrolRetryBaseMs` to
   * `enrolRetryMaxMs` — a Root coming up should be noticed in seconds, not on the 6-hour leaf tick.
   * Until it succeeds the Host does not dial its Root (no plaintext fallback).
   */
  startEnrolmentRetry(): void {
    clearTimeout(this.enrolTimer);
    let delay = this.timing.enrolRetryBaseMs;
    const attempt = () => {
      if (this.stopped || !this.tlsContext?.enrol || this.tlsContext.network) return;
      void this.tlsContext
        .enrol()
        .then(() => {
          this.tlsWaiting = undefined;
          this.waitingLogged = false;
          this.log(`tls: joined the network (ca ${this.tlsContext?.caFingerprint})`);
          // Our own address now names the TLS endpoint; tell the UIs (and, via the uplink, the Root).
          this.emitDaemons();
        })
        .catch((err) => {
          const reason = (err as Error).message;
          if (reason !== this.tlsWaiting) this.log(`tls: waiting to join the network: ${reason}`);
          this.tlsWaiting = reason;
          if (this.stopped) return;
          this.enrolTimer = setTimeout(attempt, delay);
          this.enrolTimer.unref?.();
          delay = Math.min(this.timing.enrolRetryMaxMs, delay * 2);
        });
    };
    attempt();
  }

  /** Append to the Thread's JSONL, keeping the byte counters for /api/health. */
  private appendEvent(file: string, env: ThreadEnvelope): void {
    this.stats.appendBytes += this.store.appendEvent(file, env);
    this.stats.events++;
  }

  /** Write Thread metadata, keeping the write counters for /api/health. */
  private writeMeta(meta: ThreadMeta): void {
    this.stats.metaBytes += this.store.putThread(meta);
    this.stats.metaWrites++;
  }

  /** Sample event-loop delay so a busy daemon is visible without a profiler. */
  private startLagSampler(): void {
    this.lagTimer = setInterval(() => {
      const started = performance.now();
      setImmediate(() => {
        this.loopLagMs = performance.now() - started;
      });
    }, 500);
    this.lagTimer.unref?.();
  }

  /** Snapshot of the counters exposed at GET /api/health. */
  metrics(): {
    threads: number;
    events: number;
    appendBytes: number;
    metaWrites: number;
    metaBytes: number;
    snapshotMs: number;
    searchMs: number;
    eventLoopLagMs: number;
    cachedThreads: number;
    cachedOrders: number;
    indexedEvents: number;
    hintMs: number;
    hintRows: number;
    threadListeners: number;
    subscribedThreads: number;
    sseClients: number;
    wsClients: number;
    eventsSinceStart: number;
    appendBytesSinceStart: number;
    metaWritesSinceStart: number;
    metaBytesSinceStart: number;
    threadsTotal: number;
    indexedEventsTotal: number;
    lastSnapshotMs: number;
    lastSearchMs: number;
  } {
    const threads = this.store.countThreads();
    const indexed = this.store.countIndexed();
    return {
      // Scoped names (#86): *SinceStart reset when the daemon restarts (see startedAt in /api/health),
      // *Total are what the database holds, last* time the most recent operation. The unscoped
      // names below are the same values, kept for one release for existing readers.
      eventsSinceStart: this.stats.events,
      appendBytesSinceStart: this.stats.appendBytes,
      metaWritesSinceStart: this.stats.metaWrites,
      metaBytesSinceStart: this.stats.metaBytes,
      threadsTotal: threads,
      indexedEventsTotal: indexed,
      lastSnapshotMs: this.stats.snapshotMs,
      lastSearchMs: this.stats.searchMs,
      threads,
      ...this.stats,
      eventLoopLagMs: this.loopLagMs,
      cachedThreads: this.metas.size,
      cachedOrders: this.knownOrders.size,
      indexedEvents: indexed,
      hintMs: Math.round(this.hintMs * 100) / 100,
      hintRows: this.hintRows,
      threadListeners: this.listenerCount("thread"),
      subscribedThreads: this.subscribers.size,
      sseClients: this.streamCounts.sse,
      wsClients: this.streamCounts.ws,
    };
  }

  /** Pending metadata writes, coalesced so a burst of events does not rewrite a growing row each time. */
  private metaFlush = new Map<string, ReturnType<typeof setTimeout>>();
  private scheduleMeta(meta: ThreadMeta): void {
    if (this.metaFlush.has(meta.threadId)) return;
    const timer = setTimeout(() => {
      this.metaFlush.delete(meta.threadId);
      const latest = this.metas.get(meta.threadId);
      if (latest) this.writeMeta(latest);
    }, 150);
    timer.unref?.();
    this.metaFlush.set(meta.threadId, timer);
  }

  private flushMetas(): void {
    for (const [threadId, timer] of this.metaFlush) {
      clearTimeout(timer);
      const meta = this.metas.get(threadId);
      if (meta) this.writeMeta(meta);
    }
    this.metaFlush.clear();
  }

  /**
   * Keep the in-memory caches bounded on a long-running Daemon (#31). Closed Threads are
   * re-read from SQLite on demand, so evicting them costs one row read, not correctness.
   */
  private evictCaches(): void {
    const metaMax = META_CACHE_MAX();
    if (metaMax > 0 && this.metas.size > metaMax) {
      const keep = metaMax / 2;
      const victims = [...this.metas.values()]
        .filter((m) => m.status === "done" || m.status === "failed" || m.status === "cancelled")
        .sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0))
        .slice(0, Math.max(0, this.metas.size - keep));
      for (const m of victims) {
        if (this.metaFlush.has(m.threadId)) continue;
        this.metas.delete(m.threadId);
      }
    }
    const ordersMax = KNOWN_ORDERS_MAX();
    if (ordersMax > 0 && this.knownOrders.size > ordersMax) {
      // Map preserves insertion order: drop the oldest half.
      const drop = this.knownOrders.size - ordersMax / 2;
      let i = 0;
      for (const id of this.knownOrders.keys()) {
        if (i++ >= drop) break;
        this.knownOrders.delete(id);
      }
    }
  }

  recordEvent(env: ThreadEnvelope, opts: { skipTrack?: boolean; from?: Peer } = {}): void {
    if (this.stopped || this.seen.has(env.eventId)) return;
    this.seen.add(env.eventId);
    if (this.seen.size > 50_000) this.seen = new Set([...this.seen].slice(-25_000));

    const meta = this.updateMeta(env);
    // Keep `cafe search` current without rescanning JSONL (#34); the index is best-effort.
    try {
      this.store.indexEvent(env, (id) => this.registry.get(id)?.address ?? id);
    } catch (err) {
      this.log(`search index: ${(err as Error).message}`);
    }
    // Attachments live on their origin Host. Elsewhere they are metadata only,
    // but the row is needed so the local Web/CLI can proxy the download.
    const carried = env.event.type === "order.created" ? env.event.order.attachments : env.event.type === "order.replied" ? env.event.attachments : undefined;
    for (const a of carried ?? []) {
      if (!a.host || a.host === this.host || this.store.getArtifact(a.id)) continue;
      this.store.putArtifact({ id: a.id, threadId: env.threadId, host: a.host, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, createdAt: env.at });
    }
    // The Customer's own daemon pulls reply/order blobs in the background, so a
    // download still works after the origin Host goes offline again.
    if (meta?.from.host === this.host) for (const a of carried ?? []) this.enqueuePull(a, env.threadId);
    if (meta) {
      this.appendEvent(meta.file, env);
      // Thread creation / closure is durable immediately; heartbeats and interim events can wait.
      if (env.event.type === "order.created" || env.event.type === "order.closed") {
        const pending = this.metaFlush.get(meta.threadId);
        if (pending) clearTimeout(pending);
        this.metaFlush.delete(meta.threadId);
        this.writeMeta(meta);
      } else {
        this.scheduleMeta(meta);
      }
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
    // Grouped in SQL (#68): pulling every row of the last week into JS blocked the event loop for a
    // quarter second on a busy Root, every 30 seconds, whether or not anything had changed.
    const started = performance.now();
    const rows = this.store.outcomeSummary(now - HINT_WINDOW_MS);
    this.localHints = hintsFromSummary(rows, now);
    this.hintMs = performance.now() - started;
    this.hintRows = rows.length;
    this.localHintsAt = now;
    this.hintsDirty = false;
    return this.localHints;
  }

  /** Hints by identity: the Root's network-wide view while it is online, else our own. */
  routingHints(): Record<string, RoutingHint> {
    if (!this.isRoot && this.rootOnline && this.rootHints) return this.rootHints;
    return this.ownHints();
  }

  /** Recent routing mix, fan-out and response timings from Thread metadata (no JSONL scan). */
  routingStats(limit = 200) {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
    return computeRoutingStats(this.store.listThreads(n));
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
    this.appendEvent(meta.file, env);
    this.writeMeta(meta);
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
        ...(ev.order.origin ? { origin: ev.order.origin } : {}),
        ...(ev.order.via ? { via: ev.order.via } : {}),
        targets: [],
        status: "routing",
        summary: summarize(ev.order.body),
        summaryTurn: ev.order.turn,
        createdAt: ev.order.createdAt,
        file: this.store.threadFile(env.threadId, ev.order.createdAt),
        turns: 0,
        replies: [],
        declines: [],
      };
    }
    this.metas.set(env.threadId, meta);
    meta.lastActivityAt = env.at;
    this.evictCaches();
    const addr = (id: string) => this.registry.get(id)?.address;
    if (ev.type === "order.created") {
      this.knownOrders.set(ev.order.orderId, ev.order);
      // A new turn: the Thread now reflects this Order. The title stays on the
      // first question so a multi-turn Thread is still recognisable in list views.
      if (ev.order.orderId !== meta.orderId || meta.turns === 0) {
        const firstTurn = meta.turns === 0;
        meta.orderId = ev.order.orderId;
        meta.turns = Math.max(meta.turns + 1, ev.order.turn);
        if (firstTurn) {
          meta.summary = summarize(ev.order.body);
          meta.summaryTurn = ev.order.turn;
        }
        for (const a of ev.order.attachments ?? []) {
          const list = (meta.attachments ??= []);
          if (list.length < MAX_META_ATTACHMENTS && !list.some((x) => x.id === a.id)) list.push(a);
        }
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
        if (ev.final) pushBounded(meta.replies, { agentId: ev.agentId, address: addr(ev.agentId), text: ev.text.slice(0, 600), at: env.at }, MAX_META_REPLIES);
        break;
      case "order.declined":
        pushBounded(meta.declines, { agentId: ev.agentId, address: addr(ev.agentId), reason: ev.reason.slice(0, 300), at: env.at }, MAX_META_DECLINES);
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
    for (const meta of this.store.openThreads(1000)) {
      if (meta.status === "done" || meta.status === "failed" || meta.status === "cancelled") continue;
      // The latest Order only, read from the end of the Thread (#31).
      const events = this.store.readOrderEvents(meta.file, meta.orderId);
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
    const override = this.config.hostNames[host];
    const displayName = override?.displayName ?? p.displayName ?? host;
    const aliases = [...new Set([...(p.aliases ?? []), ...(override?.aliases ?? [])])];
    const legacyAliases = [...new Set([...(p.legacyAliases ?? []), ...(override?.legacyAliases ?? [])])];
    this.daemonRecords.set(host, { host, hostId: host, displayName, aliases, legacyAliases, url: p.url ?? "", isRoot: false, online: true, connectedAt: now, lastSeenAt: now, version: p.cafeVersion });
    if (p.cafeVersion && p.cafeVersion !== this.version) this.log(`daemon ${host} runs cafe ${p.cafeVersion}; this root runs ${this.version}`);
    if (p.url) this.reportedUrls.set(host, p.url);
    if (p.url) void this.rememberChildUrl(host, p.url);
    peer.on(Methods.hostIdentity, (x: { displayName?: string; aliases?: string[]; removeAliases?: string[]; legacyAliases?: string[] }) => {
      const rec = this.daemonRecords.get(host);
      if (rec) {
        if (x.displayName) rec.displayName = x.displayName;
        if (x.removeAliases?.length) rec.aliases = rec.aliases.filter((a) => !x.removeAliases!.includes(a));
        if (x.aliases) rec.aliases = [...new Set([...rec.aliases, ...x.aliases])];
        if (x.legacyAliases) rec.legacyAliases = [...new Set([...(rec.legacyAliases ?? []), ...x.legacyAliases])];
        this.emitDaemons();
      }
      return {};
    });
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
      // Only the Root's events from that window can repeat these (#31): read the tail back to there.
      const from = Math.min(...x.events.map((e) => e.at)) - BACKFILL_SKEW_MS;
      const known = new Set(meta ? this.store.readEventsSince(meta.file, from).map((e) => e.eventId) : []);
      for (const env of x.events) if (!known.has(env.eventId)) this.recordEvent(env, { from: peer, skipTrack: true });
      return {};
    });
    peer.on(Methods.routeDecide, async (x: { order: Order; candidates: string[]; broadcast?: boolean }) => {
      const cands = x.candidates.map((id) => this.registry.get(id)).filter((r): r is AgentRecord => !!r);
      await this.routerReady();
      return this.router.decide({ order: x.order, candidates: cands, hints: this.hintsFor(cands), broadcast: x.broadcast });
    });
    this.emitDaemons();
    this.log(`daemon ${host} connected (${p.url})`);
    // Send snapshot after the initialize response.
    queueMicrotask(() => {
      peer.notify(Methods.registrySnapshot, { version: this.registry.version, records: this.registry.all() });
      this.pushHints(peer);
    });
    return { protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, host: this.host, isRoot: true, registryVersion: this.registry.version };
  }

  /**
   * Root: remember a child's dial-back address only after a short probe. A child
   * in Docker/NAT often reports a container-internal IP that is unreachable from
   * the Root; writing it would poison `knownDaemons` and announceRoot forever.
   */
  private async rememberChildUrl(host: string, url: string): Promise<{ verified: boolean; error?: string; code?: string }> {
    if (this.config.knownDaemons[host] === url) return { verified: true };
    try {
      // Remember the address in the form it is dialled: a pin on a TLS network becomes `wss://` (#92).
      url = await this.resolveDaemonUrl(url);
      if (this.config.knownDaemons[host] === url) return { verified: true };
      const res = await this.daemonFetch(`${url.replace(/^ws/, "http")}/api/health`, {
        headers: { authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        const error = res.status === 401 ? "unauthorized: the hosts use different tokens" : `HTTP ${res.status}`;
        this.log(`not saving ${host} address ${url}: ${error}`);
        return { verified: false, error, code: res.status === 401 ? "UNAUTHORIZED" : `HTTP_${res.status}` };
      }
    } catch (err) {
      const why = describeFetchError(err, url.replace(/^wss?:\/\//, ""));
      this.log(`not saving ${host} address ${url}: not reachable from the Root (${why.error}); set advertise on ${host} if the Root must dial back`);
      return { verified: false, ...why };
    }
    if (this.config.knownDaemons[host] === url) return { verified: true };
    this.config.knownDaemons[host] = url;
    saveConfig(this.config, this.store.home);
    this.log(`known daemon ${host} -> ${url}`);
    // Children only learn verified addresses (#75); now that this one is verified, share it.
    this.emitDaemons();
    return { verified: true };
  }

  /** Root: after moving to a new address, tell every known Daemon where it is now. */
  async announceRoot(): Promise<void> {
    if (!this.isRoot) return;
    const me = this.mainAddress();
    const targets = Object.entries(this.config.knownDaemons).filter(([host]) => !this.children.has(host));
    // Probe in parallel: one dead Daemon must not delay the others.
    const worker = async () => {
      for (let next = targets.shift(); next; next = targets.shift()) {
        const [host, url] = next;
        try {
          const res = await this.daemonFetch(`${await this.httpBase(url)}/api/root`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
            body: JSON.stringify({ root: me }),
            signal: AbortSignal.timeout(1500),
          });
          this.log(`announced root to ${host}: ${res.status}`);
        } catch (err) {
          this.log(`announce to ${host} failed: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  }

  // -------------------------------------------------------------------------
  // Child side: uplink to the Root
  // -------------------------------------------------------------------------

  connectRoot(): void {
    if (this.isRoot || !this.config.root || this.stopped) return;
    // Fail-closed (v4-6 §10.3, #79): a TLS Host that has not enrolled the network CA does not dial its
    // Root at all — a plaintext uplink is exactly the downgrade TLS exists to prevent. The enrolment
    // retry reconnects once it succeeds.
    if (this.tlsContext && !this.tlsContext.network) {
      if (!this.waitingLogged) this.log(`tls: not connecting to root ${this.config.root} until this Host joins the TLS network (${this.tlsWaiting ?? "enrolling"})`);
      this.waitingLogged = true;
      return;
    }
    const gen = ++this.dialGen;
    void this.dialRoot(this.config.root, gen);
  }

  private dialGen = 0;
  private waitingLogged = false;

  private async dialRoot(target: string, gen: number): Promise<void> {
    let url: string;
    try {
      // `root:` is the Root's main address; on a TLS network this finds its TLS endpoint (v4-6 §10.3).
      url = await this.resolveDaemonUrl(target);
    } catch (err) {
      if (gen !== this.dialGen || this.stopped) return;
      this.log(`cannot reach root ${target}: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    // A newer dial (setRoot, a reconnect) superseded this one while we were resolving.
    if (gen !== this.dialGen || this.stopped || this.config.root !== target) return;
    let ws: WebSocket;
    try {
      // Pin the Root's leaf by the TLS `host:port` this Host dials (v4-6 §5 A).
      ws = new WebSocket(`${url}/ws`, this.linkOptions(url.replace(/^wss?:\/\//, "")));
    } catch (err) {
      // A persisted bad address must not crash the daemon on every boot (#76): say so and keep
      // retrying at the normal backoff, so `cafe root set` can still repair it later.
      this.log(`cannot dial root '${target}': ${(err as Error).message}; fix it with \`cafe root set <host:port>\``);
      this.scheduleReconnect();
      return;
    }
    this.uplinkSocket = ws;
    const peer = new Peer(ws);
    ws.on("open", async () => {
      try {
        const hello = await peer.request<{ host: string; displayName?: string; aliases?: string[]; cafeVersion?: string }>(Methods.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          cafeVersion: this.version,
          kind: "daemon",
          token: this.config.token,
          host: this.host,
          displayName: this.displayName,
          aliases: this.hostAliases,
          url: this.url(),
          registryVersion: this.registry.version,
        });
        this.uplink = peer;
        this.bindAgentMethods(peer); // the Root may relay agent/rename down this connection
        this.rootHost = hello.host;        this.rootVersion = hello.cafeVersion;
        this.rootDisplayName = hello.displayName;
        this.store.setKv("rootHost", hello.host);
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
    peer.on(Methods.hostIdentity, (x: { displayName?: string; aliases?: string[]; removeAliases?: string[]; legacyAliases?: string[] }) => {
      if (x.displayName) {
        this.displayName = x.displayName;
        this.config.displayName = x.displayName;
      }
      if (x.removeAliases?.length) {
        this.hostAliases = this.hostAliases.filter((a) => !x.removeAliases!.includes(a));
        this.config.aliases = this.hostAliases;
      }
      if (x.aliases) {
        this.hostAliases = [...new Set([...this.hostAliases, ...x.aliases])];
        this.config.aliases = this.hostAliases;
      }
      if (x.legacyAliases) {
        this.hostLegacyAliases = [...new Set([...this.hostLegacyAliases, ...x.legacyAliases])];
        this.config.legacyAliases = this.hostLegacyAliases;
      }
      saveConfig(this.config, this.store.home);
      const self = this.daemonRecords.get(this.host);
      if (self) {
        self.displayName = this.displayName;
        self.aliases = this.hostAliases;
        self.legacyAliases = this.hostLegacyAliases;
      }
      this.emitDaemons();
      return {};
    });
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
    const rec: DaemonRecord = this.daemonRecords.get("__root__") ?? { host: this.rootHost ?? "root", hostId: this.rootHost, aliases: [], legacyAliases: [], url: `ws://${this.config.root}`, isRoot: true, online, lastSeenAt: Date.now() };
    rec.online = online;
    if (this.rootHost) rec.host = this.rootHost;
    if (this.rootDisplayName) rec.displayName = this.rootDisplayName;
    if (online) rec.version = this.rootVersion;
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
    const clean = assertDaemonAddress(addr);
    this.config.root = clean;
    saveConfig(this.config, this.store.home);
    this.reconnectDelay = 0;
    const old = this.uplinkSocket;
    this.uplinkSocket = undefined;
    old?.close();
    this.uplink = undefined;
    this.connectRoot();
  }

  // -------------------------------------------------------------------------
  // Retention and search (docs/specs/v2-5-retention-search.md)
  // -------------------------------------------------------------------------

  /**
   * Finished threads and outcome stats older than `days`. `dryRun` (the default
   * for callers) only reports what would go; nothing is deleted without it off.
   */
  prune(days: number, dryRun: boolean): { dryRun: boolean; cutoff: number; threads: number; bytes: number; agentEvents: number; oldest?: number } {
    const cutoff = Date.now() - days * 24 * 3600_000;
    const open = new Set([...this.tracking.values()].filter((t) => t.status === "open").map((t) => t.order.threadId));
    const stale = this.store.staleThreads(cutoff).filter((m) => !open.has(m.threadId));
    const oldest = stale.reduce<number | undefined>((o, m) => (o === undefined || m.createdAt < o ? m.createdAt : o), undefined);
    if (dryRun) {
      let bytes = 0;
      for (const m of stale) {
        try {
          bytes += statSync(m.file).size;
        } catch {
          // file already gone
        }
      }
      return { dryRun, cutoff, threads: stale.length, bytes, agentEvents: this.store.countAgentEventsBefore(cutoff), oldest };
    }
    const bytes = this.store.deleteThreads(stale);
    this.store.deleteAgentSessions(stale.map((m) => m.threadId));
    for (const m of stale) {
      this.metas.delete(m.threadId);
      this.store.deleteArtifactsForThread(m.threadId);
      this.store.unindexThread(m.threadId);
      rmSync(join(this.store.home, "artifacts", m.threadId), { recursive: true, force: true });
    }
    const agentEvents = this.store.deleteAgentEventsBefore(cutoff);
    this.hintsDirty = true;
    this.log(`pruned ${stale.length} thread(s), ${agentEvents} stat row(s) older than ${days} day(s)`);
    return { dryRun, cutoff, threads: stale.length, bytes, agentEvents, oldest };
  }

  /** Plain substring search over questions and answers, newest threads first. Scans the JSONL files.
 * A scan longer than `budgetMs` returns what it found so far and marks `stats.truncated`. */
  search(
    q: string,
    limit = 20,
    opts: { budgetMs?: number; stats?: { scanned: number; elapsedMs: number; truncated: boolean } } = {},
  ): { meta: ThreadMeta; hits: { orderId: string; who: string; text: string; at: number }[] }[] {
    const started = performance.now();
    const fill = (scanned: number, truncated: boolean) => {
      const elapsedMs = performance.now() - started;
      this.stats.searchMs = elapsedMs;
      if (opts.stats) Object.assign(opts.stats, { scanned, elapsedMs, truncated });
    };
    if (!Number.isFinite(limit) || limit <= 0) {
      fill(0, false);
      return [];
    }
    const needle = q.toLowerCase();
    const budget = opts.budgetMs ?? 1_000;
    // Fast path: the FTS trigram index answers substring queries without touching the JSONL (#34).
    // Very short queries (below the trigram minimum) and any index failure fall back to the scan.
    if (needle.length >= 3) {
      try {
        const indexed = this.store.searchIndex(q, limit * 5);
        if (!indexed.short) {
          const byThread = new Map<string, { meta: ThreadMeta; hits: { orderId: string; who: string; text: string; at: number }[] }>();
          const seenEvents = new Set<string>();
          for (const h of indexed.hits) {
            const meta = this.metas.get(h.threadId) ?? this.store.getThread(h.threadId);
            if (!meta) continue;
            if (seenEvents.has(h.eventId)) continue;
            seenEvents.add(h.eventId);
            const entry = byThread.get(h.threadId) ?? { meta, hits: [] };
            const i = h.text.toLowerCase().indexOf(needle);
            const start = Math.max(0, i - 60);
            entry.hits.push({ orderId: h.orderId, who: h.who, at: h.at, text: i < 0 ? h.text.slice(0, 160) : `${start ? "…" : ""}${h.text.slice(start, i + needle.length + 100)}` });
            byThread.set(h.threadId, entry);
          }
          const out = [...byThread.values()].sort((a, b) => b.meta.createdAt - a.meta.createdAt).slice(0, limit);
          fill(byThread.size, false);
          return out;
        }
      } catch {
        // Fall through to the JSONL scan.
      }
    }
    const out: { meta: ThreadMeta; hits: { orderId: string; who: string; text: string; at: number }[] }[] = [];
    let scanned = 0;
    for (const meta of this.store.allThreads()) {
      scanned++;
      const hits: { orderId: string; who: string; text: string; at: number }[] = [];
      for (const env of this.store.readEvents(meta.file)) {
        const ev = env.event;
        const [who, text] =
          ev.type === "order.created" ? [ev.order.from.address, ev.order.body] : ev.type === "order.replied" ? [this.registry.get(ev.agentId)?.address ?? ev.agentId, ev.text] : [undefined, undefined];
        if (!text || !who) continue;
        const i = text.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        const start = Math.max(0, i - 60);
        hits.push({ orderId: env.orderId, who, at: env.at, text: `${start ? "…" : ""}${text.slice(start, i + needle.length + 100)}` });
      }
      if (hits.length) out.push({ meta, hits });
      if (out.length >= limit) break;
      if (performance.now() - started > budget) {
        fill(scanned, true);
        return out;
      }
    }
    fill(scanned, false);
    return out;
  }

  /**
   * Index Threads that predate the search index (#34). Runs a bounded batch at startup and a few more
   * times in the background so an upgraded daemon converges without blocking the event loop.
   */
  backfillSearchIndex(): void {
    const batch = 200;
    let rounds = 0;
    const run = () => {
      let todo: ThreadMeta[];
      try {
        todo = this.store.threadsNeedingIndex(batch);
      } catch {
        return;
      }
      if (!todo.length) return;
      const started = performance.now();
      const who = (id: string) => this.registry.get(id)?.address ?? id;
      for (const m of todo) {
        try {
          for (const env of this.store.readEvents(m.file)) this.store.indexEvent(env, who);
        } catch {
          // An unreadable Thread must not stop the backfill.
        }
      }
      this.log(`search index: backfilled ${todo.length} thread(s) in ${Math.round(performance.now() - started)}ms`);
      if (todo.length === batch && ++rounds < 20) setTimeout(run, 250).unref?.();
    };
    run();
  }

  /** Daily automatic pruning when `retention.days` is set. */
  private schedulePrune(): void {
    const days = this.config.retention.days;
    if (!days) return;
    const run = () => {
      try {
        this.prune(days, false);
      } catch (err) {
        this.log(`prune failed: ${(err as Error).message}`);
      }
    };
    this.pruneTimer = setTimeout(run, 60_000);
    this.pruneInterval = setInterval(run, 24 * 3600_000);
    this.pruneTimer.unref?.();
    this.pruneInterval.unref?.();
  }

  /** Pull-later queue: a Customer's daemon keeps trying until the origin Host is reachable again. */
  private schedulePulls(): void {
    for (const p of this.store.getKv<Array<{ a: Attachment; threadId: string }>>("pendingPulls") ?? []) {
      this.pendingPulls.set(`${p.threadId}:${p.a.id}`, p);
    }
    this.pullTimer = setInterval(() => void this.sweepPulls(), 30_000);
    this.pullTimer.unref?.();
  }

  private enqueuePull(a: Attachment, threadId: string): void {
    if (!a.host || a.host === this.host) return;
    const key = `${threadId}:${a.id}`;
    if (this.pendingPulls.has(key)) return;
    this.pendingPulls.set(key, { a, threadId });
    this.store.setKv("pendingPulls", [...this.pendingPulls.values()]);
  }

  async sweepPulls(): Promise<void> {
    for (const [key, p] of [...this.pendingPulls]) {
      try {
        await this.pullAttachment(p.a, p.threadId);
        this.pendingPulls.delete(key);
      } catch (err) {
        this.log(`attachment ${p.a.id} still waiting for ${p.a.host}: ${(err as Error).message}`);
      }
    }
    this.store.setKv("pendingPulls", [...this.pendingPulls.values()]);
  }

  /** Delete staged uploads that never became part of an Order (default: older than 24 h). */
  cleanStagedArtifacts(maxAgeMs = 24 * 3600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let bytes = 0;
    for (const a of this.store.stagedArtifacts(cutoff)) {
      const path = this.artifactPath(a);
      if (existsSync(path)) {
        bytes += statSync(path).size;
        rmSync(path, { force: true });
      }
    }
    this.store.deleteStagedArtifacts(cutoff);
    return bytes;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  daemons(): DaemonRecord[] {
    // Drop refusals nobody repeated for a day, and the records they alone created (#93).
    if (this.refusedPlaintext.size) this.refusals(Date.now(), false);
    // The listening port is only known after the server starts.
    const self = this.daemonRecords.get(this.host);
    if (self) {
      self.url = this.url();
      self.displayName = this.displayName;
      self.aliases = this.hostAliases;
    }
    // A hand-set address wins over what the Host reports about itself (#75): a child behind Docker
    // only knows an address nobody else can reach.
    for (const [host, addr] of Object.entries(this.config.pinnedDaemons)) {
      const rec = this.daemonRecords.get(host);
      if (rec && addr) rec.url = this.pinnedAddress(host)!;
    }
    return [...this.daemonRecords.values()];
  }

  private emitDaemons(): void {
    const list = this.daemons();
    this.emit("daemons", list);
    for (const ui of this.uis) ui.notify(Methods.daemonsChanged, list);
    // Children keep every Daemon's address so they can go direct while the Root is offline (ADR-0004).
    // Only addresses proven reachable from the Root are shared: a child behind Docker reports an
    // address nobody else can use, and broadcasting it broke every direct link once the Root was down (#75).
    if (this.isRoot) {
      const verified = list.map((d) => (d.host === this.host ? d : { ...d, url: this.verifiedAddress(d.host) ?? "" }));
      for (const child of this.children.values()) child.notify(Methods.daemonsChanged, verified);
    }
  }

  // -------------------------------------------------------------------------
  // Attachments (docs/specs/v4-1-attachments.md)
  // -------------------------------------------------------------------------

  attachmentLimits() {
    const a = this.config.attachments;
    return { maxBytes: a.maxMb * 1024 * 1024, threadMaxBytes: a.threadMaxMb * 1024 * 1024, maxCount: a.maxCount };
  }

  /** Keep the download name filesystem-safe; only the display name keeps the original. */
  static safeName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? "file";
    const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
    return safe || "file";
  }

  artifactPath(a: { id: string; name: string }, threadId?: string): string {
    return join(this.store.home, "artifacts", threadId ?? "_staging", `${a.id}-${Daemon.safeName(a.name)}`);
  }

  ensureArtifactDir(threadId?: string): string {
    const dir = join(this.store.home, "artifacts", threadId ?? "_staging");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A completed upload, before its Order exists. */
  registerStaged(input: { id: string; name: string; mime: string; size: number; sha256: string; uploader?: Party }): Attachment {
    const artifact: Attachment = { id: input.id, name: input.name, mime: input.mime, size: input.size, sha256: input.sha256, host: this.host };
    this.store.putArtifact({ id: input.id, name: input.name, mime: input.mime, size: input.size, sha256: input.sha256, host: this.host, createdAt: Date.now() });
    return input.uploader ? { ...artifact, uploader: input.uploader } : artifact;
  }

  /** Move staged blobs into the Thread's directory and return wire metadata. */
  commitAttachments(requested: Attachment[], threadId: string): Attachment[] {
    const limits = this.attachmentLimits();
    if (requested.length > limits.maxCount) throw new RpcError("too_many_attachments", `at most ${limits.maxCount} attachments per Order`);
    let total = this.store.artifactsForThread(threadId).reduce((n, a) => n + a.size, 0);
    // Validate everything first: a rejected Order must not leave half the blobs in the Thread.
    const staged = requested.map((req) => {
      const stored = this.store.getArtifact(req.id);
      if (!stored || stored.host !== this.host) throw new RpcError("bad_request", `unknown attachment ${req.id}`);
      if (stored.threadId && stored.threadId !== threadId) throw new RpcError("bad_request", `attachment ${req.id} belongs to another thread`);
      total += stored.size;
      if (total > limits.threadMaxBytes) throw new RpcError("attachment_too_large", "this Thread exceeds attachments.threadMaxMb");
      if (!stored.threadId && !existsSync(this.artifactPath(stored))) throw new RpcError("attachment_unavailable", `attachment ${req.id} is missing on this host`);
      return stored;
    });
    const committed: Attachment[] = [];
    for (const stored of staged) {
      if (!stored.threadId) {
        const to = this.artifactPath(stored, threadId);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(this.artifactPath(stored), to);
        this.store.putArtifact({ ...stored, threadId });
      }
      committed.push({ id: stored.id, name: stored.name, mime: stored.mime, size: stored.size, sha256: stored.sha256, host: stored.host });
    }
    return committed;
  }

  /** Local blob for an attachment, if this Host holds it. */
  readArtifact(id: string): { artifact: Attachment; path: string } | undefined {
    const stored = this.store.getArtifact(id);
    if (!stored) return undefined;
    const path = this.artifactPath(stored, stored.threadId);
    if (!existsSync(path)) return undefined;
    return { artifact: { id: stored.id, name: stored.name, mime: stored.mime, size: stored.size, sha256: stored.sha256, host: stored.host }, path };
  }

  /** Absolute path the Barista can open (same Host only). */
  private attachmentPaths(order: Order): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of order.attachments ?? []) {
      const found = this.readArtifact(a.id);
      if (found) out[a.id] = found.path;
    }
    return out;
  }

  artifactOrigin(host: string): string | undefined {
    if (host === this.host) return `http://127.0.0.1:${this.config.port}`;
    const d = this.daemons().find((x) => x.host === host || x.displayName === host || x.aliases.includes(host));
    const url = d?.url ?? this.peerUrls.get(host);
    return url?.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws$/, "");
  }

  /** Fetch missing blobs from their origin Host before the Barista is told about the Order. */
  async pullAttachments(order: Order): Promise<void> {
    for (const a of order.attachments ?? []) await this.pullAttachment(a, order.threadId);
  }

  /** Pull one remote attachment into this Thread's directory (also used by the pull-later queue). */
  async pullAttachment(a: Attachment, threadId: string): Promise<void> {
    if (!a.host || a.host === this.host) return;
    const existing = this.store.getArtifact(a.id);
    if (existing?.threadId === threadId && existsSync(this.artifactPath(existing, threadId))) return;
    const base = this.artifactOrigin(a.host);
    if (!base) throw new Error(`origin host ${a.host} is not known to this daemon`);
    const res = await fetch(`${base}/api/artifacts/${encodeURIComponent(a.id)}`, {
      headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`origin ${a.host} returned HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== a.size) throw new Error(`attachment ${a.id}: expected ${a.size} bytes, got ${bytes.length}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== a.sha256) throw new Error(`attachment ${a.id}: sha256 mismatch`);
    const path = this.artifactPath(a, threadId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    this.store.putArtifact({ id: a.id, threadId, host: a.host, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, createdAt: Date.now() });
  }

  /** What the running process is actually using (for `cafe config diff`); never includes the token. */
  runtimeConfig() {
    const running = {
      mode: this.isRoot ? "root" : "daemon",
      host: this.host,
      displayName: this.config.displayName,
      port: this.config.port,
      advertise: this.config.advertise,
      root: this.config.root,
      router: this.config.router,
      retention: this.config.retention,
      attachments: this.config.attachments,
      discovery: this.config.discovery,
      // Report the CA fingerprint actually in force, so a fingerprint enrolled automatically at
      // startup does not show as a pending change (the file still lags until the next save).
      security: { ...this.config.security, tls: { ...this.config.security.tls, caFingerprint: this.tlsContext?.caFingerprint ?? this.config.security.tls.caFingerprint } },
    };
    // Saved-but-not-applied values, so the CLI and Web can say "restart required"
    // without reading config.yml themselves.
    return { ...running, pending: diffConfig(loadConfig(this.store.home), running) };
  }

  /** Machine-level checks for the Web Settings page; the CLI doctor adds extension/skill checks. */
  doctor(webStale = false): { ok: boolean; checks: { name: string; level: "ok" | "warn" | "fail"; detail: string; next?: string }[] } {
    const checks: { name: string; level: "ok" | "warn" | "fail"; detail: string; next?: string }[] = [];
    checks.push({ name: "daemon", level: "ok", detail: `${this.host}${this.isRoot ? " (hub)" : ""}, ${this.daemons().length} machine(s) known` });

    const configured = this.config.router.model;
    if (!configured) checks.push({ name: "router", level: "ok", detail: "rules (no router.model configured)", next: "cafe config set router.model <provider/model>" });
    else if (this.routerLoading) checks.push({ name: "router", level: "warn", detail: `loading ${configured}; Orders wait for it`, next: "cafe doctor (again in a moment)" });
    else if (this.router.name !== "llm" || this.routerModel !== configured) {
      checks.push({ name: "router", level: "fail", detail: `configured ${configured}, running ${this.routerModel ?? this.router.name}${this.lastRouterError ? ` (${this.lastRouterError})` : ""}`, next: `cafe router set ${configured}` });
    } else checks.push({ name: "router", level: "ok", detail: `llm (${configured})` });

    if (this.isRoot) checks.push({ name: "root", level: "ok", detail: "this machine is the hub" });
    else if (this.rootOnline) checks.push({ name: "root", level: "ok", detail: `hub ${this.config.root ?? "discovered"} online` });
    else checks.push({ name: "root", level: "warn", detail: "hub offline; cross-machine orders use direct links", next: "cafe root test" });

    const pending = this.runtimeConfig().pending;
    const restart = pending.filter((p) => p.mode === "restart-required");
    const hot = pending.filter((p) => p.mode === "hot");
    if (restart.length) checks.push({ name: "config", level: "warn", detail: `restart required: ${restart.map((p) => p.key).join(", ")}`, next: "cafe daemon restart" });
    else if (hot.length) checks.push({ name: "config", level: "warn", detail: `hot changes not applied: ${hot.map((p) => p.key).join(", ")}`, next: "cafe config apply" });
    else checks.push({ name: "config", level: "ok", detail: "config.yml matches the running daemon" });

    if (webStale) checks.push({ name: "web", level: "warn", detail: "the build on disk is newer than the one served", next: "cafe daemon restart" });

    checks.push(this.tlsCheck());
    if (this.tlsContext) {
      const refused = this.refusals();
      const trying = refused.filter((r) => r.recent);
      const stopped = refused.filter((r) => !r.recent);
      const who = (list: typeof refused) => list.map((r) => `${r.host}${r.version ? ` (cafe ${r.version})` : ""}`).join(", ");
      const ago = (at: number) => `${Math.max(1, Math.round((Date.now() - at) / 60_000))}m ago`;
      checks.push(
        trying.length
          ? {
              name: "tls-links",
              level: "fail",
              detail: `refusing plaintext links from ${who(trying)}; they stay off the network until they connect over TLS${stopped.length ? ` (also refused earlier: ${stopped.map((r) => `${r.host} ${ago(r.at)}`).join(", ")})` : ""}`,
              next: "on each: upgrade cafe, cafe config set security.mode tls, cafe daemon restart",
            }
          : stopped.length
            ? {
                name: "tls-links",
                level: "warn",
                detail: `refused a plaintext link from ${stopped.map((r) => `${r.host}${r.version ? ` (cafe ${r.version})` : ""} ${ago(r.at)}`).join(", ")}; not tried since (forgotten after ${Math.round(this.timing.refusedForgetMs / 3_600_000) || 1} h)`,
                next: "nothing to do unless that machine should join: then on it, upgrade cafe, cafe config set security.mode tls, cafe daemon restart",
              }
          : { name: "tls-links", level: "ok", detail: "every Daemon link uses TLS" },
      );
    }

    // #82: a supervised Barista that gave up says why, instead of only failing in its own log.
    for (const w of this.supervisor?.list() ?? []) {
      if (w.state !== "failed") continue;
      checks.push({ name: "barista", level: "fail", detail: `${w.dir}#${w.slot} (${w.agent}) gave up: ${w.lastError?.split("\n")[0] ?? "it kept exiting"} — log: ${w.log}`, next: `cafe barista start --dir ${w.dir}${w.agent !== "pi" ? ` --agent ${w.agent}` : ""}` });
    }

    // #66: the log is capped, but a person should still hear about a file that keeps hitting the cap.
    try {
      const logPath = join(this.store.home, "daemon.log");
      if (existsSync(logPath) && statSync(logPath).size > 15 * 1024 * 1024) {
        checks.push({ name: "log", level: "warn", detail: `daemon.log is ${Math.round(statSync(logPath).size / 1024 / 1024)} MB; past versions are in daemon.log.1`, next: "cafe daemon restart" });
      }
    } catch {
      // no log yet
    }

    const offline = this.daemons().filter((d) => d.host !== this.host && !d.online);
    if (offline.length) checks.push({ name: "machines", level: "warn", detail: `offline: ${offline.map((d) => d.displayName ?? d.host).join(", ")}`, next: "cafe daemon status" });
    else checks.push({ name: "machines", level: "ok", detail: "every known machine is online" });

    return { ok: !checks.some((c) => c.level === "fail"), checks };
  }

  /** TLS state for `cafe doctor` (v4-6 §10.3, #81A): mode, port, network, leaf expiry and SAN. */
  private tlsCheck(): { name: string; level: "ok" | "warn" | "fail"; detail: string; next?: string } {
    const st = this.tlsStatus();
    if (st.mode === "plaintext") {
      return { name: "tls", level: "warn", detail: "TLS is off (security.mode: plaintext): traffic between machines is not encrypted", next: "cafe config set security.mode tls && cafe daemon restart" };
    }
    const port = st.port ? `:${st.port}` : "(no TLS port)";
    if (!st.network) {
      return {
        name: "tls",
        level: "fail",
        detail: `TLS on ${port}, but not on the network yet — not connecting to the hub until it is: ${st.waiting}`,
        next: /fingerprint/i.test(st.waiting ?? "") ? "cafe root show (on the hub) and compare the CA fingerprint" : "cafe root test",
      };
    }
    try {
      const leaf = new X509Certificate(this.tlsContext!.current().cert);
      const days = Math.floor((Date.parse(leaf.validTo) - Date.now()) / 86_400_000);
      // Every address another machine may dial, not just `advertise` (#91): a leaf missing the VPN
      // address passed this check while the child behind the VPN failed with "IP address mismatch".
      const missing = missingSans(this.tlsContext!.current().cert, this.desiredSans());
      const base = `on ${port}, ca ${st.caFingerprint?.slice(0, 11)}…, leaf valid ${days} more days`;
      if (days < 21) return { name: "tls", level: "warn", detail: `${base} (renews automatically within 21 days; renewal has not happened yet)`, next: "cafe daemon renew-cert" };
      if (missing.length) {
        return {
          name: "tls",
          level: "warn",
          detail: `${base}, but the leaf does not name ${missing.join(", ")} (machines dialling ${missing.length > 1 ? "those addresses" : "that address"} are refused; it renews within ${Math.round(this.timing.leafCheckIntervalMs / 60_000) || 1} min)`,
          next: "cafe daemon renew-cert",
        };
      }
      return { name: "tls", level: "ok", detail: base };
    } catch (err) {
      return { name: "tls", level: "warn", detail: `TLS on ${port}; cannot read the leaf: ${(err as Error).message}`, next: "cafe daemon renew-cert" };
    }
  }

  /** List views need the latest outcome, not the whole reply text. */
  summaryMeta(meta: ThreadMeta): ThreadMeta {
    return {
      ...meta,
      replies: (meta.replies ?? []).slice(-3).map((r) => {
        const text = String(r.text ?? "");
        return { ...r, text: text.length > 160 ? `${text.slice(0, 159)}…` : text };
      }),
      declines: (meta.declines ?? []).slice(-3).map((d) => {
        const reason = String(d.reason ?? "");
        return { ...d, reason: reason.length > 160 ? `${reason.slice(0, 159)}…` : reason };
      }),
    };
  }

  snapshot() {
    const started = performance.now();
    const result = {
      host: this.host,
      displayName: this.displayName,
      aliases: this.hostAliases,
      isRoot: this.isRoot,
      rootOnline: this.rootOnline,
      router: this.router.name,
      ...(this.routerModel ? { routerModel: this.routerModel } : {}),
      ...(this.lastRouterError ? { routerError: this.lastRouterError } : {}),
      registryVersion: this.registry.version,
      agents: this.registry.all(),
      daemons: this.daemons(),
      threads: this.store.listThreads(200).map((m) => this.summaryMeta(m)),
    };
    this.stats.snapshotMs = performance.now() - started;
    return result;
  }

  thread(threadId: string, opts: { limit?: number; before?: string } = {}) {
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!meta) return undefined;
    // A default page rather than the whole JSONL: the Web UI, SSE replay and `cafe thread` all hit this
    // path, and parsing a long Thread whole blocked the event loop (#31). Callers that truly need
    // everything page backwards from the end.
    const limit = opts.limit === undefined ? DEFAULT_THREAD_PAGE : Math.max(1, opts.limit);
    return { meta, ...this.store.readEventsPage(meta.file, limit, opts.before) };
  }

  /**
   * The `order.closed` event of one Order, read straight from the Thread's JSONL. A follower needs it
   * even when the turn is older than the bounded tail page that `thread()` returns — otherwise an SSE
   * stream for an old turn replays filler and never ends (#31). Every terminal path closes, so this
   * one event ends the wait.
   *
   * Reads from the end until the close, so the live path still avoids it: an Order still tracked here is open.
   */
  closingEvent(threadId: string, orderId: string): ThreadEnvelope | undefined {
    const live = this.tracking.get(orderId);
    if (live && live.status === "open") return undefined;
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!meta) return undefined;
    const last = this.store.findLastEvent(meta.file, (env) => env.orderId === orderId && env.event.type === "order.closed");
    return last;
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
    this.flushMetas();
    this.registry.removeAllListeners();
    this.removeAllListeners();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.hintsTimer);
    clearInterval(this.linkSweep);
    clearTimeout(this.pruneTimer);
    clearInterval(this.pruneInterval);
    clearInterval(this.pullTimer);
    clearInterval(this.stagingTimer);
    clearInterval(this.lagTimer);
    clearInterval(this.leafTimer);
    clearTimeout(this.enrolTimer);
    this.store.setKv("pendingPulls", [...this.pendingPulls.values()]);
    for (const l of this.links.values()) l.ws.close();
    this.uplinkSocket?.close();
    for (const t of this.tracking.values()) {
      for (const timer of t.timers.values()) clearTimeout(timer);
      if (t.deadline) clearTimeout(t.deadline);
      if (t.grace) clearTimeout(t.grace);
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

/** Does this look like `host:port` (rather than a bare host or an IPv6 address)? */
function hasPort(addr: string): boolean {
  if (addr.startsWith("[")) return /^\[[^\]]+\]:\d+$/.test(addr);
  return /^[^:]+:\d+$/.test(addr);
}

/**
 * `advertise` may be a bare host or already carry a port. Appending `:port` unconditionally produced
 * `ws://127.0.0.1:4801:4801`, which was then persisted as a child's `root:` and killed it on boot (#76).
 */
export function hostWithPort(addr: string, port: number): string {
  return hasPort(addr) ? addr : `${addr}:${port}`;
}

/** `advertise` without any port it carries (the TLS address uses the TLS port instead). */
export function bareHost(addr: string): string {
  if (!hasPort(addr)) return addr;
  return addr.replace(/:\d+$/, "");
}

/** The address this Host tells other machines to dial: `advertise` (if set) or the LAN IP, plus the port. */
export function advertisedAddress(config: { advertise?: string; port: number }): string {
  return hostWithPort(config.advertise ?? lanAddress(), config.port);
}

/** A Root/peer address is accepted only when it can become a WebSocket URL. */
export function assertDaemonAddress(addr: string): string {
  const trimmed = addr.trim();
  if (!trimmed) throw new RpcError("bad_request", "address is required");
  let url: URL;
  try {
    url = new URL(`ws://${trimmed}`);
  } catch {
    throw new RpcError("bad_request", `'${addr}' is not a host:port address`);
  }
  if (!url.hostname || !url.port) throw new RpcError("bad_request", `'${addr}' must be host:port (for example 192.168.1.20:4777)`);
  if (url.pathname !== "/" || url.search || url.hash) throw new RpcError("bad_request", `'${addr}' must be host:port, without a path`);
  return trimmed;
}
