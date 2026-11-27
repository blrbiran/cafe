import { EventEmitter } from "node:events";
import { Agent as HttpsAgent } from "node:https";
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import WebSocket from "ws";
import { pushBounded } from "./bounded.ts";
import { watchLiveness } from "./liveness.ts";
import { discoverRoots } from "./discovery.ts";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { tlsAddressOf } from "./tls/bootstrap.ts";
import { hostIdFromCertificate, keyFingerprintOf, keyFingerprintOfPublicKey, localAddresses, missingSans, sanCovers, sanList, verifyHostRenewal } from "./tls/certs.ts";
import { routingStats as computeRoutingStats } from "./routing-stats.ts";
import { hintsFromSummary } from "./hints.ts";
import {
  ACK_TIMEOUT_MS,
  AgentIdentity,
  BROADCAST_DEADLINE_MS,
  CreateOrderParams,
  DEFAULT_CHANNEL,
  CURRENT_FEATURES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES,
  InitializeParams,
  DEFAULT_THREAD_PAGE,
  MAX_ORDER_DEPTH,
  Methods,
  PROTOCOL_VERSION,
  RegistryDelta,
  channelsOf,
  compactHistoryText,
  formatAddress,
  parseAddress,
  projectTaskStatus,
  type AgentRecord,
  type AgentStatus,
  type Attachment,
  HostIdentity,
  type DaemonRecord,
  type Order,
  type Party,
  type RoutingDecision,
  type RoutingHint,
  type ThreadEnvelope,
  type ThreadEventBody,
  type ThreadMeta,
  type TeamRecord,
  type TeamSpec,
  type ChannelDigest,
  type TeamContext,
  type TeamRosterEntry,
  type TeamRosterUpdate,
  TeamLaunchSpec,
  renderTeamPlaybook,
} from "@cafe/protocol";
import { Peer, RpcError } from "@cafe/protocol/peer";
import { type CafeConfig, diffConfig, loadConfig, saveConfig } from "./config.ts";
import { HINT_WINDOW_MS, computeHints, identityOf, orderKeywords } from "./hints.ts";
import { Registry } from "./registry.ts";
import { LlmRouter, RulesRouter, piComplete, type Router } from "./router.ts";
import { Store, type HostInviteRecord } from "./store.ts";
import { summarize } from "./summary.ts";
import { describeFetchError } from "./net-errors.ts";

/** A roster is unique per (host, team, channel): two same-named teams on one Host may differ by channel (v4-13, #108). */
const rosterKey = (t: { host: string; team: string; channel: string }): string => `${t.host}/${t.team}/${t.channel}`;
const OwnershipKey = AgentIdentity.shape.resumeAgentId.unwrap().regex(/^[0-9a-f]{64}$/);
const ownershipDigest = (key: string): string => createHash("sha256").update(key).digest("hex");

function loadOperatorDigest(home: string, store: Store): string {
  const file = join(home, "operator.key");
  const priorDigest = store.getKv<string>("operator-key-digest");
  if (!existsSync(file)) {
    if (priorDigest) throw new Error(`operator key is missing from ${file}; restore it from backup before starting Cafe`);
    try {
      writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const key = readFileSync(file, "utf8");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid Cafe operator key at ${file}`);
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`Cafe operator key must be mode 0600: ${file}`);
  const digest = ownershipDigest(key);
  if (priorDigest && priorDigest !== digest) throw new Error("Cafe operator key does not match its stored digest");
  if (!priorDigest) store.setKv("operator-key-digest", digest);
  return digest;
}

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
  /** Observer channel digest cadence (v4-11). */
  digestIntervalMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Root: how often to recompute and push routing hints when there are new outcomes. */
  hintsIntervalMs: number;
  /** Direct links (Root offline): give up connecting to another Daemon after this long. */
  linkConnectTimeoutMs: number;
  /** Direct links: close an outgoing link after this long without traffic. */
  linkIdleMs: number;
  /** Daemon↔Daemon sockets: ping this often; two missed pongs close the link (#99, v4-10). */
  linkPingMs: number;
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

/** Re-discovery of an orphaned child: start often, back off, and give up after a few minutes (#104). */
const DISCOVERY_MIN_MS = 30_000;
const DISCOVERY_MAX_MS = 5 * 60_000;
const DISCOVERY_MAX_TRIES = 6;

/** Recompute hints at least this often even without new outcomes, so time decay shows. */
const HINTS_MAX_AGE_MS = 3600_000;

/** Live delivery state of one Order on its origin Daemon. */
interface Tracking {
  order: Order;
  /** Anonymous protocol customers own their Orders for the lifetime of their connection. */
  customerPeer?: Peer;
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
  private operatorKeyDigest: string;
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
    issueHost?(sans: string[], hostId: string, publicKey: string): Promise<{ cert: string; key: string }>;
    issueHost?(sans: string[], hostId: string, publicKey: string): Promise<{ cert: string; key: string }>;
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
  hostId: string;
  rootHostId?: string;
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
  /** The exact prompt excerpt associated with an Order delivered to a local recipient. */
  private deliveredParentBodies = new Map<string, string>();
  /** idempotencyKey → the first Order created with it (short window, bounded; v4-3 Q4). */
  private idempotentOrders = new Map<string, IdempotentOrder>();
  /** Agents registered on this Host (authoritative local set, survives Registry snapshots). */
  private local = new Map<string, AgentRecord>();
  /** v4-11 team rosters by `<host>/<team>`; the Root is authoritative and children replicate. */
  private teamRecords = new Map<string, TeamRecord>();
  /** Channels already reported as used by more than one team (one log line per channel). */
  private teamConflicts = new Set<string>();
  /** Tombstoned rosters already explained in the log (one line per roster, not per reconnect). */
  private teamRemovedLogged = new Set<string>();
  /** When a child takes over digests after losing the Root, new channels start from here (v4-13). */
  private digestTakeoverAt?: number;
  /** Rosters survive a daemon restart; the Root replays them on reconnect. */
  private teamsFile: string;

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
  /** Features the connected Root advertises (v4-12); absent/empty = an older Root. */
  private rootFeatures: string[] = [];
  /** One log line while a roster cannot be published to an old Root (v4-12 D8). */
  private teamLocalLogged = false;

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
  private digestTimer?: ReturnType<typeof setInterval>;
  private digestSeq = 0;
  /** channel → last digest timestamp. Persisted: a restarted daemon must not re-emit stored activity. */
  private digestSince = new Map<string, number>();

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
    this.operatorKeyDigest = loadOperatorDigest(opts.home, this.store);
    this.hostId = this.store.getHostIdentityByHost(this.host)?.hostId ?? this.host;
    this.rootHostId = this.isRoot ? this.hostId : this.store.getKv<string>("rootHostId");
    this.rootBindings = new Map((this.store.getKv<HostIdentity[]>("rootHostBindings") ?? []).map((binding) => [binding.hostId, binding]));
    this.teamsFile = join(opts.home, "teams.json");
    try {
      for (const t of JSON.parse(readFileSync(this.teamsFile, "utf8")) as TeamRecord[]) this.teamRecords.set(rosterKey(t), t);
    } catch {
      // no saved rosters yet
    }
    // Digest cursors survive a restart; otherwise stored activity would be re-emitted (v4-11 review).
    const savedDigests = this.store.getKv<Record<string, number>>("digestSince");
    if (savedDigests) for (const [channel, ts] of Object.entries(savedDigests)) if (typeof ts === "number") this.digestSince.set(channel, ts);
    // Every SSE stream and Web UI attaches a "thread" listener; the default limit of 10 is far below
    // normal use (one tab per Thread, `cafe tail`, MCP) and the warning was hidden by --no-warnings (#70).
    this.setMaxListeners(0);
    this.startLagSampler();
    this.log = opts.log ?? ((m) => console.error(`[cafe ${this.host}] ${m}`));
    this.timing = {
      ackTimeoutMs: ACK_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      broadcastDeadlineMs: BROADCAST_DEADLINE_MS,
      unicastDeadlineMs: 2 * 60 * 60_000,
      graceMs: 2_000,
      reconnectMinMs: 500,
      reconnectMaxMs: 30_000,
      hintsIntervalMs: 30_000,
      linkConnectTimeoutMs: 3000,
      linkIdleMs: 5 * 60_000,
      linkPingMs: Number(process.env.CAFE_LINK_PING_MS) || 30_000,
      leafCheckIntervalMs: 5 * 60_000,
      digestIntervalMs: Number(process.env.CAFE_DIGEST_INTERVAL_MS) || 60_000,
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
    this.daemonRecords.set(this.host, { host: this.host, hostId: this.hostId, displayName: this.displayName, aliases: this.hostAliases, legacyAliases: this.hostLegacyAliases, url: this.url(), isRoot: this.isRoot, online: true, connectedAt: Date.now(), lastSeenAt: Date.now(), version: this.version, features: [...CURRENT_FEATURES] });
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
    this.digestTimer = setInterval(() => {
      try {
        this.emitDigests();
      } catch (err) {
        this.log(`digest failed: ${(err as Error).message}`);
      }
    }, this.timing.digestIntervalMs);
    this.digestTimer.unref?.();
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
      // Where the Root was reachable last time, and where it said it could be reached (v4-10).
      this.rootAddressesLearned = this.store.getKv<string[]>("rootAddresses") ?? [];
      this.lastRootAddr = this.store.getKv<string>("lastRoot") ?? undefined;
      this.linkSweep = setInterval(() => this.sweepLinks(), Math.min(this.timing.linkIdleMs, 60_000));
      this.linkSweep.unref?.();
    }
  }

  setLocalHostIdentity(identity: HostIdentity): void {
    if (identity.host !== this.host) throw new Error(`Host identity slug ${identity.host} does not match this Daemon (${this.host})`);
    this.store.putHostIdentity(identity);
    this.hostId = identity.hostId;
    if (this.isRoot) {
      this.rootHostId = identity.hostId;
      this.store.setKv("rootHostId", identity.hostId);
    }
    const record = this.daemonRecords.get(this.host);
    if (record) record.hostId = identity.hostId;
    this.emitDaemons();
  }

  verifyOperatorCredential(candidate: string | undefined): boolean {
    if (!candidate || !/^[0-9a-f]{64}$/.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(ownershipDigest(candidate), "hex"), Buffer.from(this.operatorKeyDigest, "hex"));
  }

  createHostInvite(input: { name?: string; replaceHost?: string }): { inviteCode: string; hostId: string; host: string; expiresAt: number } {
    if (!this.isRoot) throw new RpcError("not_root", "Host invitations can only be created on the Root");
    const now = Date.now();
    const expiresAt = now + 30 * 60_000;
    let host: string;
    let hostId: string;
    let replacement: Pick<HostInviteRecord, "expectedHostRevision" | "expectedKeyFingerprint" | "replaceHostSlug"> = {};
    if (input.replaceHost) {
      const current = this.daemonRecords.get(input.replaceHost);
      const identity = this.store.getHostIdentityByHost(input.replaceHost);
      if (!current && !identity) throw new RpcError("not_found", `unknown Host '${input.replaceHost}'`);
      if (current?.online) throw new RpcError("host_online", `Host '${input.replaceHost}' must be offline before re-enrollment`);
      host = input.replaceHost;
      if (identity) {
        hostId = identity.hostId;
        replacement = { expectedHostRevision: identity.revision ?? 1, expectedKeyFingerprint: identity.keyFingerprint, replaceHostSlug: host };
      } else {
        // Legacy peer without an identity certificate: retain its routing slug but assign a fresh Host ID.
        hostId = ulid();
        replacement = { replaceHostSlug: host };
      }
    } else {
      if (input.name && !/^[a-zA-Z0-9_.-]{1,64}$/.test(input.name)) throw new RpcError("bad_request", "Host name must use letters, numbers, dot, underscore, or dash");
      host = input.name?.trim() || `host-${ulid().slice(-8).toLowerCase()}`;
      if (this.daemonRecords.has(host) || this.store.getHostIdentityByHost(host)) throw new RpcError("conflict", `Host '${host}' already exists; choose another name or use --replace`);
      hostId = ulid();
    }
    const inviteCode = randomBytes(32).toString("hex");
    this.store.createHostInvite({ inviteDigest: ownershipDigest(inviteCode), createdAt: now, expiresAt, hostId, host, state: "issued", ...replacement });
    return { inviteCode, hostId, host, expiresAt };
  }

  async redeemHostInvite(input: { inviteCode: string; requestId: string; publicKey: string; sans: string[] }): Promise<{ hostId: string; host: string; cert: string; caFingerprint: string; retry: boolean }> {
    if (!this.isRoot || !this.tlsContext?.issueHost) throw new RpcError("not_root", "only an enrolled Root can issue Host identity certificates");
    if (!/^[0-9a-f]{64}$/.test(input.inviteCode) || !input.requestId || !input.publicKey.includes("PUBLIC KEY")) {
      throw new RpcError("bad_request", "inviteCode, requestId, and an SPKI public key are required");
    }
    const sans = [...new Set(input.sans.map((name) => name.trim()).filter(Boolean))].sort();
    if (!sans.length || sans.length > 64) throw new RpcError("bad_request", "sans must contain 1–64 unique Host addresses");
    const inviteDigest = ownershipDigest(input.inviteCode);
    const invite = this.store.getHostInvite(inviteDigest);
    if (!invite) throw new RpcError("invite_not_found", "Host invite is unknown or expired");
    const publicKeyFingerprint = keyFingerprintOfPublicKey(input.publicKey);
    const sansHash = createHash("sha256").update(JSON.stringify(sans)).digest("hex");
    const existingRedemption = this.store.getInviteRedemption(inviteDigest);
    const replacementHostOnline = !!(invite.replaceHostSlug && this.daemonRecords.get(invite.replaceHostSlug)?.online);
    if (existingRedemption) {
      const replay = this.store.commitHostEnrollment({
        inviteDigest, now: Date.now(), requestId: input.requestId, publicKeyFingerprint, sansHash,
        certificate: existingRedemption.certificate ?? "", replacementHostOnline,
      });
      if (replay.redemption.state === "superseded") throw new RpcError("credential_superseded", "this invitation's Host key was replaced; create a new invite");
      return { hostId: replay.identity.hostId, host: replay.identity.host, cert: replay.redemption.certificate!, caFingerprint: this.tlsContext.caFingerprint, retry: true };
    }
    const leaf = await this.tlsContext.issueHost(sans, invite.hostId, input.publicKey);
    // The old Host can reconnect while RSA signing yields; check online state immediately before the synchronous DB commit.
    const stillOnline = !!(invite.replaceHostSlug && this.daemonRecords.get(invite.replaceHostSlug)?.online);
    const result = this.store.commitHostEnrollment({
      inviteDigest, now: Date.now(), requestId: input.requestId, publicKeyFingerprint, sansHash,
      certificate: leaf.cert, replacementHostOnline: stillOnline,
    });
    if (result.redemption.state === "superseded") throw new RpcError("credential_superseded", "this invitation's Host key was replaced; create a new invite");
    const previous = this.daemonRecords.get(result.identity.host);
    this.daemonRecords.set(result.identity.host, {
      host: result.identity.host,
      hostId: result.identity.hostId,
      displayName: previous?.displayName ?? result.identity.host,
      aliases: previous?.aliases ?? [],
      legacyAliases: previous?.legacyAliases ?? [],
      url: previous?.url ?? this.config.knownDaemons[result.identity.host] ?? "",
      isRoot: false,
      online: previous?.online ?? false,
      lastSeenAt: previous?.lastSeenAt ?? Date.now(),
      ...(previous?.version ? { version: previous.version } : {}),
      ...(previous?.features ? { features: previous.features } : {}),
    });
    for (const link of this.hostLinks) {
      const id = link.hostIdentity!;
      if (id.hostId === result.identity.hostId && id.keyFingerprint !== result.identity.keyFingerprint) link.close();
    }
    const bindings = this.store.listHostIdentities();
    for (const child of this.children.values()) if (child.hostIdentity) child.notify("host/bindings", bindings);
    this.emitDaemons();
    return { hostId: result.identity.hostId, host: result.identity.host, cert: result.redemption.certificate!, caFingerprint: this.tlsContext.caFingerprint, retry: result.retry };
  }

  /** Root: short-lived nonces for enrolled Host leaf renewal (hostId → nonce/expiry). */
  private hostChallenges = new Map<string, { nonce: string; expiresAt: number }>();

  issueHostChallenge(hostId: string): { nonce: string; expiresAt: number } {
    if (!this.isRoot) throw new RpcError("not_root", "only the Root issues Host renewal challenges");
    const identity = this.store.getHostIdentity(hostId);
    if (!identity || identity.state !== "enrolled") throw new RpcError("not_found", "no enrolled Host with that Host ID");
    const now = Date.now();
    for (const [id, challenge] of this.hostChallenges) if (challenge.expiresAt <= now) this.hostChallenges.delete(id);
    const challenge = { nonce: randomBytes(32).toString("hex"), expiresAt: now + 2 * 60_000 };
    this.hostChallenges.set(hostId, challenge);
    if (this.hostChallenges.size > 1000) this.hostChallenges.delete(this.hostChallenges.keys().next().value!);
    return challenge;
  }

  async renewHostLeaf(input: { hostId: string; nonce: string; signature: string; publicKey: string; sans: string[] }): Promise<{ cert: string; hostId: string; caFingerprint: string }> {
    if (!this.isRoot || !this.tlsContext?.issueHost) throw new RpcError("not_root", "only the Root issues Host certificates");
    const identity = this.store.getHostIdentity(input.hostId);
    if (!identity || identity.state !== "enrolled") throw new RpcError("not_found", "no enrolled Host with that Host ID");
    const challenge = this.hostChallenges.get(input.hostId);
    if (!challenge || challenge.nonce !== input.nonce || challenge.expiresAt <= Date.now()) {
      throw new RpcError("challenge_expired", "request a fresh renewal challenge from the Root");
    }
    if (keyFingerprintOfPublicKey(input.publicKey) !== identity.keyFingerprint) {
      throw new RpcError("credential_superseded", "this key is not the enrolled identity for that Host; create a new invite to re-key");
    }
    if (!verifyHostRenewal(input.publicKey, input.hostId, input.nonce, input.signature)) {
      throw new RpcError("bad_signature", "the renewal proof was not signed by the enrolled Host key");
    }
    this.hostChallenges.delete(input.hostId);
    const sans = [...new Set(input.sans.map((name) => name.trim()).filter(Boolean))].sort();
    if (!sans.length || sans.length > 64) throw new RpcError("bad_request", "sans must contain 1–64 unique Host addresses");
    const leaf = await this.tlsContext.issueHost(sans, input.hostId, input.publicKey);
    const binding = this.store.getHostIdentity(input.hostId);
    if (binding?.state !== "enrolled" || binding.keyFingerprint !== identity.keyFingerprint || binding.revision !== identity.revision) {
      throw new RpcError("credential_superseded", "Host key changed during certificate renewal");
    }
    if (hostIdFromCertificate(leaf.cert) !== input.hostId) throw new RpcError("bad_identity", "issued certificate does not carry the Host ID");
    return { cert: leaf.cert, hostId: input.hostId, caFingerprint: this.tlsContext.caFingerprint };
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
  /** What this Daemon can do on the wire (v4-12). An older peer advertises nothing. */
  features(): readonly string[] {
    return CURRENT_FEATURES;
  }

  /** Features the connected Root advertises; the Root itself always supports everything (v4-12). */
  rootFeatureList(): string[] {
    return this.isRoot ? [...CURRENT_FEATURES] : [...this.rootFeatures];
  }

  /** True when the connected Root advertises every feature in `need` (an absent list = none). */
  private rootSupports(...need: string[]): boolean {
    return this.isRoot || need.every((f) => this.rootFeatures.includes(f));
  }

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
  /** Root: Hosts forgotten (v4-8) → when. An address probe that started before that must not write them back. */
  private forgotten = new Map<string, number>();
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

  /**
   * What another machine needs to join this Root with `cafe connect` (the token is read on the Root).
   * `addresses` lists every local IPv4 address unless `advertise` is set (#95): a Root on a LAN and a
   * VPN is reached at a different address from each, and only the person knows which one the other
   * machine can reach. `address` is the first, kept for older clients.
   */
  joinHint(): { address: string; addresses: string[]; advertised: boolean; caFingerprint?: string; rootHostId?: string } {
    const fp = this.tlsStatus().caFingerprint;
    const j = joinAddresses({ advertise: this.config.advertise, port: this.config.port, tlsPort: this.tlsPort, lan: localAddresses() });
    return { address: j.addresses[0]!, ...j, ...(fp ? { caFingerprint: `sha256:${fp}` } : {}), ...(this.isRoot && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(this.hostId) ? { rootHostId: this.hostId } : {}) };
  }

  /**
   * Encrypted Web addresses for other devices (v4-9): the TLS port serves the same Web UI. One
   * `https://` per address `joinAddresses()` offers, keeping only those the current leaf names (a
   * DHCP change waits for the next renewal) and never a loopback address. `undefined` while TLS is
   * off or the Host is not on the network yet: its temporary CA is replaced at enrolment, so a
   * person must not be asked to trust it.
   */
  webHttps(): string[] | undefined {
    const ctx = this.tlsContext;
    if (!ctx?.network || !this.tlsPort) return undefined;
    const cert = ctx.current().cert;
    const advertise = this.config.advertise ? bareHost(this.config.advertise) : undefined;
    return joinAddresses({ advertise, port: this.tlsPort, lan: localAddresses() })
      .addresses.map((a) => bareHost(a))
      .filter((h) => {
        const name = h.replace(/^\[|\]$/g, "");
        return !/^127\.|^localhost$|^::1$/.test(name) && sanCovers(cert, name);
      })
      .map((h) => `https://${hostWithPort(h, this.tlsPort!)}/`);
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
      // Keep the original error as `cause`: `describeFetchError` reads the code from it, and dropping
      // it turned every TLS-port discovery failure back into "fetch failed" (#103).
      throw new Error(`cannot find the TLS port of ${plain}: ${(err as Error).message}`, { cause: err });
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
  private linkOptions(host: string | undefined, verified: (cert: X509Certificate) => void): import("ws").ClientOptions {
    if (!this.tlsContext?.network) return {};
    const expected = host === undefined ? this.rootHostId : [...this.rootBindings.values()].find((binding) => binding.host === host)?.hostId ?? (this.isRoot ? this.store.getHostIdentityByHost(host)?.hostId : undefined);
    if (!expected) throw new RpcError("host_auth_required", "no authenticated Host binding; reconnect to an enrolled Root first");
    const check = (name: string, peerCert: PeerCertificate): Error | undefined => {
      const error = checkServerIdentity(name, peerCert);
      if (error) return error;
      const certificate = new X509Certificate(peerCert.raw);
      const enrolledId = hostIdFromCertificate(certificate.toString());
      if (enrolledId !== expected) return new RpcError("bad_identity", "server certificate has a different Host ID");
      if (host !== undefined) {
        const binding = this.trustBinding(expected);
        if (binding?.state !== "enrolled" || binding.host !== host || binding.keyFingerprint !== keyFingerprintOf(certificate.toString())) {
          return new RpcError("bad_identity", "server certificate does not match the current Root binding");
        }
      }
      verified(certificate);
    };
    return {
      ...this.tlsContext.current(), ca: this.tlsContext.ca, agent: new HttpsAgent({ maxCachedSessions: 0 }),
      checkServerIdentity: check as unknown as import("ws").ClientOptions["checkServerIdentity"],
    };
  }

  private hostLinkHello(): Pick<InitializeParams, "hostId" | "hostAuthVersion" | "rootHostId" | "features"> {
    return { hostId: this.hostId, hostAuthVersion: 1, rootHostId: this.rootHostId, features: [...CURRENT_FEATURES] };
  }

  private verifyHostHello(hello: { protocolVersion?: number; features?: string[]; hostId?: string; rootHostId?: string }, certificate: X509Certificate): string {
    if (hello.protocolVersion !== PROTOCOL_VERSION) throw new RpcError("protocol_mismatch", "remote Host uses a different protocol version");
    if (!hello.features?.includes("host-auth-v1")) throw new RpcError("host_auth_required", "upgrade and enroll the remote Host");
    const id = hostIdFromCertificate(certificate.toString());
    if (!id || hello.hostId !== id || hello.rootHostId !== this.rootHostId) throw new RpcError("bad_identity", "remote Host hello does not match the certificate or pinned Root");
    return id;
  }

  get rootOnline(): boolean {
    return this.isRoot || (this.uplink !== undefined && !this.uplink.isClosed);
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  private rootBindings = new Map<string, HostIdentity>();
  private hostLinks = new Set<Peer>();

  private trustBinding(hostId: string): HostIdentity | undefined {
    return this.isRoot ? this.store.getHostIdentity(hostId) : this.rootBindings.get(hostId);
  }

  private installRootBindings(raw: unknown): void {
    if (!Array.isArray(raw)) throw new RpcError("host_auth_required", "Root did not supply Host identity bindings");
    const bindings = new Map<string, HostIdentity>();
    for (const item of raw) {
      const binding = HostIdentity.parse(item);
      if (bindings.has(binding.hostId)) throw new RpcError("bad_identity", "duplicate Root Host binding");
      bindings.set(binding.hostId, binding);
    }
    this.rootBindings = bindings;
    this.store.setKv("rootHostBindings", [...bindings.values()]);
    for (const link of this.hostLinks) {
      const identity = link.hostIdentity!;
      const current = bindings.get(identity.hostId);
      if (current?.state !== "enrolled" || current.keyFingerprint !== identity.keyFingerprint) link.close();
    }
  }

  private bindHostCertificate(peer: Peer, certificate: X509Certificate, hostId: string): void {
    peer.bindHostIdentity({ hostId, keyFingerprint: keyFingerprintOf(certificate.toString()) });
    this.hostLinks.add(peer);
    const expiry = Date.parse(certificate.validTo);
    let timer: ReturnType<typeof setTimeout>;
    const checkExpiry = () => {
      const remaining = expiry - Date.now();
      if (remaining <= 0) peer.close();
      else {
        timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
        timer.unref();
      }
    };
    checkExpiry();
    this.hostLinkCleanup.set(peer, () => clearTimeout(timer));
  }

  private hostLinkCleanup = new WeakMap<Peer, () => void>();
  private dropHostCertificate(peer: Peer): void {
    this.hostLinkCleanup.get(peer)?.();
    this.hostLinks.delete(peer);
  }

  /** Attach a freshly accepted socket. `local` = loopback (no token required for UI and Agents). */
  accept(ws: WebSocket, local: boolean, secure = false, certificate?: X509Certificate): void {
    const peer = new Peer(ws);
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("close", () => {
      this.dropHostCertificate(peer);
      peer.closed();
      this.onPeerClosed(peer);
    });
    ws.on("error", () => ws.close());
    peer.on(Methods.initialize, (raw) => {
      if (peer.meta.kind) throw new RpcError("bad_identity", "connection already initialized");
      const p = InitializeParams.parse(raw);
      const hostLink = p.kind === "daemon" || p.kind === "peer";
      if (!local && p.token !== this.config.token) throw new RpcError("unauthorized", "bad token");
      if (p.protocolVersion !== PROTOCOL_VERSION) throw new RpcError("protocol_mismatch", this.mismatchMessage(p));
      if (hostLink && this.tlsContext) {
        if (!secure) this.refusePlaintextLink(p);
        if (!certificate || !this.tlsContext.network || !p.features?.includes("host-auth-v1") || p.hostAuthVersion !== 1) {
          throw new RpcError("host_auth_required", "Host links require an enrolled certificate. Upgrade cafe and enroll with a Root invitation.");
        }
        const id = hostIdFromCertificate(certificate.toString());
        const binding = id ? this.trustBinding(id) : undefined;
        if (!id || !binding || binding.state !== "enrolled" || binding.keyFingerprint !== keyFingerprintOf(certificate.toString()) ||
            p.hostId !== id || p.host !== binding.host || p.rootHostId !== this.rootHostId || id === this.hostId) {
          throw new RpcError("bad_identity", "Host identity does not match the enrolled certificate binding");
        }
        if (p.token !== this.config.token) throw new RpcError("unauthorized", "bad token");
        this.bindHostCertificate(peer, certificate, id);
        this.refusedPlaintext.delete(binding.host);
      }
      peer.meta.kind = p.kind;
      peer.meta.features = p.features ?? [];
      // Bind the agent RPC surface only after a successful handshake (token + protocol). Binding it
      // on accept let any network socket that could open /ws create Orders or register a Barista
      // before initialize (v4-11 review).
      this.bindAgentMethods(peer);
      // Both directions check: an idle accepted link whose peer died looks exactly like a healthy one.
      if (p.kind === "daemon" || p.kind === "peer") this.watchLink(ws);
      if (p.kind === "daemon") return this.onChildDaemon(peer, p);
      if (p.kind === "peer") {
        peer.meta.host = p.host;
        if (p.host && p.url && !this.isRoot) this.learnPeers([{ host: p.host, url: p.url }]);
        this.bindLink(peer);
        return { protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, ...this.hostLinkHello(), host: this.host, displayName: this.displayName, aliases: this.hostAliases, isRoot: this.isRoot };
      }
      if (p.kind === "ui") this.uis.add(peer);
      return { protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, features: [...CURRENT_FEATURES], host: this.host, displayName: this.displayName, aliases: this.hostAliases, isRoot: this.isRoot };
    });
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
        if ((s === "pending" || s === "acked") && !(s === "pending" && t.order.clarificationRecipient)) {
          this.targetFailed(t, agentId, "agent disconnected");
        }
      }
    }
  }

  private bindAgentMethods(peer: Peer): void {
    peer.on(Methods.agentRegister, (raw) => {
      if (peer.meta.agentId) throw new RpcError("conflict", "connection is already registered");
      const { resumeAgentId, resumeProof, ...identity } = AgentIdentity.extend({ resumeProof: OwnershipKey.optional() }).parse(raw);
      const proof = resumeProof ? ownershipDigest(resumeProof) : undefined;
      const priorProof = resumeAgentId ? this.store.getKv<string>(`agent-proof:${resumeAgentId}`) : undefined;
      if (priorProof && priorProof !== proof) throw new RpcError("bad_identity", "agent resume proof does not match");
      // An agentId is resumable only with a matching stored proof, or — when this Host has never
      // recorded one (legacy or freshly restarted store) — with a proof the client presents. A bare
      // claim of an unprotected ID is not enough to inherit its delivery authority.
      const resumableProof = !!priorProof === true ? priorProof === proof : !!proof;
      const availableId = resumeAgentId && resumableProof && !this.agents.has(resumeAgentId) ? resumeAgentId : undefined;
      const prev = availableId ? (this.local.get(availableId) ?? this.registry.get(availableId)) : undefined;
      const resumable = prev && prev.host === this.host && prev.name === identity.name ? prev : undefined;
      const now = Date.now();
      const record: AgentRecord = {
        ...identity,
        agentId: resumable?.agentId ?? (prev ? undefined : availableId) ?? ulid(),
        address: resumable?.address ?? formatAddress(identity.name, this.registry.nextInstance(identity.name, this.host), this.host),
        host: this.host,
        status: "idle",
        registeredAt: now,
        lastSeenAt: now,
        aliases: resumable?.aliases ?? [],
        legacyAliases: resumable?.legacyAliases ?? [],
        ...(resumable?.displayName ? { displayName: resumable.displayName } : {}),
      };
      if (proof) this.store.setKv(`agent-proof:${record.agentId}`, proof);
      peer.meta.agentId = record.agentId;
      peer.meta.party = { id: record.agentId, address: record.address, host: this.host } satisfies Party;
      this.agents.set(record.agentId, peer);
      this.local.set(record.agentId, record);
      this.publishAgents([record]);
      this.learnTeam(record);
      this.log(`registered ${record.address} (${identity.mode}, ${identity.role})`);
      // v4-13: a team member gets its playbook and roster in the registration result. Extra fields
      // are ignored by an old client, and the replicated AgentRecord never carries them.
      const teamContext = this.teamContextFor(record);
      return teamContext ? { ...record, teamContext } : record;
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
    peer.on(Methods.orderCreate, (raw) => {
      const parsed = CreateOrderParams.safeParse(raw);
      if (!parsed.success) throw new RpcError("bad_request", parsed.error.message);
      return this.createOrder(parsed.data, peer);
    });
    peer.on(Methods.orderAck, (p: { orderId: string; threadId: string }) => this.agentEvent(peer, p, { type: "order.acked", agentId: peer.meta.agentId }));
    peer.on(Methods.orderHeartbeat, (p: { orderId: string; threadId: string; note?: string }) =>
      this.agentEvent(peer, p, { type: "order.heartbeat", agentId: peer.meta.agentId, note: p.note }),
    );
    peer.on(Methods.orderReply, (p: { orderId: string; threadId: string; text: string; final?: boolean; attachments?: Attachment[] }) =>
      this.agentEvent(peer, p, { type: "order.replied", agentId: peer.meta.agentId, text: p.text, final: p.final ?? true, ...(p.attachments?.length ? { attachments: p.attachments } : {}) }),
    );
    peer.on(Methods.orderDecline, (p: { orderId: string; threadId: string; reason: string; unavailable?: boolean }) =>
      this.agentEvent(peer, p, { type: "order.declined", agentId: peer.meta.agentId, reason: p.reason, ...(p.unavailable ? { unavailable: true } : {}) }),
    );
    peer.on("order/report", async (p: { threadId: string; orderId: string; text: string }) => {
      const agentId = peer.meta.agentId as string | undefined;
      if (!agentId || this.agents.get(agentId) !== peer) throw new RpcError("not_registered", "agent/register first");
      if (typeof p.threadId !== "string" || typeof p.orderId !== "string" || typeof p.text !== "string" || !p.text.trim() || p.text.length > 12_000) {
        throw new RpcError("bad_request", "threadId, orderId and report text (up to 12000 characters) are required");
      }
      const order = this.findParentOrder(p.orderId, p.threadId);
      if (order?.threadId !== p.threadId || !order.from.id.startsWith("cli:") || !this.wasDelivered(order, agentId, this.host, true)) {
        throw new RpcError("not_a_target", "only a recipient of the original human Order can report its result");
      }
      if (!this.closingEvent(p.threadId, p.orderId)) throw new RpcError("order_open", "reply to the open Order instead");
      const meta = this.metas.get(order.threadId) ?? this.store.getThread(order.threadId)!;
      const duplicate = this.store.findLastEvent(meta.file, (env) => env.orderId === order.orderId &&
        env.event.type === "order.reported" && env.event.agentId === agentId && env.event.text === p.text);
      const report: ThreadEnvelope = duplicate ?? {
        eventId: ulid(), threadId: order.threadId, orderId: order.orderId, host: this.host, at: Date.now(),
        ...(this.tlsContext?.network ? { eventHostId: this.hostId } : {}),
        actor: { kind: "agent", principalId: agentId },
        event: { type: "order.reported", agentId, text: p.text },
      };
      if (!duplicate) {
        if (!this.isRoot) this.markBackfill(order.threadId, true);
        this.recordEvent(report);
      }
      if (!this.isRoot) {
        if (!this.rootOnline) throw new RpcError("report_pending", "report saved on this Host and will sync when Root reconnects");
        await this.uplink!.request(Methods.threadBackfill, { events: [report] }, 5000);
      }
      return {};
    });
    const cancel = (p: { threadId: string; orderId: string }) => this.cancel(p?.threadId, p?.orderId, { peer });
    peer.on(Methods.orderCancel, cancel);
    peer.on("order/cancel-exact", cancel);
    // Bridged Baristas (Codex / Claude) remember which external session continues a Thread (v3-1 Q79).
    const sessionKey = (p: { threadId?: unknown; kind?: unknown }) => {
      const rec = peer.meta.agentId ? this.local.get(peer.meta.agentId as string) : undefined;
      if (!rec) throw new RpcError("not_registered", "agent/register first");
      if (typeof p.threadId !== "string" || typeof p.kind !== "string") throw new RpcError("bad_request", "threadId and kind are required");
      // Team members commonly share `dir: .`, so cwd is not an identity. Use team/member for them;
      // a plain Barista keeps the cwd key so a restarted process resumes its session (v4-11 review).
      const scope = rec.team && rec.member ? `team:${rec.team}/${rec.member}` : rec.cwd;
      return { kind: p.kind, cwd: scope, threadId: p.threadId };
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
    peer.on("order/resume-results", (p: { threadId: string; orderId: string }) => {
      const meta = this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
      const order = meta ? this.findParentOrder(p.orderId, p.threadId) : undefined;
      if (!meta || !order || order.threadId !== p.threadId || order.from.id !== peer.meta.agentId) {
        throw new RpcError("not_found", "no matching Order for this agent");
      }
      this.subscribe(p.threadId, peer);
      return this.store.readOrderEvents(meta.file, p.orderId)
        .filter(({ event }) => event.type === "order.closed" || event.type === "order.declined" || (event.type === "order.replied" && event.final))
        .slice(-21).map((env) => env.event.type === "order.replied" ? { ...env, event: { ...env.event, text: env.event.text.slice(0, 1500), attachments: undefined } } : env);
    });
    peer.on("thread/subscribe", (p: { threadId: string }) => {
      this.subscribe(p.threadId, peer);
      return {};
    });
  }

  private agentEvent(peer: Peer, p: { orderId: string; threadId: string }, event: ThreadEventBody): {} {
    const agentId = peer.meta.agentId as string | undefined;
    if (!agentId || this.agents.get(agentId) !== peer) throw new RpcError("not_registered", "agent/register first");
    if (typeof p?.orderId !== "string" || !p.orderId || typeof p.threadId !== "string" || !p.threadId) {
      throw new RpcError("bad_request", "orderId and threadId are required");
    }
    const meta = this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
    const order = meta ? this.findParentOrder(p.orderId, p.threadId) : undefined;
    if (!order || order.threadId !== p.threadId) throw new RpcError("not_found", "no matching Order on this Thread");
    if (!this.wasDelivered(order, agentId, this.host)) throw new RpcError("not_a_target", "this Agent was not delivered the Order");

    const tracking = this.tracking.get(order.orderId);
    const closed = tracking ? tracking.status !== "open" : !!this.closingEvent(p.threadId, p.orderId);
    if (closed && !(event.type === "order.replied" && event.final)) return {};
    if (tracking?.targets.get(agentId) === "failed" && !(event.type === "order.replied" && event.final)) return {};
    if (tracking && !tracking.targets.has(agentId)) tracking.targets.set(agentId, "pending");

    let accepted = event;
    if (event.type === "order.replied" && event.attachments?.length) {
      accepted = { ...event, attachments: this.commitAttachments(event.attachments, p.threadId) };
    }
    if (!closed && ((accepted.type === "order.replied" && accepted.final) || accepted.type === "order.declined")) {
      this.clearActiveOrder(agentId, p.threadId, p.orderId);
    }
    this.recordEvent(
      {
        eventId: ulid(), threadId: p.threadId, orderId: p.orderId, host: this.host, at: Date.now(),
        ...(this.tlsContext?.network ? { eventHostId: this.hostId } : {}),
        actor: { kind: "agent", principalId: agentId }, event: accepted,
      },
      closed ? { skipTrack: true } : {},
    );
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
    else if (this.rootOnline) this.uplink!.notify(Methods.registryUpsert, { records: records.filter((r) => this.publishableTo(r, this.rootFeatures)) });
    else this.registry.upsert(records); // Root down: keep a local view; resynced on reconnect.
  }

  // -------------------------------------------------------------------------
  // Teams (v4-11)
  // -------------------------------------------------------------------------

  /** Published and loose rosters, without computing any Thread statistics. */
  private liveRosters(): TeamRecord[] {
    const byKey = new Map(this.teamRecords);
    // A team started only by TUIs (no `team start`) still appears: derive from live registrations.
    // An authoritative `.cafe` roster owns membership, and a tombstone must not be resurrected.
    for (const r of this.registry.all()) {
      if (!r.team || !r.teamChannel) continue;
      const key = rosterKey({ host: r.host, team: r.team, channel: r.teamChannel });
      const rec = byKey.get(key);
      if (rec?.authoritative || rec?.removed) continue;
      const next = rec ?? { team: r.team, host: r.host, channel: r.teamChannel, members: [], revision: 0 };
      const name = r.member ?? r.name;
      if (!next.members.some((m) => m.name === name)) {
        next.members = [...next.members, { name, duty: r.duty, description: r.description, tags: r.tags, scope: r.scope, mode: "headless" as const, dir: r.cwd, observer: r.observer }];
      }
      byKey.set(key, next);
    }
    return [...byKey.values()].filter((t) => !t.removed);
  }

  /** The live team view used by /api/teams and the Web. */
  teams() {
    return this.liveRosters()
      .map((t) => {
        const agents = this.registry.all().filter((r) => r.host === t.host && r.team === t.team && r.teamChannel === t.channel);
        const roster = t.members.map((m) => {
          const a = agents.find((r) => (r.member ?? r.name) === m.name);
          return {
            name: m.name,
            ...(m.duty ? { duty: m.duty } : {}),
            ...(m.dutyAliases?.length ? { dutyAliases: m.dutyAliases } : {}),
            mode: m.mode,
            dir: m.dir,
            ...(m.observer ? { observer: true } : {}),
            ...(a ? { address: a.address, status: a.status, ...(a.activeThreadId ? { currentThread: a.activeThreadId } : {}) } : {}),
          };
        });
        const threads = [...this.metas.values()].filter((m) => (m.channel ?? DEFAULT_CHANNEL) === t.channel);
        return {
          ...t,
          // A child sees the network registry (and therefore whether any member is online) but only
          // its own Threads: mark the view local instead of letting zero counts read as "idle"
          // (v4-11 review). Membership itself is replicated, so the roster is still complete.
          hostOnline: t.host === this.host || this.registry.all().some((r) => r.host === t.host && r.status !== "offline"),
          ...(this.isRoot ? {} : { partial: true }),
          roster,
          online: roster.filter((m) => "status" in m && m.status !== "offline").length,
          total: t.members.length,
          authoritative: t.authoritative === true,
          revision: t.revision,
          openThreads: threads.filter((m) => m.status === "routing" || m.status === "delivering" || m.status === "working").length,
          ...(threads.length ? { lastActivityAt: Math.max(...threads.map((m) => m.lastActivityAt ?? m.createdAt)) } : {}),
          // Whether this roster reaches the Root; `partial` is about Thread metrics only (v4-12 D8).
          rosterShared: this.isRoot || this.rootSupports("teams"),
        };
      });
  }

  /** Channel index for the Web (v4-11): DB counts plus the teams that use each channel. */
  channels() {
    const all = this.teams();
    const stats = new Map(this.store.channelStats().map((s) => [s.channel, s]));
    for (const t of all) {
      const s = stats.get(t.channel) ?? { channel: t.channel, threads: 0, lastActivityAt: 0 };
      stats.set(t.channel, s);
    }
    return [...stats.values()]
      .map((s) => {
        const teams = all.filter((t) => t.channel === s.channel).map((t) => ({ team: t.team, host: t.host }));
        return {
          name: s.channel,
          threads: s.threads,
          lastActivityAt: s.lastActivityAt || undefined,
          teams,
          ...(teams.length > 1 ? { conflict: true } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A page of one channel's Threads for an observer (v4-11), newest activity first. */
  channelThreads(channel: string, opts: { after?: number; before?: number; cursor?: { at: number; threadId: string }; limit?: number } = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 200) : 50;
    const all = this.store.listThreadsInByActivity(channel, { ...opts, limit: limit + 1 });
    const last = all.length > limit ? all[limit - 1] : undefined;
    return {
      threads: all.slice(0, limit).map((m) => this.summaryMeta(m)),
      hasMore: !!last,
      ...(last ? { nextCursor: `${last.lastActivityAt ?? last.createdAt}:${last.threadId}` } : {}),
      exists: all.length > 0 || this.store.listThreadsIn(channel, 1).length > 0 || this.teams().some((t) => t.channel === channel),
    };
  }
  /**
   * `to: <team>` has one meaning in v4-13: the team's front door, its orchestrator. Reaching every
   * member requires an explicit `broadcast`.
   */
  private resolveTeamTarget(name: string, host: string | undefined, sender: Party): { ids: string[]; failure?: "unknown_team" | "team_offline" | "ambiguous_team" | "no_orchestrator" | "self_delivery" } {
    let teams = this.liveRosters().filter((t) => t.team === name && (!host || t.host === host));
    if (!teams.length) return { ids: [], failure: "unknown_team" };
    if (teams.length > 1) {
      // Prefer the sender's Host, then a team sharing the sender's own team channel.
      const sameHost = teams.filter((t) => t.host === sender.host);
      const pool = sameHost.length ? sameHost : teams;
      if (pool.length === 1) teams = pool;
      else {
        const senderRec = sender.id ? this.registry.get(sender.id) : undefined;
        const sameChannel = senderRec?.teamChannel ? pool.filter((t) => t.channel === senderRec.teamChannel) : [];
        if (sameChannel.length === 1) teams = sameChannel;
        else return { ids: [], failure: "ambiguous_team" };
      }
    }
    return this.teamFrontDoor(teams[0]!, sender);
  }

  private teamFrontDoor(team: TeamRecord, sender: Party): { ids: string[]; failure?: "no_orchestrator" | "team_offline" | "self_delivery" } {
    const leads = team.members.filter((m) => m.duty === "orchestrator");
    if (!team.authoritative || leads.length !== 1 || leads[0]!.observer) return { ids: [], failure: "no_orchestrator" };
    const online = this.registry.all().filter((r) => this.isTeamMember(r, team) && (r.member ?? r.name) === leads[0]!.name &&
      r.role === "barista" && !r.observer && r.status !== "offline" && (this.rootOnline || r.host === this.host || this.peerUrls.has(r.host)));
    if (online.length !== 1) return { ids: [], failure: "team_offline" };
    if (online[0]!.agentId === sender.id) return { ids: [], failure: "self_delivery" };
    return { ids: [online[0]!.agentId] };
  }

  private isTeamMember(rec: AgentRecord, team: TeamRecord): boolean {
    return rec.host === team.host && rec.team === team.team && rec.teamChannel === team.channel &&
      team.members.some((m) => m.name === (rec.member ?? rec.name) && !m.observer);
  }

  private teamScope(order: Order): { team?: TeamRecord; ambiguous?: true } {
    if (!order.channel || order.channel === DEFAULT_CHANNEL) return {};
    const owners = this.liveRosters().filter((t) => t.channel === order.channel);
    if (owners.every((t) => !t.authoritative)) return {};
    const sender = this.registry.get(order.from.id);
    if (sender?.team && sender.teamChannel === order.channel) {
      const own = owners.find((t) => t.authoritative && this.isTeamMember(sender, t));
      return own ? { team: own } : { ambiguous: true };
    }
    if (owners.length === 1 && owners[0]!.authoritative) return { team: owners[0] };
    return owners.length ? { ambiguous: true } : {};
  }

  /** A duty is a roster label in the current team scope. */
  private resolveDuty(order: Order, duty: string, host?: string): { ids: string[]; failure: "ambiguous_channel" | "ambiguous_duty" | "unknown_duty" | "no_online_barista" } | { ids: string[]; failure?: undefined } {
    const { team, ambiguous } = this.teamScope(order);
    if (ambiguous) return { ids: [], failure: "ambiguous_channel" };
    if (!team || (host && host !== team.host)) return { ids: [], failure: "unknown_duty" };
    const want = duty.trim().toLowerCase();
    const names = new Set(team.members.filter((m) => !m.observer && m.duty?.trim().toLowerCase() === want).map((m) => m.name));
    const candidates = this.eligible(order).filter((r) => this.isTeamMember(r, team) && names.has(r.member ?? r.name));
    if (candidates.length > 1) return { ids: [], failure: "ambiguous_duty" };
    if (candidates.length === 1) return { ids: [candidates[0]!.agentId] };
    return { ids: [], failure: names.size ? "no_online_barista" : "unknown_duty" };
  }

  /** Send a notification to an Agent wherever it is registered (v4-11 digests). */
  private notifyAgent(agentId: string, method: string, params: Record<string, unknown>): void {
    const local = this.agents.get(agentId);
    if (local) return local.notify(method, params);
    const rec = this.registry.get(agentId);
    if (!rec || rec.host === this.host) return;
    if (this.isRoot) {
      this.children.get(rec.host)?.notify(method, { ...params, agentId });
      return;
    }
    if (this.rootOnline) return this.uplink!.notify(method, { ...params, agentId });
    this.links.get(rec.host)?.peer.notify(method, { ...params, agentId });
  }

  /**
   * One digest per observer per channel while there is new activity (v4-11). It is assembled from the
   * Threads this daemon can see; a child marks it partial because it sees only its own Host.
   */
  private emitDigests(): void {
    const now = Date.now();
    // v4-13: the Root publishes the complete network view while it is online; a child only takes
    // over when the Root is offline (its digest is then `partial`). This is one publisher per
    // observer, with the complete view whenever one exists (#109).
    if (!this.isRoot && this.rootOnline) return;
    // The Root sees every observer and the complete network, so it publishes for all of them; a
    // child only publishes for observers registered on itself, and only while the Root is away.
    const observers = this.registry.all().filter((r) => r.observer && (this.isRoot || r.host === this.host));
    if (!observers.length) return;
    const channels = [...new Set(observers.flatMap((r) => channelsOf(r)))];
    let moved = false;
    for (const channel of channels) {
      // A child that just took over starts from the takeover moment instead of replaying what the
      // Root already covered. Its existing cursors are moved forward in setRootOnline(false).
      const since = this.digestSince.get(channel) ?? this.digestTakeoverAt ?? 0;
      const changed = this.store.listThreadsInByActivity(channel, { after: since, limit: 200 });
      if (!changed.length) continue;
      const digest: ChannelDigest = {
        digestId: `${this.host}:${++this.digestSeq}`,
        channel,
        since,
        threads: changed.slice(0, 20).map((m) => ({
          threadId: m.threadId,
          status: m.status,
          from: m.from,
          summary: m.summary,
          targets: m.targets,
          replies: (m.replies ?? []).length,
          declined: (m.declines ?? []).length,
          ...(m.closedAt ? { closedAt: m.closedAt } : {}),
          ...(m.parentThreadId ? { parentThreadId: m.parentThreadId } : {}),
        })),
        omitted: Math.max(0, changed.length - 20),
        ...(this.isRoot ? {} : { partial: true }),
      };
      for (const rec of observers) if (channelsOf(rec).includes(channel)) this.notifyAgent(rec.agentId, Methods.channelDigest, { digest });
      // A channel cursor is global (one digest per channel per interval); persisting it is what
      // stops a restart from replaying stored activity to a new observer (v4-11 review).
      this.digestSince.set(channel, now);
      moved = true;
    }
    if (moved) this.store.setKv("digestSince", Object.fromEntries(this.digestSince));
  }

  /** Content identity of a roster; an identical re-publish changes nothing (v4-13). */
  private teamHash(rec: Pick<TeamRecord, "team" | "channel" | "members" | "removed" | "authoritative">): string {
    const members = [...rec.members].sort((a, b) => a.name.localeCompare(b.name)).map((m) => JSON.stringify(m));
    return createHash("sha256").update([rec.team, rec.channel, rec.removed ? "removed" : "live", rec.authoritative ? "auth" : "derived", ...members].join("\n")).digest("hex").slice(0, 16);
  }

  /** The compact roster in a `team/roster` update / `teamContext`. */
  private rosterEntries(rec: TeamRecord): TeamRosterEntry[] {
    const agents = this.registry.all().filter((r) => r.host === rec.host && r.team === rec.team && r.teamChannel === rec.channel);
    return rec.members.map((m) => {
      const a = agents.find((r) => (r.member ?? r.name) === m.name);
      return { name: m.name, ...(m.duty ? { duty: m.duty } : {}), ...(m.dutyAliases?.length ? { dutyAliases: m.dutyAliases } : {}), online: !!a && a.status !== "offline" };
    });
  }

  /** Tell local members that a roster changed. Remote members hear it from their own daemon. */
  private notifyRosterChange(current: TeamRecord | undefined, next: TeamRecord, opts: { skipAgentId?: string } = {}): void {
    const before = new Map((current?.members ?? []).map((m) => [m.name, m]));
    const after = new Map(next.members.map((m) => [m.name, m]));
    const added = [...after.keys()].filter((n) => !before.has(n));
    const removed = [...before.keys()].filter((n) => !after.has(n));
    const updated = [...after.keys()].filter((n) => before.has(n) && JSON.stringify(before.get(n)) !== JSON.stringify(after.get(n)));
    if (!next.removed && !added.length && !removed.length && !updated.length) return;
    const update: TeamRosterUpdate = {
      team: next.team,
      channel: next.channel,
      revision: next.revision ?? 0,
      members: this.rosterEntries(next),
      change: { added, removed, updated },
      ...(next.removed ? { removedTeam: true } : {}),
    };
    for (const r of this.registry.all()) {
      if (r.host !== this.host || r.team !== next.team || r.teamChannel !== next.channel || r.agentId === opts.skipAgentId) continue;
      this.notifyAgent(r.agentId, Methods.teamRoster, { update });
    }
  }

  /** One warning per channel that more than one team claims (v4-13, #113). */
  private noteChannelConflict(rec: TeamRecord): void {
    if (rec.removed) return;
    const others = [...this.teamRecords.values()].filter((t) => !t.removed && t.channel === rec.channel && (t.host !== rec.host || t.team !== rec.team));
    if (!others.length || this.teamConflicts.has(rec.channel)) return;
    this.teamConflicts.add(rec.channel);
    this.log(`channel #${rec.channel} is used by ${[...others, rec].map((t) => `${t.team}@${t.host}`).join(", ")}; a message without a target is ambiguous`);
  }

  private storeTeam(rec: TeamRecord, from?: Peer, opts: { skipAgentId?: string } = {}): void {
    const key = rosterKey(rec);
    const current = this.teamRecords.get(key);
    const contentHash = this.teamHash(rec);
    // Identical content is a no-op: no revision bump, no roster note, no broadcast. This is what
    // makes `team start`/`team sync` idempotent and keeps a removed member from reappearing.
    if (current?.contentHash === contentHash && !rec.removed) return;
    // A strictly newer revision wins. Equal means a replay/retry: applying it again would only
    // reopen a window for a stale clock to overwrite a genuine update (v4-11 review).
    if (current?.revision !== undefined && rec.revision !== undefined && current.revision >= rec.revision) return;
    const next: TeamRecord = { ...rec, contentHash };
    this.teamRecords.set(key, next);
    this.saveTeams();
    this.noteChannelConflict(next);
    this.notifyRosterChange(current, next, opts);
    if (this.isRoot) for (const child of this.children.values()) if (child !== from && (child.meta.features as string[] | undefined)?.includes("teams")) child.notify(Methods.teamUpsert, { team: next });
  }

  private saveTeams(): void {
    try {
      const tmp = `${this.teamsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.teamRecords.values()], null, 2));
      renameSync(tmp, this.teamsFile);
    } catch (err) {
      this.log(`cannot save teams.json: ${(err as Error).message}`);
    }
  }

  /** A registering member teaches this daemon its roster (from teamDir when readable) and publishes it. */
  private learnTeam(rec: AgentRecord): void {
    if (!rec.team || !rec.teamChannel) return;
    const key = rosterKey({ host: rec.host, team: rec.team, channel: rec.teamChannel });
    const current = this.teamRecords.get(key);
    if (current?.removed) {
      if (!this.teamRemovedLogged.has(key)) {
        this.teamRemovedLogged.add(key);
        this.log(`team ${rec.team} was removed; ${rec.member ?? rec.name} stays registered but the roster is ignored (run cafe team start to restore it)`);
      }
      return;
    }
    // Registration reports presence. Only a local operator publishing a roster can set its membership.
    if (current?.authoritative) return;
    const members = current?.members ?? [];
    const name = rec.member ?? rec.name;
    if (members.some((m) => m.name === name)) return;
    const member: TeamRecord["members"][number] = { name, duty: rec.duty, description: rec.description, tags: rec.tags, scope: rec.scope, mode: "headless", dir: rec.cwd, channels: rec.channels, observer: rec.observer };
    const revision = Math.max(Date.now(), (current?.revision ?? 0) + 1);
    const team: TeamRecord = { team: rec.team, host: rec.host, channel: rec.teamChannel, members: [...members, member], revision, authoritative: false };
    this.storeTeam(team, undefined, { skipAgentId: rec.agentId });
    if (!this.isRoot && this.rootOnline) {
      if (this.rootSupports("teams")) {
        this.teamLocalLogged = false;
        const saved = this.teamRecords.get(key);
        if (saved) this.uplink!.notify(Methods.teamUpsert, { team: saved });
      } else if (!this.teamLocalLogged) {
        this.teamLocalLogged = true;
        this.log("root does not advertise teams; rosters stay local (cafe team status shows this)");
      }
    }
  }

  /**
   * Publish a roster read from disk even when no worker starts (a TUI-only team), so the Teams
   * page and `to: <team>` do not have to wait for the first registration (v4-11 review). v4-13:
   * this is the only operation that clears a tombstone, and it always publishes the full roster.
   */
  publishRoster(rosterDir: string, team: TeamSpec): void {
    const parsed = TeamLaunchSpec.safeParse(team);
    if (!parsed.success) throw new RpcError("bad_request", parsed.error.message);
    team = parsed.data;
    if (!team.name || !team.channel) return;
    const key = rosterKey({ host: this.host, team: team.name, channel: team.channel });
    const previous = this.teamRecords.get(key);
    const canonical = realpathSync(rosterDir);
    const owners = new Map(Object.entries(this.store.getKv<Record<string, string>>("rosterOwners") ?? {}));
    const owner = owners.get(key);
    if (owner && owner !== canonical) {
      throw new RpcError("bad_request", `team ${team.name} uses roster directory ${owner}; run cafe team sync there`);
    }
    if (!owner) {
      owners.set(key, canonical);
      this.store.setKv("rosterOwners", Object.fromEntries(owners));
    }
    const members = team.members.map((m) => ({ ...m, channels: m.channels?.length ? m.channels : [team.channel!] }));
    this.storeTeam({ team: team.name, host: this.host, channel: team.channel, members, revision: Math.max(Date.now(), (previous?.revision ?? 0) + 1), authoritative: true, removed: false });
    if (!this.isRoot && this.rootOnline && this.rootSupports("teams")) {
      const saved = this.teamRecords.get(key);
      if (saved) this.uplink!.notify(Methods.teamUpsert, { team: saved });
    }
    this.log(`roster ${team.name} published from ${rosterDir}`);
  }

  /** Remove a roster everywhere the network remembers it (v4-13, #113). Returns how many records were tombstoned. */
  removeTeam(teamName: string, host: string = this.host, from?: Peer): number {
    let removed = 0;
    for (const [key, t] of [...this.teamRecords]) {
      if (t.host !== host || t.team !== teamName || t.removed) continue;
      this.storeTeam({ ...t, members: [], removed: true, revision: Math.max(Date.now(), (t.revision ?? 0) + 1) }, from);
      if (this.teamRecords.get(key)?.removed) removed++;
      // A child cannot broadcast to the network; the Root stores the tombstone and re-broadcasts it.
      if (!this.isRoot && this.rootOnline && this.rootSupports("teams")) {
        const saved = this.teamRecords.get(key);
        if (saved) this.uplink!.notify(Methods.teamUpsert, { team: saved });
      }
    }
    return removed;
  }

  /** The playbook + roster a registering member receives (v4-13). */
  private teamContextFor(rec: AgentRecord): TeamContext | undefined {
    if (!rec.team || !rec.teamChannel) return undefined;
    const team = this.teams().find((t) => t.host === rec.host && t.team === rec.team && t.channel === rec.teamChannel);
    if (!team) return undefined;
    const orch = team.roster.find((m) => m.duty === "orchestrator");
    const self = team.roster.find((m) => m.name === (rec.member ?? rec.name));
    if (!orch || !self) return undefined;
    const roster = this.rosterEntries(team);
    const playbook = renderTeamPlaybook({ team: team.team, channel: team.channel, self: { name: self.name, ...(self.duty ? { duty: self.duty } : {}), online: true }, orchestrator: orch.name, roster });
    return {
      team: team.team,
      channel: team.channel,
      ...(team.revision !== undefined ? { revision: team.revision } : {}),
      self: { name: self.name, ...(self.duty ? { duty: self.duty } : {}), mode: rec.mode },
      orchestrator: orch.name,
      roster,
      playbook,
    };
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
      saveConfig(this.config, this.store.home);
      const rec = this.daemonRecords.get(host);
      // A cleared pin must fall back to the address the Root verified, not keep the stale pin (#75).
      // A cleared pin goes back to what the child itself reports, then to the address the Root verified —
      // never to an older remembered one (#75, #92).
      if (rec) rec.url = this.reportedUrls.get(host) ?? this.verifiedAddress(host) ?? rec.url;
      this.emitDaemons();
      this.log(`cleared pinned address for ${host}`);
      return this.daemons().find((d) => d.host === host) ?? record!;
    }
    const pin = assertDaemonAddress(url).replace(/^ws:\/\//, "");
    // Prove the new address before it reaches the children: a hand-typed Docker address is as useless
    // to them as a self-reported one (#75). The probe goes first, so "saved" is never shown for an
    // address the Root just failed to reach (#83), and a failed probe never overwrites the address a
    // Host that is online right now is reachable at (#103).
    const probe = await this.rememberChildUrl(host, pin);
    const online = this.children.has(host);
    if (probe.verified) {
      this.config.pinnedDaemons[host] = pin;
      saveConfig(this.config, this.store.home);
      const rec = this.daemonRecords.get(host);
      if (rec) rec.url = this.pinnedAddress(host)!;
      this.emitDaemons();
      this.log(`pinned ${host} -> ${pin}`);
    } else if (!online) {
      // The Host is away: remember where to look for it when it comes back. It stays unverified, so
      // it is never broadcast and never hides a reachable address (see `daemons()`).
      this.config.pinnedDaemons[host] = pin;
      saveConfig(this.config, this.store.home);
      this.log(`saved unverified address for ${host} -> ${pin} (not reachable from the Root)`);
    } else {
      this.log(`not saving ${host} address ${pin}: not reachable from the Root; keeping ${record?.url ?? "its current address"}`);
    }
    const result = this.daemons().find((d) => d.host === host) ?? record!;
    return { ...result, ...probe };
  }

  /** Root: the internal id for a Host name — id, display name, alias or legacy alias, of a live or remembered Host. */
  private resolveHostId(name: string): string | undefined {
    const n = name.trim();
    if (!n) return undefined;
    if (this.daemonRecords.has(n) || n in this.config.knownDaemons || n in this.config.pinnedDaemons || n in this.config.hostNames) return n;
    for (const d of this.daemonRecords.values()) {
      if (d.host === "__root__") continue;
      if (d.displayName === n || d.aliases.includes(n) || (d.legacyAliases ?? []).includes(n)) return d.host;
    }
    for (const [host, x] of Object.entries(this.config.hostNames)) {
      if (x.displayName === n || x.aliases.includes(n) || x.legacyAliases.includes(n)) return host;
    }
    return undefined;
  }

  /**
   * Root: forget an offline Host everywhere the network remembers it (v4-8). Not a ban: a machine that
   * still has the token reconnects and reappears. Threads are kept.
   */
  async forgetHost(name: string): Promise<{ host: string; agents: number; config: string[] }> {
    if (!this.isRoot) throw new RpcError("not_root", "only the hub can remove a machine; open the hub's Network page");
    const host = this.resolveHostId(name);
    if (!host) throw new RpcError("not_found", `no machine '${name}'`);
    if (host === this.host) throw new RpcError("bad_request", "this is the hub itself; it cannot be removed");
    const online = () => new RpcError("host_online", `${this.daemonRecords.get(host)?.displayName ?? host} is connected right now. Stop cafe on it first (cafe daemon stop), then remove it.`);
    const pinged = this.children.get(host);
    if (pinged && (await this.uplinkAlive(host))) throw online();
    // No await from here on: a child that reconnected during the check is a new peer and stays (§3.2).
    if (this.children.get(host) !== pinged) throw online();
    if (pinged) {
      // A connection that no longer answers: close it, so a machine that is in fact alive reconnects.
      this.children.delete(host);
      pinged.close();
    }
    this.forgotten.set(host, Date.now());
    this.daemonRecords.delete(host);
    this.reportedUrls.delete(host);
    this.refusedPlaintext.delete(host);
    const ids = this.registry.all().filter((r) => r.host === host).map((r) => r.agentId);
    if (ids.length) this.broadcastDelta(this.registry.remove(ids));
    const config: string[] = [];
    for (const key of ["knownDaemons", "pinnedDaemons", "hostNames"] as const) {
      if (host in this.config[key]) {
        delete this.config[key][host];
        config.push(`${key}.${host}`);
      }
    }
    if (config.length) saveConfig(this.config, this.store.home);
    // A forgotten Host's rosters must not linger: a stale member name could make a bare team
    // address ambiguous or resolve to a machine that is no longer part of the network.
    let droppedTeams = 0;
    for (const key of [...this.teamRecords.keys()]) {
      if (key.startsWith(`${host}/`)) {
        this.teamRecords.delete(key);
        droppedTeams++;
      }
    }
    if (droppedTeams) this.saveTeams();
    this.emitDaemons();
    for (const child of this.children.values()) child.notify(Methods.hostForgotten, { host });
    this.log(`forgot host ${host} (${ids.length} agent(s)${config.length ? `; ${config.join(", ")}` : ""})`);
    return { host, agents: ids.length, config };
  }

  /**
   * Child: the Root forgot `host` (v4-8). Drop its address and direct link, and the TLS pins for its
   * endpoints — unless another peer or the Root uses the same endpoint (a reused address must not lose a
   * live peer's pin: clearing it would silently trust that peer's next key).
   */
  private onHostForgotten(x: { host: string }): void {
    const host = x?.host;
    if (!host || host === this.host || host === this.rootHost || host === "__root__") return;
    const link = this.links.get(host);
    if (link) {
      this.links.delete(host);
      link.ws.close();
    }
    const url = this.peerUrls.get(host);
    if (url === undefined) return;
    this.peerUrls.delete(host);
    this.store.setKv("peerUrls", Object.fromEntries(this.peerUrls));
    const keyOf = (u: string) => u.replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
    const keysFor = (u: string) => {
      const plain = keyOf(u);
      const tls = this.tlsEndpoints.get(plain);
      return tls ? [plain, keyOf(tls)] : [plain];
    };
    const inUse = new Set<string>([...[...this.peerUrls.values()].flatMap(keysFor), ...(this.config.root ? keysFor(this.config.root) : [])]);
    const pins = this.config.security.tls.pins;
    let changed = false;
    for (const k of keysFor(url)) {
      if (k in pins && !inUse.has(k)) {
        delete pins[k];
        changed = true;
      }
    }
    if (changed) saveConfig(this.config, this.store.home);
    this.log(`hub forgot host ${host}; dropped its address${changed ? " and TLS pin" : ""}`);
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
    for (const child of this.children.values()) child.notify(Methods.registryDelta, this.deltaFor(delta, child.meta.features as string[] | undefined));
  }

  /**
   * v4-12 D5: an incapable routing peer must not learn an Agent it would mishandle — an old
   * Daemon's `eligible()` knows neither `observer` nor `channels`, so publishing an observer or a
   * channel-only member to it would let it select that Agent. The local registry keeps the record;
   * the peer simply does not see it until it upgrades (a new connection resyncs).
   */
  private publishableTo(rec: AgentRecord, features: readonly string[] | undefined): boolean {
    const caps = features ?? [];
    if (rec.observer && !caps.includes("digests")) return false;
    if (!caps.includes("channels") && !channelsOf(rec).includes(DEFAULT_CHANNEL)) return false;
    return true;
  }

  private deltaFor(delta: RegistryDelta, features: readonly string[] | undefined): RegistryDelta {
    if (!delta.upsert.length) return delta;
    const upsert = delta.upsert.filter((r) => this.publishableTo(r, features));
    return upsert.length === delta.upsert.length ? delta : { ...delta, upsert };
  }

  // -------------------------------------------------------------------------
  // Orders (origin side)
  // -------------------------------------------------------------------------

  /**
   * Create an Order. `idempotencyKey` makes a repeated request inside a short
   * window return the first Order/Thread; the key is the caller's (a platform
   * event id for connectors, v4-3 Q4). Without a key nothing is deduplicated.
   */
  async createOrder(p: CreateOrderParams, peer?: Peer, ownerKey?: string): Promise<CreatedOrder> {
    const key = p.idempotencyKey;
    if (!key) return this.createOrderInner(p, peer, ownerKey);
    const now = Date.now();
    this.pruneIdempotent(now);
    const hit = this.idempotentOrders.get(key);
    if (hit && hit.expiresAt > now) {
      if (hit.result) return hit.result;
      if (hit.pending) return hit.pending;
    }
    const entry: IdempotentOrder = { at: now, expiresAt: now + IDEMPOTENCY_WINDOW_MS };
    this.idempotentOrders.set(key, entry);
    entry.pending = this.createOrderInner(p, peer, ownerKey);
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

  private async createOrderInner(p: CreateOrderParams, peer?: Peer, ownerKey?: string): Promise<CreatedOrder> {
    if (this.draining) throw new RpcError("daemon_draining", "the daemon is draining for an update; retry after it restarts");
    const from: Party = peer?.meta.party ?? { id: `cli:${ulid()}`, address: `${p.as ?? "cli"}@${this.host}`, host: this.host };
    if (p.escalate && !p.parentOrderId) throw new RpcError("unknown_parent", "escalate: true requires parentOrderId");
    if (p.parentThreadId && !p.parentOrderId) throw new RpcError("bad_request", "parentThreadId requires parentOrderId");
    const parent = p.parentOrderId ? this.findParentOrder(p.parentOrderId, p.parentThreadId) : undefined;
    // Provenance-only parentOrderId keeps its legacy meaning: it may be an ID this Host no longer
    // indexes. A linked child or an escalation must resolve to a real parent.
    if ((p.escalate || p.parentThreadId) && p.parentOrderId && !parent) throw new RpcError("unknown_parent", `cannot find parent order ${p.parentOrderId}`);
    if (p.parentThreadId && parent!.threadId !== p.parentThreadId) {
      throw new RpcError("unknown_parent", `parent order ${p.parentOrderId} is not in thread ${p.parentThreadId}`);
    }
    if (p.escalate) {
      const agentId = peer?.meta.agentId as string | undefined;
      if (!agentId || this.agents.get(agentId) !== peer || !this.wasDelivered(parent!, agentId, this.host)) {
        throw new RpcError("not_a_target", "escalate: only a registered Barista that received the parent Order may create a sub-Thread");
      }
    }
    const needsHuman = Boolean(p.escalate && !p.to && !p.broadcast && parent?.humanClarifications &&
      parent.from.id.startsWith("cli:") && peer && this.agents.get(from.id) === peer &&
      this.wasDelivered(parent, from.id, this.host, true));
    if (needsHuman && parent!.from.host !== this.host && (!this.rootOnline ||
      (!this.isRoot && !this.rootSupports("human-clarifications")) ||
      !this.daemons().some((d) => d.host === parent!.from.host && d.online && d.features?.includes("human-clarifications")))) {
      throw new RpcError("parent_unavailable", "the original requester’s Host is offline or does not support human clarifications");
    }
    // Follow-up: continue an existing Thread. An escalation is always a NEW sub-Thread: one open
    // Order per Thread is the invariant that keeps replies/history/cancel unambiguous (v4-11).
    let prior: ThreadMeta | undefined;
    if (!p.escalate && p.threadId) {
      prior = this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
      if (!prior) throw new RpcError("not_found", `unknown thread ${p.threadId}`);
      if (prior.clarification) throw new RpcError("clarification_required", "answer the clarification from the original conversation");
      const tc = prior.channel ?? DEFAULT_CHANNEL;
      if (p.channel && p.channel !== tc) throw new RpcError("channel_mismatch", `thread ${prior.threadId} is in channel ${tc}`);
    }
    let effectiveParentOrderId = p.parentOrderId ?? prior?.parentOrderId;
    let effectiveParentThreadId = p.parentThreadId ?? prior?.parentThreadId;
    if (prior?.parentThreadId && prior.parentOrderId) {
      if ((p.parentOrderId && p.parentOrderId !== prior.parentOrderId) || (p.parentThreadId && p.parentThreadId !== prior.parentThreadId)) {
        throw new RpcError("conflict", "a linked Thread cannot change its parent Order");
      }
      effectiveParentOrderId = prior.parentOrderId;
      effectiveParentThreadId = prior.parentThreadId;
    } else if (prior && p.parentThreadId) {
      throw new RpcError("conflict", "an existing Thread cannot be linked to a parent retroactively");
    }
    const linkedParent = effectiveParentOrderId
      ? parent?.orderId === effectiveParentOrderId ? parent : this.findParentOrder(effectiveParentOrderId, effectiveParentThreadId)
      : undefined;
    const linkedFollowup = !!(prior?.parentOrderId && prior.parentThreadId);
    const needsResolvedParent = !!effectiveParentThreadId || !!p.escalate || linkedFollowup;
    if (needsResolvedParent && effectiveParentOrderId && !linkedParent) throw new RpcError("unknown_parent", `cannot find parent order ${effectiveParentOrderId}`);
    if (effectiveParentThreadId && !effectiveParentOrderId) throw new RpcError("bad_request", "parentThreadId requires parentOrderId");
    if (effectiveParentThreadId && linkedParent?.threadId !== effectiveParentThreadId) {
      throw new RpcError("unknown_parent", `parent order ${effectiveParentOrderId} is not in thread ${effectiveParentThreadId}`);
    }
    const linkedTask = !!effectiveParentThreadId && !p.escalate;
    const agentId = peer?.meta.agentId as string | undefined;
    const parentAgentDelivery = !!(!linkedFollowup && peer && agentId && this.agents.get(agentId) === peer && linkedParent && this.wasDelivered(linkedParent, agentId, this.host));
    const parentCreator = !!(linkedFollowup && peer && agentId === prior!.from.id && prior!.from.host === this.host && linkedParent && this.wasDelivered(linkedParent, agentId, this.host));
    const priorChildOrder = linkedFollowup ? this.findParentOrder(prior!.orderId, prior!.threadId) : undefined;
    const priorChildDelivery = !!(peer && agentId && this.agents.get(agentId) === peer && priorChildOrder && this.wasDelivered(priorChildOrder, agentId, this.host));
    const ownerLinkedParent = !!(!peer && p.origin !== "agent" && linkedParent && this.ownsHumanOrder(linkedParent, ownerKey));
    if (linkedTask && !parentAgentDelivery && !parentCreator && !priorChildDelivery && !ownerLinkedParent) {
      throw new RpcError(p.origin === "agent" || peer ? "not_a_target" : "not_owner", "linked work requires the parent recipient or its human owner");
    }
    let replacing: Tracking | undefined;
    if (p.replaceOrderId && (!prior || prior.orderId !== p.replaceOrderId)) throw new RpcError("stale_order", "the Order selected for replacement is no longer current");
    if (prior) {
      const tracked = this.tracking.get(prior.orderId);
      const open = tracked?.status === "open" && tracked.order.threadId === prior.threadId ? tracked : undefined;
      if (p.replaceOrderId && !open) throw new RpcError("stale_order", "the Order selected for replacement is no longer open");
      if (open && !p.replace && !p.replaceOrderId) {
        throw new RpcError("thread_busy", `the previous question in this thread is still open; wait or run \`cafe cancel ${prior.threadId}\``);
      }
      if (open) {
        const ownsOpen = peer
          ? open.customerPeer === peer || (!!agentId && this.agents.get(agentId) === peer && open.order.from.id === agentId)
          : this.ownsCancellation(open.order, ownerKey);
        if (!ownsOpen || open.order.from.host !== this.host) throw new RpcError("not_order_owner", "only the requester can replace this Order");
        replacing = open;
      } else if ((prior.status === "routing" || prior.status === "delivering" || prior.status === "working") && !this.closingEvent(prior.threadId, prior.orderId)) {
        throw new RpcError("thread_busy", `the previous Order may still be open on its originating Host; verify or cancel it there before following up`);
      }
    }
    const parentOwnerVerified = ownerLinkedParent || prior?.parentOwnerVerified === true;
    const effectiveParent = linkedParent ?? parent;
    const contextParentThreadId = effectiveParentThreadId ?? (p.escalate ? parent?.threadId : undefined);
    const depth = effectiveParent ? effectiveParent.depth + 1 : 0;
    const parentContext = effectiveParent && effectiveParent.threadId === contextParentThreadId
      ? effectiveParent.from.id === from.id
        ? summarize(effectiveParent.body, 639)
        : this.deliveredParentBodies.get(`${effectiveParent.orderId}:${from.id}`)
      : undefined;
    if (depth > MAX_ORDER_DEPTH) throw new RpcError("too_deep", `order depth ${depth} exceeds ${MAX_ORDER_DEPTH}`);

    const threadId = p.escalate ? ulid() : prior?.threadId ?? ulid();
    // Channel (v4-11). A follow-up and a sub-Thread inherit; an explicit channel on a fresh Order
    // wins; a registered Agent defaults to its home channel (the first one it listed).
    const parentChannel = p.escalate && parent ? (this.metas.get(parent.threadId)?.channel ?? this.store.getThread(parent.threadId)?.channel ?? DEFAULT_CHANNEL) : undefined;
    let channel: string;
    if (p.escalate) {
      channel = parentChannel ?? DEFAULT_CHANNEL;
      if (p.channel && p.channel !== channel) throw new RpcError("channel_mismatch", `an escalation stays in its parent thread's channel (${channel})`);
    } else if (prior) {
      const tc = prior.channel ?? DEFAULT_CHANNEL;
      if (p.channel && p.channel !== tc) throw new RpcError("channel_mismatch", `thread ${prior.threadId} is in channel ${tc}`);
      channel = tc;
    } else if (p.channel) {
      channel = p.channel;
    } else {
      const rec = peer?.meta.agentId ? (this.local.get(peer.meta.agentId) ?? this.registry.get(peer.meta.agentId)) : undefined;
      channel = rec ? channelsOf(rec)[0]! : DEFAULT_CHANNEL;
    }
    // Blobs were uploaded to this daemon before the Order; move them into the Thread now.
    const attachments = p.attachments?.length ? this.commitAttachments(p.attachments, threadId) : undefined;
    const owner = !peer && p.origin !== "agent" && !p.escalate && p.kind === "order" ? OwnershipKey.safeParse(ownerKey) : undefined;
    const order: Order = {
      orderId: ulid(),
      threadId,
      kind: p.kind,
      channel,
      ...(p.collect ? { collect: p.collect } : {}),
      from,
      ...(owner?.success ? { humanClarifications: true as const } : {}),
      ...(needsHuman ? { needsHuman: true as const } : {}),
      // Agent RPC identity is authoritative; HTTP owner-linked children are attributed to their human owner.
      origin: ownerLinkedParent ? "human" : peer?.meta.party ? "agent" : p.origin ?? "human",
      via: ownerLinkedParent ? undefined : peer?.meta.party ? { id: peer.meta.party.id, address: peer.meta.party.address } : p.via,
      to: p.to,
      body: p.body,
      ...(attachments?.length ? { attachments } : {}),
      parentOrderId: effectiveParentOrderId,
      ...(parentContext ? { parentContext } : {}),
      ...(parentOwnerVerified ? { parentOwnerVerified: true as const } : {}),
      ...(p.escalate ? { parentThreadId: effectiveParentThreadId ?? parent?.threadId, escalate: true } : effectiveParentThreadId ? { parentThreadId: effectiveParentThreadId } : {}),
      chain: [...(effectiveParent?.chain ?? []), ...(effectiveParent ? [effectiveParent.from.id] : [])],
      depth,
      deadlineMs: p.deadlineMs,
      createdAt: Date.now(),
      turn: prior ? prior.turns + 1 : 1,
      history: prior ? this.history(prior) : [],
    };
    // Keep the selected recipient and the stored channel aligned for fresh explicit orders.
    const explicit = !p.escalate && !prior && !p.channel && order.to ? this.explicitDecision(order) : undefined;
    const target = explicit?.targets[0];
    const targetChannel = target ? this.registry.get(target)?.teamChannel : undefined;
    if (targetChannel) order.channel = targetChannel;
    if (owner?.success) this.store.setKv(`human-owner:${order.orderId}`, ownershipDigest(owner.data));
    const cancellationOwner = !peer ? OwnershipKey.safeParse(ownerKey) : undefined;
    if (cancellationOwner?.success) this.store.setKv(`cancel-owner:${order.orderId}`, ownershipDigest(cancellationOwner.data));
    this.knownOrders.set(order.orderId, order);
    // Capture the preceding turn before creating the new turn resets this metadata.
    const answeredBefore = prior ? [...new Set(prior.replies.filter((reply) => reply.at < (prior!.closedAt ?? Number.POSITIVE_INFINITY)).map((r) => r.agentId))] : [];
    const priorTargets = prior ? (prior.targetStates?.length ? prior.targetStates.map((s) => s.agentId) : prior.targets) : [];
    const routeNew = () => this.route(order, { isFollowUp: !!prior, responders: answeredBefore, priorTargets }, p.broadcast ?? false);
    let acceptedReplacement: RoutingDecision | undefined;
    if (replacing) {
      acceptedReplacement = await routeNew();
      if (replacing.status !== "open" || (this.metas.get(threadId) ?? this.store.getThread(threadId))?.orderId !== replacing.order.orderId) {
        throw new RpcError("stale_order", "the previous Order changed while routing the replacement");
      }
      if (!acceptedReplacement.targets.length || Date.now() >= order.createdAt + (order.deadlineMs ?? this.timing.unicastDeadlineMs)) {
        throw new RpcError("replacement_unroutable", acceptedReplacement.reason || "no eligible target for the replacement");
      }
      this.emitEvent(replacing.order, { type: "order.cancelled", by: "replaced" });
      this.close(replacing, "cancelled");
    }
    if (peer) this.subscribe(order.threadId, peer);
    const customerPeer = peer && !peer.meta.party ? peer : undefined;
    const t: Tracking = { order, customerPeer, status: "open", replied: false, targets: new Map(), candidates: [], timers: new Map() };
    this.tracking.set(order.orderId, t);
    this.emitEvent(order, { type: "order.created", order });

    const decision: RoutingDecision = needsHuman
      ? { targets: [], mode: "unicast", reason: "escalate to the person in the original conversation", router: "explicit", candidates: [], needsHuman: true }
      : acceptedReplacement ?? explicit ?? await routeNew();
    if (t.status !== "open") return { orderId: order.orderId, threadId: order.threadId, decision };
    t.decision = decision;
    t.candidates = [...decision.candidates];
    this.emitEvent(order, { type: "order.routed", decision });
    if (needsHuman) {
      this.close(t, "done");
      return { orderId: order.orderId, threadId: order.threadId, decision };
    }
    if (decision.targets.length === 0) {
      this.emitEvent(order, { type: "order.failed", reason: decision.failure ?? "no barista available" });
      this.close(t, "failed");
      return { orderId: order.orderId, threadId: order.threadId, decision };
    }
    const defaultMs = order.kind === "notice" || decision.mode !== "unicast" ? this.timing.broadcastDeadlineMs : this.timing.unicastDeadlineMs;
    const deadlineAt = order.createdAt + (order.deadlineMs ?? defaultMs);
    if (Date.now() >= deadlineAt) {
      for (const id of decision.targets) t.targets.set(id, "pending");
      this.finishOnDeadline(t);
      return { orderId: order.orderId, threadId: order.threadId, decision };
    }
    // Route time consumes the same absolute hard lifetime as execution and recovery.
    t.deadline = setTimeout(() => this.finishOnDeadline(t), deadlineAt - Date.now());
    for (const id of decision.targets) this.dispatch(t, id);
    return { orderId: order.orderId, threadId: order.threadId, decision };
  }

  /** Hydrate only the publishing turn when serving a missed clarification on its original Host. */
  async catchUpClarification(parentThreadId: string, threadId: string): Promise<void> {
    if (this.isRoot || !this.rootOnline || !this.rootSupports("team-child-view")) return;
    const parent = this.metas.get(parentThreadId) ?? this.store.getThread(parentThreadId);
    if (parent?.from.host !== this.host) return;
    const link = this.uplink!;
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (meta?.clarification && this.closingEvent(threadId, meta.clarification.orderId)) return;
    const page = await link.request<{ events: ThreadEnvelope[] } | undefined>("thread/linked-detail", { threadId, parentThreadId, clarificationOnly: true }, 2000);
    const current = this.metas.get(threadId) ?? this.store.getThread(threadId);
    const known = new Set(current ? this.store.readEvents(current.file).map((env) => env.eventId) : []);
    for (const env of page?.events ?? []) {
      if (!known.has(env.eventId)) this.recordEvent(env, { from: link, skipTrack: true });
    }
  }

  answerClarification(parentThreadId: string, threadId: string, input: { clarificationOrderId: string; text: string }, ownerKey?: string): CreatedOrder {
    const key = OwnershipKey.safeParse(ownerKey);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 12_000) throw new RpcError("bad_request", "answer text must be 1–12000 characters");
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!meta?.clarification || meta.clarification.orderId !== input.clarificationOrderId || meta.parentThreadId !== parentThreadId) {
      throw new RpcError("not_found", "no matching clarification in this conversation");
    }
    const parent = this.linkedParent(meta);
    const digest = parent && this.store.getKv<string>(`human-owner:${parent.orderId}`);
    if (parent?.from.host !== this.host || !digest || !key.success || ownershipDigest(key.data) !== digest ||
      !this.wasDelivered(parent, meta.from.id, meta.from.host, true)) {
      throw new RpcError("not_owner", "open this conversation on its original Host with the client that asked the question");
    }
    const decision = this.clarificationAnswerRoute(meta.from);
    // JSONL is the acceptance record. The metadata write can lag a journal append at a crash.
    const committed = this.store.findLastEvent(meta.file, ({ event }) => event.type === "order.created" && !!event.order.clarificationRecipient);
    if (committed?.event.type === "order.created" || meta.turns > 1) {
      const answer = committed?.event.type === "order.created" ? committed.event.order : undefined;
      if (answer?.body === text) return { orderId: answer.orderId, threadId, decision };
      throw new RpcError("conflict", "this clarification already has an answer");
    }
    if (!this.closingEvent(threadId, meta.clarification.orderId)) throw new RpcError("conflict", "the clarification is still being published; retry shortly");
    const rec = this.registry.get(meta.from.id);
    if (!rec || rec.role !== "barista" || rec.host !== meta.from.host || rec.status === "offline" ||
      (rec.host === this.host ? !this.agents.has(rec.agentId) : !this.rootOnline)) {
      throw new RpcError("requester_offline", "the member who asked is offline; your answer has not been accepted");
    }
    const order: Order = {
      orderId: ulid(), threadId, kind: "order", from: parent.from, channel: meta.channel, origin: "human", body: text,
      clarificationRecipient: meta.from, parentThreadId, parentOrderId: parent.orderId, parentContext: summarize(parent.body, 639),
      chain: [], depth: parent.depth + 1, createdAt: Date.now(), turn: 2, deadlineMs: this.timing.unicastDeadlineMs,
      history: [{ from: meta.from.address, agentId: meta.from.id, role: "barista", text: compactHistoryText(meta.clarification.question) }],
    };
    if (!this.isRoot && !this.rootOnline) this.markBackfill(threadId);
    const tracking: Tracking = { order, status: "open", replied: false, targets: new Map(), candidates: [], timers: new Map(), decision };
    this.tracking.set(order.orderId, tracking);
    this.emitEvent(order, { type: "order.created", order });
    this.emitEvent(order, { type: "order.routed", decision });
    this.dispatch(tracking, meta.from.id);
    tracking.deadline = setTimeout(() => this.finishOnDeadline(tracking), this.timing.unicastDeadlineMs);
    return { orderId: order.orderId, threadId, decision };
  }

  private clarificationAnswerRoute(recipient: Party): RoutingDecision {
    return { targets: [recipient.id], mode: "unicast", reason: "answer to the original clarification requester", router: "explicit", candidates: [] };
  }

  private eligible(order: Order): AgentRecord[] {
    const excluded = new Set([order.from.id, ...order.chain]);
    const channel = order.channel ?? DEFAULT_CHANNEL;
    return this.registry
      .all()
      .filter((r) => r.role === "barista" && r.status !== "offline" && !excluded.has(r.agentId))
      .filter((r) => !r.observer && channelsOf(r).includes(channel))
      .filter((r) => this.inTeamRoster(r))
      .filter((r) => this.rootOnline || r.host === this.host || this.peerUrls.has(r.host));
  }

  /**
   * An authoritative `.cafe` roster owns membership: an agent removed from it must not be a
   * routing target even while its process is still registered (v4-13). A loose team has no roster
   * to enforce, and a non-team agent always passes.
   */
  private inTeamRoster(r: AgentRecord): boolean {
    if (!r.team || !r.teamChannel) return true;
    const rec = this.teamRecords.get(rosterKey({ host: r.host, team: r.team, channel: r.teamChannel }));
    if (!rec) return true;
    if (rec.removed) return false;
    if (!rec.authoritative) return true;
    return rec.members.some((m) => m.name === (r.member ?? r.name));
  }

  /** Earlier turns of a Thread, oldest first, bounded for prompt size. */
  private history(meta: ThreadMeta): Order["history"] {
    const out: Order["history"] = [];
    const events = this.store.readMatchingEvents(meta.file, 12, ({ event }) =>
      event.type === "order.created" || (event.type === "order.replied" && event.final),
    );
    for (const env of events) {
      const ev = env.event;
      if (ev.type === "order.created") out.push({ from: ev.order.from.address, role: "customer", text: compactHistoryText(ev.order.body) });
      else if (ev.type === "order.replied" && ev.final) {
        const speaker = this.registry.get(ev.agentId)?.address ?? ev.agentId;
        const text = ev.source === "operator" ? `[operator override for ${speaker} — not the Barista's own words] ${ev.text}` : ev.text;
        out.push({ agentId: ev.agentId, from: speaker, role: "barista", text: compactHistoryText(text) });
      }
    }
    return out;
  }

  /**
   * The parent Order of a sub-Thread (v4-11). `knownOrders` is memory and bounded, so fall back to
   * the parent Thread's JSONL. Returning undefined is a hard `unknown_parent`, never a router guess.
   */
  private findParentOrder(orderId: string, parentThreadId?: string): Order | undefined {
    const known = this.knownOrders.get(orderId);
    if (known) return known;
    if (!parentThreadId) return undefined;
    const meta = this.metas.get(parentThreadId) ?? this.store.getThread(parentThreadId);
    if (!meta) return undefined;
    const found = this.store.findLastEvent(meta.file, (env) => env.event.type === "order.created" && env.orderId === orderId);
    return found?.event.type === "order.created" ? found.event.order : undefined;
  }

  private async route(order: Order, followUp: { isFollowUp?: boolean; responders?: string[]; priorTargets?: string[] } = {}, broadcast = false): Promise<RoutingDecision> {
    if (order.escalate) return this.routeEscalation(order, broadcast);
    const candidates = this.eligible(order);
    const eligibleIds = new Set(candidates.map((c) => c.agentId));
    if (followUp.isFollowUp && !order.to && !broadcast) {
      // v4-13: a follow-up goes to the previous turn's final responders, then to that turn's
      // targets, then fails honestly. It never falls through to rules/LLM: a clarification
      // broadcast to an unrelated agent is worse than an error (#72).
      const responders = (followUp.responders ?? []).filter((id) => eligibleIds.has(id));
      const prior = (followUp.priorTargets ?? []).filter((id) => eligibleIds.has(id));
      const next = responders.length ? responders : prior;
      const scope = this.teamScope(order);
      if (next.length > 1 && (scope.team || scope.ambiguous)) {
        const names = next.map((id) => this.registry.get(id)?.address ?? id).join(", ");
        return { targets: [], mode: "unicast", reason: `choose a recipient for this follow-up with to: ${names}`, router: "followup", candidates: [], failure: "ambiguous_address" };
      }
      if (responders.length) {
        return {
          targets: responders,
          mode: responders.length === 1 ? "unicast" : "multicast",
          reason: `follow-up to ${responders.map((id) => this.registry.get(id)?.address ?? id).join(", ")}, who answered the previous turn`,
          router: "followup",
          candidates: [],
        };
      }
      if (prior.length) {
        return {
          targets: prior,
          mode: prior.length === 1 ? "unicast" : "multicast",
          reason: `follow-up to ${prior.map((id) => this.registry.get(id)?.address ?? id).join(", ")}, the previous turn's targets (no reply yet)`,
          router: "followup",
          candidates: [],
        };
      }
      return {
        targets: [],
        mode: "unicast",
        reason: `nobody who answered ${order.threadId} is online; address someone explicitly with to:, or start them`,
        router: "followup",
        candidates: [],
        failure: "responders_offline",
      };
    }
    if (order.to) return this.explicitDecision(order);
    if (broadcast) return this.broadcastDecision(order, candidates);
    // A fresh message with a team channel goes to the team's front door.
    const channel = order.channel ?? DEFAULT_CHANNEL;
    if (channel !== DEFAULT_CHANNEL) {
      const owners = this.liveRosters().filter((t) => t.channel === channel);
      if (owners.length > 1) {
        return { targets: [], mode: "unicast", reason: `channel #${channel} is used by several teams; address one with to:`, router: "explicit", candidates: [], failure: "ambiguous_channel" };
      }
      const owner = owners[0];
      if (owner) return this.frontDoorDecision(owner.team, this.teamFrontDoor(owner, order.from));
    }
    await this.routerReady();
    if (this.router.name === "rules" && this.config.router.fallback === "root" && !this.isRoot && this.rootOnline) {
      // An old Root's router lacks channel/duty inputs; for a scoped ask, decide locally from the
      // already channel-filtered candidates instead (v4-12 D6).
      const scoped = (order.channel ?? DEFAULT_CHANNEL) !== DEFAULT_CHANNEL;
      if (scoped && !this.rootSupports("channels")) {
        this.log("root does not advertise channels; routing this channel order locally");
      } else {
        try {
          return this.channelFailure(order, await this.uplink!.request<RoutingDecision>(Methods.routeDecide, { order, candidates: candidates.map((c) => c.agentId), broadcast }, 60_000));
        } catch (err) {
          this.log(`root route/decide failed: ${(err as Error).message}`);
        }
      }
    }
    return this.channelFailure(order, await this.router.decide({ order, candidates, hints: this.hintsFor(candidates) }));
  }

  private frontDoorDecision(name: string, result: ReturnType<Daemon["resolveTeamTarget"]>): RoutingDecision {
    const reason = result.failure === "self_delivery"
      ? `you are the front door of ${name}; address a member explicitly`
      : result.failure ? `team ${name}: ${result.failure}` : `team ${name} front door (orchestrator)`;
    return { targets: result.ids, mode: "unicast", reason, router: "explicit", candidates: [], failure: result.failure };
  }

  private broadcastDecision(order: Order, candidates: AgentRecord[]): RoutingDecision {
    const { team, ambiguous } = this.teamScope(order);
    if (ambiguous) return { targets: [], mode: "broadcast", reason: `channel #${order.channel} is shared; select a team before broadcasting`, router: "explicit", candidates: [], failure: "ambiguous_channel" };
    const targets = (team ? candidates.filter((r) => this.isTeamMember(r, team)) : candidates).map((r) => r.agentId);
    return this.channelFailure(order, { targets, mode: "broadcast", reason: team ? `explicit broadcast to team ${team.team}` : "customer asked everyone", router: "explicit", candidates: [] });
  }

  /**
   * A non-default channel with no eligible member is not "no barista available": name the scope so
   * an agent does not read it as "everyone is offline" (v4-11).
   */
  private channelFailure(order: Order, decision: RoutingDecision): RoutingDecision {
    if (decision.targets.length || decision.failure) return decision;
    const channel = order.channel ?? DEFAULT_CHANNEL;
    const elsewhere = this.registry.all().some((r) => r.role === "barista" && r.status !== "offline" && !r.observer && !channelsOf(r).includes(channel));
    // The eligible pool is empty. Name the scope whenever there is one (a non-default channel, or
    // baristas somewhere else); only a truly empty default network is a plain "nobody online".
    return { ...decision, failure: channel !== DEFAULT_CHANNEL || elsewhere ? "no_channel_members" : "no_online_barista" };
  }

  /**
   * An escalation is a sub-Thread that never consults the router: explicit target, else the channel
   * when broadcast was asked for, else the parent Order's sender. Parent offline is a visible
   * failure — never a broadcast to unrelated agents (v4-11, the #72 dogfooding bug).
   */
  private routeEscalation(order: Order, broadcast: boolean): RoutingDecision {
    if (order.to) return this.explicitDecision(order);
    if (broadcast) return this.broadcastDecision(order, this.eligible(order));
    const parent = order.parentOrderId ? this.findParentOrder(order.parentOrderId, order.parentThreadId) : undefined;
    const rec = parent ? this.registry.get(parent.from.id) : undefined;
    if (parent && (parent.from.id.startsWith("cli:") || rec?.role === "customer")) {
      return { targets: [], mode: "unicast", reason: "the requester is a person; ask for clarification in the original conversation", router: "explicit", candidates: [], failure: "parent_not_agent" };
    }
    if (rec && rec.role === "barista" && rec.status !== "offline") {
      return { targets: [rec.agentId], mode: "unicast", reason: `escalate to parent ${rec.address}`, router: "explicit", candidates: [] };
    }
    return {
      targets: [],
      mode: "unicast",
      reason: `parent ${parent?.from.address ?? order.parentOrderId} is not an online barista`,
      router: "explicit",
      candidates: [],
      failure: "parent_offline",
    };
  }

  /**
   * Explicit addressing is the escape hatch (v4-11): any online barista, any channel, observers
   * included, and the chain is bypassed. Without it a sub-agent could never name its parent.
   */
  private explicitDecision(order: Order): RoutingDecision {
    const ids = this.explicitTargets(order);
    if (ids.length) {
      if (ids.length === 1) {
        return { targets: ids, mode: "unicast", reason: `explicit address ${order.to}`, router: "explicit", candidates: [] };
      }
      // A bare name can match namesakes on several Hosts. The sender's own Host is the intended
      // team; never multicast an internal message to another Host's agent on a guess.
      const local = ids.filter((id) => this.registry.get(id)?.host === order.from.host);
      if (local.length === 1) {
        return { targets: local, mode: "unicast", reason: `explicit address ${order.to} on ${order.from.host}`, router: "explicit", candidates: [] };
      }
      return {
        targets: [],
        mode: "multicast",
        reason: `explicit address ${order.to} matches ${ids.length} agents on different Hosts; use name@host`,
        router: "explicit",
        candidates: [],
        failure: "ambiguous_address",
      };
    }
    // Not an Agent: `to: <team>` (optionally `team@host`) is the team's front door.
    const parsed = order.to ? parseAddress(this.normalizeAddress(order.to)) : undefined;
    if (parsed) {
      const team = this.resolveTeamTarget(parsed.name, parsed.host, order.from);
      if (team.failure !== "unknown_team") return this.frontDoorDecision(order.to!, team);
      const scope = this.teamScope(order).team;
      if (scope && (!parsed.host || parsed.host === scope.host) && scope.members.some((member) => member.name === parsed.name)) {
        return { targets: [], mode: "unicast", reason: `team member ${parsed.name} is not online`, router: "explicit", candidates: [], failure: "no_online_barista" };
      }
      const duty = this.resolveDuty(order, parsed.name, parsed.host);
      if (duty.ids.length) {
        return { targets: duty.ids, mode: "unicast", reason: `duty ${parsed.name}`, router: "explicit", candidates: [] };
      }
      if (duty.failure && duty.failure !== "unknown_duty") {
        const names =
          duty.failure === "ambiguous_duty"
            ? `: ${this.registry
                .all()
                .filter((r) => (r.duty ?? "").trim().toLowerCase() === parsed.name.trim().toLowerCase())
                .map((r) => r.address)
                .join(", ")}`
            : "";
        return { targets: [], mode: "unicast", reason: `duty ${parsed.name}${names}`, router: "explicit", candidates: [], failure: duty.failure };
      }
      // Neither an agent, a team, nor a duty: keep the v4-11 diagnostic.
      return { targets: [], mode: "unicast", reason: `unknown target ${order.to}`, router: "explicit", candidates: [], failure: "unknown_team" };
    }
    return { targets: [], mode: "unicast", reason: `no online barista at ${order.to}`, router: "explicit", candidates: [], failure: "no_online_barista" };
  }

  private explicitTargets(order: Order): string[] {
    if (!order.to) return [];
    return this.registry
      .resolve(this.normalizeAddress(order.to))
      .filter((id) => id !== order.from.id)
      .filter((id) => {
        const r = this.registry.get(id);
        return !!r && r.role === "barista" && r.status !== "offline" && this.inTeamRoster(r);
      });
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
    const rec = this.registry.get(agentId);
    const history = order.turn > 1 && rec?.teamChannel && rec.teamChannel === order.channel
      ? order.history.filter((entry) => entry.role === "customer" || entry.agentId === agentId)
      : order.history;
    if (!variants && history === order.history) return order;
    const { variants: _drop, ...rest } = order;
    return { ...rest, history, body: variants?.[agentId] ?? order.body };
  }

  /** Send an Order towards an Agent: via the Root when it is online (ADR-0001), else locally or directly (ADR-0004). */
  private deliver(order: Order, agentId: string): void {
    const rec = this.registry.get(agentId);
    if (!rec) return;
    if (order.clarificationRecipient && (rec.host !== order.clarificationRecipient.host || agentId !== order.clarificationRecipient.id)) {
      return this.relayFailure(order, agentId, "clarification requester unavailable");
    }
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
      let certificate: X509Certificate | undefined;
      const ws = new WebSocket(`${url}/ws`, this.linkOptions(host, (cert) => { certificate = cert; }));
      this.watchLink(ws);
      const peer = new Peer(ws);
      peer.meta.kind = "peer";
      peer.meta.host = host;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("connect timeout"));
      }, this.timing.linkConnectTimeoutMs);
      ws.on("message", (data) => void peer.receive(data.toString()));
      ws.on("error", () => {});
      ws.on("close", () => {
        clearTimeout(timer);
        this.dropHostCertificate(peer);
        peer.closed();
        this.dropLink(peer);
        if (this.links.get(host)?.peer === peer) this.links.delete(host);
        reject(new Error("connection closed"));
      });
      ws.on("open", async () => {
        try {
          const hello = await peer.request(Methods.initialize, { ...this.hostLinkHello(), protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, kind: "peer", token: this.config.token, host: this.host, url: this.url() });
          if (this.tlsContext?.network) {
            if (!certificate) throw new RpcError("host_auth_required", "direct link has no verified certificate");
            const id = this.verifyHostHello(hello, certificate);
            const binding = this.trustBinding(id);
            if (binding?.state !== "enrolled" || binding.host !== host || hello.host !== host || binding.keyFingerprint !== keyFingerprintOf(certificate.toString())) {
              throw new RpcError("bad_identity", "direct Host binding changed before admission");
            }
            this.bindHostCertificate(peer, certificate, id);
          }
          this.bindLink(peer);
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

  private markBackfill(threadId: string, force = false): void {
    if ((!force && this.rootOnline) || this.backfill.has(threadId)) return;
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
          const events = (since ? this.store.readEventsSince(meta.file, since - BACKFILL_SKEW_MS) : this.store.readEvents(meta.file))
            .filter((event) => !this.tlsContext?.network || event.eventHostId === this.hostId);
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
    if (order.clarificationRecipient && (agentId !== order.clarificationRecipient.id || this.host !== order.clarificationRecipient.host || !this.store.getKv<string>(`agent-proof:${agentId}`))) {
      return this.relayFailure(order, agentId, "clarification requester unavailable");
    }
    const peer = this.agents.get(agentId);
    if (!peer) {
      // The issuing Host retries a pending answer to this exact identity until its deadline.
      if (order.clarificationRecipient) return;
      return this.relayFailure(order, agentId, "agent not connected");
    }
    const rec = this.local.get(agentId);
    if (rec && (rec.activeThreadId !== order.threadId || rec.activeOrderId !== order.orderId)) {
      const next = { ...rec, activeThreadId: order.threadId, activeOrderId: order.orderId };
      this.local.set(agentId, next);
      this.publishAgents([next]);
    }
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
    // The pull is async: the peer may have disconnected or the Order closed meanwhile. Recording
    // `order.delivered` for a peer that never received it would grant a later connection its authority.
    if (peer.isClosed || this.agents.get(agentId) !== peer) return;
    const t = this.tracking.get(order.orderId);
    if (t && t.status !== "open") return;
    this.notifyLocal(order, agentId, peer);
    if (t && order.kind === "order") this.armAck(t, agentId);
  }

  private notifyLocal(order: Order, agentId: string, peer: Peer): void {
    peer.notify(Methods.orderDeliver, { order, attachmentPaths: this.attachmentPaths(order) });
    this.deliveredParentBodies.set(`${order.orderId}:${agentId}`, summarize(order.body, 639));
    if (this.deliveredParentBodies.size > 2048) this.deliveredParentBodies.delete(this.deliveredParentBodies.keys().next().value!);
    this.emitEvent(order, { type: "order.delivered", agentId, ...(this.store.getKv<string>(`agent-proof:${agentId}`) ? { protectedIdentity: true } : {}) });
  }

  private relayFailure(order: Order, agentId: string, reason: string): void {
    this.emitEvent(order, { type: "order.failed", agentId, reason });
  }

  private armAck(t: Tracking, agentId: string): void {
    this.clearTimer(t, agentId);
    t.timers.set(agentId, setTimeout(() => {
      if (!t.order.clarificationRecipient) return this.targetFailed(t, agentId, "no ack");
      if (t.status !== "open" || t.targets.get(agentId) !== "pending") return;
      this.armAck(t, agentId);
      const rec = this.registry.get(agentId);
      if (rec && rec.status !== "offline" && (rec.host === this.host ? this.agents.has(agentId) : this.rootOnline)) this.deliver(t.order, agentId);
    }, this.timing.ackTimeoutMs));
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
    if (!t || t.status !== "open") return;
    const ev = env.event;
    if (t.order.clarificationRecipient && "agentId" in ev &&
      (ev.agentId !== t.order.clarificationRecipient.id || env.host !== t.order.clarificationRecipient.host)) return;
    switch (ev.type) {
      case "order.acked":
        if (t.targets.get(ev.agentId) !== "pending") break;
        t.targets.set(ev.agentId, "acked");
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
          // `collect: all` deliberately has no grace: silence is not success (v4-11).
          if (t.decision?.mode !== "unicast" && !t.grace && this.hasPending(t) && t.order.collect !== "all") {
            t.grace = setTimeout(() => this.finishGrace(t), this.timing.graceMs);
          }
          this.maybeClose(t);
        } else this.armHeartbeat(t, ev.agentId);
        break;
      case "order.declined":
        if (t.targets.get(ev.agentId) !== "pending" && t.targets.get(ev.agentId) !== "acked") break;
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
      // Reuses the decline event so the skip is auditable, but marks it `skipped`: the thread closed
      // first, so this is neither a refusal on the topic nor a decline in the books (#101).
      this.emitEvent(t.order, { type: "order.declined", agentId: id, reason: "skipped: another Barista answered first", unavailable: true, skipped: true }, { skipTrack: true });
    }
    this.maybeClose(t);
  }

  private finishOnDeadline(t: Tracking): void {
    if (t.status !== "open") return;
    if (t.order.kind === "notice") return this.close(t, "done");
    // A deadline is final: unlike a refusal, there is no time left to try the next candidate.
    // `collect: all` reports silent targets as skipped (auditable), not as declines (#101);
    // `any` keeps the old failure semantics, where nobody answered.
    const all = t.order.collect === "all";
    for (const [id, s] of t.targets) {
      if (s !== "pending" && s !== "acked") continue;
      this.clearTimer(t, id);
      t.targets.set(id, all ? "done" : "failed");
      if (all) this.emitEvent(t.order, { type: "order.declined", agentId: id, reason: "deadline", unavailable: true, skipped: true }, { skipTrack: true });
      else this.emitEvent(t.order, { type: "order.failed", agentId: id, reason: "deadline", unavailable: true }, { skipTrack: true });
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

  cancel(threadId: string, orderId: string, auth: { peer?: Peer; ownerKey?: string; operatorKey?: string; loopback?: boolean }): {} {
    if (typeof threadId !== "string" || !threadId || typeof orderId !== "string" || !orderId) {
      throw new RpcError("bad_request", "threadId and orderId are required to cancel an Order");
    }
    const t = this.tracking.get(orderId);
    const current = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!t || current?.orderId !== orderId || t.status !== "open" || t.order.threadId !== threadId || t.order.from.host !== this.host) {
      throw new RpcError("stale_order", "that Order is no longer open on this Host");
    }
    const peer = auth.peer;
    const agentId = peer?.meta.agentId as string | undefined;
    const registeredCreator = agentId && this.agents.get(agentId) === peer && t.order.from.id === agentId;
    let actor: ThreadEnvelope["actor"];
    if (registeredCreator) {
      actor = { kind: "agent", principalId: agentId };
    } else if (peer && t.customerPeer === peer) {
      // Anonymous protocol customers can cancel only from their original connection.
    } else if (auth.operatorKey !== undefined) {
      if (!auth.loopback || !this.verifyOperatorCredential(auth.operatorKey)) throw new RpcError("unauthorized", "cancellation requires the local operator credential on the Order's Host");
      actor = { kind: "operator", principalId: this.store.putCallerPrincipal({ kind: "operator", credentialDigest: this.operatorKeyDigest, principalId: ulid() }) };
    } else if (this.ownsCancellation(t.order, auth.ownerKey)) {
      actor = { kind: "human", principalId: this.store.putCallerPrincipal({ kind: "human", credentialDigest: ownershipDigest(auth.ownerKey!), principalId: ulid() }) };
    } else {
      throw new RpcError("not_order_owner", "only the requester or a local operator can cancel this Order");
    }
    this.emitEvent(t.order, { type: "order.cancelled", by: actor?.kind === "operator" ? "operator" : t.order.from.address }, { actor });
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

  /** Record an operator override on an open Order, clearly distinguished from an authenticated Barista reply. */
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
      source: "operator",
      ...(attachments?.length ? { attachments } : {}),
    });
    return {};
  }

  // -------------------------------------------------------------------------
  // Events: record locally, update metadata, fan out.
  // -------------------------------------------------------------------------

  private emitEvent(order: Order, event: ThreadEventBody, opts: { skipTrack?: boolean; actor?: ThreadEnvelope["actor"] } = {}): void {
    const env: ThreadEnvelope = {
      eventId: ulid(), threadId: order.threadId, orderId: order.orderId, host: this.host, at: Date.now(), event,
      ...(this.tlsContext?.network ? { eventHostId: this.hostId } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
    };
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
    if (opts.from?.hostIdentity && (this.isRoot || opts.from.meta.kind === "peer")) {
      if (env.eventHostId !== opts.from.hostIdentity.hostId || env.host !== opts.from.meta.host) {
        throw new RpcError("bad_identity", "event source differs from the authenticated Host");
      }
    }
    if (this.stopped || this.seen.has(env.eventId)) return;
    const event = env.event;
    const closed = this.closingEvent(env.threadId, env.orderId);
    if (closed && !(event.type === "order.replied" && event.final) && event.type !== "order.reported") return;
    const tracking = this.tracking.get(env.orderId);
    if (!opts.skipTrack && tracking?.status === "open" && "agentId" in event && typeof event.agentId === "string" && tracking.targets.get(event.agentId) === "failed" &&
      (event.type === "order.acked" || event.type === "order.heartbeat" || event.type === "order.declined" || event.type === "order.failed")) return;
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
      // Heartbeats renew leases and remain visible live. Recovery only needs durable acks.
      if (event.type !== "order.heartbeat") this.appendEvent(meta.file, env);
      // Thread creation and closure are durable immediately; activity updates can wait.
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

    const parent = meta && this.linkedParent(meta);
    const subscribers = new Set(this.subscribers.get(env.threadId));
    if (parent?.from.host === this.host) {
      for (const s of this.subscribers.get(parent.threadId) ?? []) subscribers.add(s);
    }
    for (const s of subscribers) if (s !== opts.from) s.notify(Methods.threadEvent, env);
    for (const ui of this.uis) ui.notify(Methods.threadEvent, { env, meta });
    if (this.isRoot) this.fanOutToChildren(env, opts.from, parent?.from.host);
    else if (this.rootOnline && opts.from !== this.uplink && (!this.uplink!.hostIdentity || env.eventHostId === this.hostId)) this.uplink!.notify(Methods.threadEvent, env);
    for (const l of this.threadLinks.get(env.threadId) ?? []) {
      if (l === opts.from || l.isClosed || (l.hostIdentity && env.eventHostId !== this.hostId)) continue;
      this.touchLink(l);
      l.notify(Methods.threadEvent, env);
    }
    this.emit("thread", env, meta);
    if (env.event.type === "order.cancelled") this.notifyCancelled(env);
    if (env.event.type === "order.failed" && env.event.agentId) this.clearActiveOrder(env.event.agentId, env.threadId, env.orderId);
    if (env.event.type === "order.closed") for (const id of meta?.targets ?? []) this.clearActiveOrder(id, env.threadId, env.orderId);
    if (env.event.type === "order.replied" && env.event.final && env.event.source !== "operator") this.recordOutcome(env, env.event.agentId, "answered");
    else if (env.event.type === "order.declined" && !env.event.skipped) this.recordOutcome(env, env.event.agentId, "declined", env.event.unavailable);
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

  private clearActiveOrder(agentId: string, threadId: string, orderId: string): void {
    const rec = this.local.get(agentId);
    if (!rec || rec.activeThreadId !== threadId || rec.activeOrderId !== orderId) return;
    const next = { ...rec };
    delete next.activeThreadId;
    delete next.activeOrderId;
    this.local.set(agentId, next);
    this.publishAgents([next]);
  }

  /** Tell local Agents that were sent this Order that it was cancelled. Every Host in the Thread sees the event. */
  private notifyCancelled(env: ThreadEnvelope): void {
    if (env.event.type !== "order.cancelled") return;
    const meta = this.metas.get(env.threadId);
    for (const id of meta?.targets ?? []) {
      this.clearActiveOrder(id, env.threadId, env.orderId);
      this.agents.get(id)?.notify(Methods.orderCancelled, { orderId: env.orderId, threadId: env.threadId, by: env.event.by });
    }
  }

  /** An exact delivery, from the Order log rather than the Thread's cumulative targets. */
  private wasDelivered(order: Order, agentId: string, host: string, protectedIdentity = false): boolean {
    const meta = this.metas.get(order.threadId) ?? this.store.getThread(order.threadId);
    return !!meta && !!this.store.findLastEvent(meta.file, (env) =>
      env.orderId === order.orderId && env.host === host && env.event.type === "order.delivered" && env.event.agentId === agentId &&
      (!protectedIdentity || env.event.protectedIdentity === true));
  }

  private ownsCancellation(order: Order, ownerKey?: string): boolean {
    const parsed = OwnershipKey.safeParse(ownerKey);
    if (!parsed.success) return false;
    const digest = this.store.getKv<string>(`cancel-owner:${order.orderId}`) ?? this.store.getKv<string>(`human-owner:${order.orderId}`);
    return digest === ownershipDigest(parsed.data);
  }

  private ownsHumanOrder(order: Order, ownerKey?: string): boolean {
    if (!order.from.id.startsWith("cli:") || order.origin === "agent") return false;
    const digest = this.store.getKv<string>(`human-owner:${order.orderId}`);
    const parsed = OwnershipKey.safeParse(ownerKey);
    return !!digest && parsed.success && ownershipDigest(parsed.data) === digest;
  }

  private parentLinks = new Map<string, Order>();
  private restoredTaskStatuses = new Map<string, { orderId: string; status: ThreadMeta["taskStatus"] }>();

  private linkedParent(meta: ThreadMeta): Order | undefined {
    if (!meta.parentOrderId || !meta.parentThreadId) return undefined;
    const cached = this.parentLinks.get(meta.threadId);
    if (cached) return cached;
    const parent = this.findParentOrder(meta.parentOrderId, meta.parentThreadId);
    const humanOwnerLink = meta.parentOwnerVerified === true && meta.origin === "human" && meta.from.id.startsWith("cli:") && parent?.from.id.startsWith("cli:");
    if (parent?.threadId !== meta.parentThreadId || (!humanOwnerLink && !this.wasDelivered(parent, meta.from.id, meta.from.host))) return undefined;
    if (this.parentLinks.size >= 2048) this.parentLinks.delete(this.parentLinks.keys().next().value!);
    this.parentLinks.set(meta.threadId, parent);
    return parent;
  }

  /** Root: forward an event to every Host taking part in the Thread, except where it came from. */
  private fanOutToChildren(env: ThreadEnvelope, from?: Peer, parentHost?: string): void {
    const meta = this.metas.get(env.threadId);
    const hosts = new Set<string>();
    if (parentHost) hosts.add(parentHost);
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
        ...(ev.order.channel ? { channel: ev.order.channel } : {}),
        ...(ev.order.parentThreadId ? { parentThreadId: ev.order.parentThreadId } : {}),
        ...(ev.order.parentOrderId ? { parentOrderId: ev.order.parentOrderId } : {}),
        ...(ev.order.parentOwnerVerified ? { parentOwnerVerified: true as const } : {}),
        ...(ev.order.needsHuman ? { clarification: { orderId: ev.order.orderId, question: ev.order.body } } : {}),
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
    type TargetState = "pending" | "acked" | "replied" | "declined" | "failed" | "skipped";
    const setTargetState = (agentId: string, state: TargetState, onlyUpgrade = false) => {
      const list = (meta.targetStates ??= []);
      const entry = list.find((x) => x.agentId === agentId);
      if (!entry) list.push({ agentId, state });
      else if (!onlyUpgrade || entry.state === "pending") entry.state = state;
    };
    if (ev.type === "order.created") {
      this.knownOrders.set(ev.order.orderId, ev.order);
      // A new turn: the Thread now reflects this Order. The title stays on the
      // first question so a multi-turn Thread is still recognisable in list views.
      if (ev.order.turn < meta.turns) return meta;
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
        meta.targetStates = [];
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
        for (const id of ev.decision.targets) setTargetState(id, "pending");
        meta.status = "delivering";
        break;
      case "order.delivered":
        if (!meta.targets.includes(ev.agentId)) meta.targets.push(ev.agentId);
        setTargetState(ev.agentId, "pending");
        break;
      case "order.acked":
        if (meta.status === "delivering" || meta.status === "routing") meta.status = "working";
        if (meta.clarification && meta.turns > 1 && ev.agentId === meta.from.id) meta.clarification.acknowledged = true;
        setTargetState(ev.agentId, "acked", true);
        break;
      case "order.replied":
        meta.firstReplyAt ??= env.at;
        if (ev.final) {
          pushBounded(meta.replies, { agentId: ev.agentId, address: addr(ev.agentId), text: ev.text.slice(0, 600), at: env.at, ...(ev.source ? { source: ev.source } : {}) }, MAX_META_REPLIES);
          if (meta.closedAt === undefined) setTargetState(ev.agentId, "replied");
        }
        break;
      case "order.declined":
        // A grace skip is not a decline: with a late reply the same agent would sit in both lists (#101).
        if (!ev.skipped) pushBounded(meta.declines, { agentId: ev.agentId, address: addr(ev.agentId), reason: ev.reason.slice(0, 300), at: env.at }, MAX_META_DECLINES);
        setTargetState(ev.agentId, ev.skipped ? "skipped" : "declined");
        break;
      case "order.failed":
        if (ev.agentId) setTargetState(ev.agentId, "failed");
        break;
      case "order.closed":
        meta.status = ev.status;
        meta.closedAt = env.at;
        break;
      case "order.reported":
        meta.reportedOrderId = env.orderId;
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
    // A crash after appending answer acceptance can leave a closed publication in SQLite.
    // Repair the index from the journal so normal Order recovery can resume the original ID.
    for (const meta of this.store.unansweredClarifications()) {
      const answer = this.store.findLastEvent(meta.file, ({ event }) => event.type === "order.created" &&
        !!event.order.clarificationRecipient && event.order.from.host === this.host);
      if (!answer) continue;
      const events = this.store.readOrderEvents(meta.file, answer.orderId);
      for (const env of events) this.updateMeta(env);
      const restored = this.metas.get(meta.threadId);
      if (restored) this.writeMeta(restored);
    }
    let n = 0;
    let cursor: { createdAt: number; threadId: string } | undefined;
    while (true) {
      const page = this.store.openThreadsPage(1000, cursor);
      if (!page.length) break;
      for (const meta of page) {
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
      const savedRoute = events.find((e) => e.event.type === "order.routed")?.event;
      const routed = savedRoute ?? (order.clarificationRecipient
        ? { type: "order.routed" as const, decision: this.clarificationAnswerRoute(order.clarificationRecipient) }
        : undefined);
      if (order.needsHuman) {
        this.close(t, "done");
        continue;
      }
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
      // A recovered Order gets the same upper bound as a fresh one: a barista that acked before the
// restart and keeps heartbeating must not hold a unicast `collect: all` open forever.
      const defaultMs = routed.decision.mode !== "unicast" || order.kind === "notice" ? this.timing.broadcastDeadlineMs : this.timing.unicastDeadlineMs;
      const remaining = order.createdAt + (order.deadlineMs ?? defaultMs) - Date.now();
      t.deadline = setTimeout(() => this.finishOnDeadline(t), Math.max(0, remaining));
      this.maybeClose(t);
      }
      const last = page.at(-1)!;
      cursor = { createdAt: last.createdAt, threadId: last.threadId };
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
    this.forgotten.delete(host);
    peer.meta.host = host;
    const now = Date.now();
    const override = this.config.hostNames[host];
    const displayName = override?.displayName ?? p.displayName ?? host;
    const aliases = [...new Set([...(p.aliases ?? []), ...(override?.aliases ?? [])])];
    const legacyAliases = [...new Set([...(p.legacyAliases ?? []), ...(override?.legacyAliases ?? [])])];
    this.daemonRecords.set(host, { host, hostId: peer.hostIdentity?.hostId ?? host, displayName, aliases, legacyAliases, url: p.url ?? "", isRoot: false, online: true, connectedAt: now, lastSeenAt: now, version: p.cafeVersion, features: p.features ?? [] });
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
    peer.on(Methods.teamUpsert, (x: { team: TeamRecord }) => {
      this.storeTeam({ ...x.team, host }, peer);
      return {};
    });
    peer.on(Methods.teamRemove, (x: { team?: unknown; host?: unknown }) => {
      if (typeof x?.team !== "string" || !x.team) throw new RpcError("bad_request", "team is required");
      this.removeTeam(x.team, typeof x.host === "string" && x.host ? x.host : host, peer);
      return {};
    });
    peer.on(Methods.channelDigest, (x: { agentId?: string; digest: ChannelDigest }) => {
      if (x.agentId) this.notifyAgent(x.agentId, Methods.channelDigest, { digest: x.digest });
      return {};
    });
    peer.on(Methods.teamRoster, (x: { agentId?: string; update: TeamRosterUpdate }) => {
      if (x.agentId) this.notifyAgent(x.agentId, Methods.teamRoster, { update: x.update });
      return {};
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
    peer.on("thread/children", (p: { threadId: string; limit: number }) => {
      if (typeof p.threadId !== "string") throw new RpcError("bad_request", "threadId is required");
      return this.localChildren(p.threadId, Math.max(1, Math.min(201, Number(p.limit) || 200)))
        .filter((child) => this.linkedParent(child)?.from.host === host);
    });
    peer.on(Methods.threadTaskStatuses, async (p: { parents?: unknown }) => {
      if (!Array.isArray(p.parents) || p.parents.length > 200) throw new RpcError("bad_request", "parents must be an array of at most 200 parent references");
      return Promise.all(p.parents.map(async (raw) => {
        if (!raw || typeof raw !== "object" || typeof (raw as any).threadId !== "string" || typeof (raw as any).orderId !== "string") {
          throw new RpcError("bad_request", "each parent reference requires threadId and orderId");
        }
        const { threadId, orderId } = raw as { threadId: string; orderId: string };
        const meta = this.taskOrderMeta(threadId, orderId);
        if (!meta || meta.from.host !== host) {
          return { threadId, orderId, taskStatus: "unknown" as const, childrenPartial: true };
        }
        const projected = await this.projectTaskMeta(meta, false);
        return {
          threadId,
          orderId,
          ...(projected.taskStatus ? { taskStatus: projected.taskStatus } : {}),
          pendingChildren: projected.pendingChildren ?? 0,
          childrenPartial: projected.childrenPartial ?? false,
          ...(projected.reportedOrderId ? { reportedOrderId: projected.reportedOrderId } : {}),
        };
      }));
    });
    peer.on("thread/reports", (p: { threadId: string; orderId?: string }) => {
      if (typeof p.threadId !== "string") return [];
      const meta = p.orderId ? this.taskOrderMeta(p.threadId, p.orderId) : this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
      if (!meta || meta.from.host !== host) return [];
      const events = p.orderId ? this.store.readOrderEvents(meta.file, p.orderId) : this.store.readEventsTail(meta.file, 200);
      return events.filter((env) => env.event.type === "order.reported");
    });
    peer.on("thread/linked-detail", (p: { threadId: string; parentThreadId?: string; limit?: number; before?: string; clarificationOnly?: boolean }) => {
      if (typeof p.threadId !== "string") throw new RpcError("bad_request", "threadId is required");
      const meta = this.metas.get(p.threadId) ?? this.store.getThread(p.threadId);
      if (!meta || this.linkedParent(meta)?.from.host !== host) return undefined;
      if (p.clarificationOnly) {
        if (!meta.clarification || meta.parentThreadId !== p.parentThreadId) return undefined;
        return { events: this.store.readOrderEvents(meta.file, meta.clarification.orderId).slice(0, 8) };
      }
      return this.thread(p.threadId, { limit: Math.min(200, Math.max(1, Number(p.limit) || 100)), before: p.before });
    });
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
    this.log(`daemon ${host} connected (${p.url})`);
    const publish = () => {
      if (this.children.get(host) !== peer) return;
      this.emitDaemons();
      peer.notify(Methods.registrySnapshot, { version: this.registry.version, records: this.registry.all().filter((r) => this.publishableTo(r, peer.meta.features as string[] | undefined)) });
      for (const team of this.teamRecords.values()) if ((peer.meta.features as string[] | undefined)?.includes("teams")) peer.notify(Methods.teamUpsert, { team });
      this.pushHints(peer);
    };
    if (peer.hostIdentity) {
      peer.on("host/ready", () => {
        if (peer.meta.hostReady) return {};
        peer.meta.hostReady = true;
        // Updates and the fresh snapshot use the same ordered channel.
        peer.notify("host/bindings", this.store.listHostIdentities());
        publish();
        return {};
      });
    } else {
      setImmediate(publish);
    }
    return {
      protocolVersion: PROTOCOL_VERSION, cafeVersion: this.version, ...this.hostLinkHello(), host: this.host,
      displayName: this.displayName, aliases: this.hostAliases, isRoot: true, registryVersion: this.registry.version,
      ...(peer.hostIdentity ? { hostBindings: this.store.listHostIdentities() } : {}),
    };
  }

  /**
   * Root: remember a child's dial-back address only after a short probe. A child
   * in Docker/NAT often reports a container-internal IP that is unreachable from
   * the Root; writing it would poison `knownDaemons` and announceRoot forever.
   */
  private async rememberChildUrl(host: string, url: string): Promise<{ verified: boolean; error?: string; code?: string }> {
    const probeStarted = Date.now();
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
    // Forgotten while this probe was in flight (v4-8): writing it back would resurrect the Host.
    if ((this.forgotten.get(host) ?? -1) >= probeStarted) return { verified: false, error: "forgotten while the address was being checked" };
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
    if (this.isRoot || this.stopped || !this.rootCandidates().length) return;
    // Fail-closed (v4-6 §10.3, #79): a TLS Host that has not enrolled the network CA does not dial its
    // Root at all — a plaintext uplink is exactly the downgrade TLS exists to prevent. The enrolment
    // retry reconnects once it succeeds.
    if (this.tlsContext && !this.tlsContext.network) {
      if (!this.waitingLogged) this.log(`tls: not connecting to root ${this.config.root} until this Host joins the TLS network (${this.tlsWaiting ?? "enrolling"})`);
      this.waitingLogged = true;
      return;
    }
    const gen = ++this.dialGen;
    void this.dialRoot(this.nextRootTarget(), gen);
  }

  /** Where this Host may look for its Root: the configured address, the last one that worked, learned ones. */
  rootCandidates(): string[] {
    const list = [this.config.root, this.lastRootAddr, ...this.rootAddressesLearned].filter((x): x is string => !!x);
    return [...new Set(list)];
  }

  private nextRootTarget(): string {
    const list = this.rootCandidates();
    return list[this.rootDialIndex % list.length] ?? this.config.root!;
  }

  /**
   * Merge Root addresses learned from `root/moved` (v4-10). Bounded, newest first: a Root on several
   * networks reports every address it has, and an old one is kept as a fallback.
   */
  rememberRootAddresses(addresses: string[]): void {
    const clean = addresses.filter((a) => typeof a === "string" && /^[^\s:]+:\d+$|^\[[^\]]+\]:\d+$/.test(a));
    if (!clean.length) return;
    const merged = [...new Set([...clean, ...this.rootAddressesLearned])].slice(0, 8);
    if (merged.join() === this.rootAddressesLearned.join()) return;
    this.rootAddressesLearned = merged;
    this.store.setKv("rootAddresses", merged);
  }

  /** A dial failed or a working address dropped: try the next candidate, and rediscover now and then. */
  private rootFailed(): void {
    this.rootDialIndex += 1;
    if (this.rootDialIndex % Math.max(2, this.rootCandidates().length * 2) === 0) this.discoverRootOnce();
  }

  /** The address the current uplink uses (undefined while offline). */
  get rootConnected(): string | undefined {
    return this.rootConnectedAddr;
  }

  /** When this child last heard anything from its Root (pong or any frame). */
  get rootLastSeen(): number | undefined {
    return this.rootLastSeenAt;
  }

  /** Ping a Daemon link; two missed pongs kill the socket locally so the close path runs (#99). */
  private linkWatchers = new Set<() => void>();
  private watchLink(ws: WebSocket, onAlive?: () => void): void {
    const stop = watchLiveness(ws, { intervalMs: this.timing.linkPingMs, onDead: () => ws.terminate(), ...(onAlive ? { onAlive } : {}) });
    this.linkWatchers.add(stop);
    ws.once("close", () => this.linkWatchers.delete(stop));
  }

  /** Root: the addresses it tells its children about (the same set `cafe root show` prints). */
  private rootAddressesForPeers(): string[] {
    const all = joinAddresses({ advertise: this.config.advertise, port: this.config.port, lan: localAddresses() }).addresses;
    // `joinAddresses` falls back to 127.0.0.1 on a machine with no LAN address; a remote child cannot
    // use that, and adopting it as a candidate would only burn retries.
    const reachable = all.filter((a) => !/^127\.|^localhost:|^\[::1\]:/.test(a));
    return reachable.length ? reachable : all;
  }

  /** Try mDNS again while every known Root address is failing (v4-10); rate-limited, respects config. */
  private discoveryDelayMs = DISCOVERY_MIN_MS;
  private discoveryTries = 0;
  private discoverRootOnce(): void {
    if (this.stopped || this.rootOnline || !this.config.discovery || process.env.CAFE_DISCOVERY === "0") return;
    if (this.discoveryTries >= DISCOVERY_MAX_TRIES) return;
    const now = Date.now();
    if (now - this.lastRootDiscoveryAt < this.discoveryDelayMs) return;
    this.lastRootDiscoveryAt = now;
    this.discoveryTries += 1;
    // 30 s → 1 m → 2 m → 4 m → 5 m, then stop trying: a permanently orphaned child must not multicast forever.
    this.discoveryDelayMs = Math.min(DISCOVERY_MAX_MS, this.discoveryDelayMs * 2);
    void discoverRoots(2000)
      .then((roots) => {
        if (this.stopped || this.rootOnline) return;
        const addrs = roots.filter((r) => r.host !== this.host).map((r) => r.addr);
        if (!addrs.length) return;
        this.log(`discovery: root candidates ${addrs.join(", ")}`);
        this.rememberRootAddresses(addrs);
        this.reconnectDelay = 0;
        this.connectRoot();
      })
      .catch(() => {});
  }

  private dialGen = 0;
  private dialTarget?: string;
  private waitingLogged = false;
  /** The address the current uplink was dialled at: `config.root` may have moved since (v4-10). */
  private rootConnectedAddr?: string;
  private rootLastSeenAt?: number;
  /** Reconnect rotation over `rootCandidates()` (#104); advanced on every dropped/failed dial. */
  private rootDialIndex = 0;
  private lastRootDiscoveryAt = 0;
  /** Root addresses learned through `root/moved`, newest first, bounded (v4-10). */
  private rootAddressesLearned: string[] = [];
  private lastRootAddr?: string;

  private async dialRoot(target: string, gen: number): Promise<void> {
    this.dialTarget = target;
    let url: string;
    try {
      // `root:` is the Root's main address; on a TLS network this finds its TLS endpoint (v4-6 §10.3).
      url = await this.resolveDaemonUrl(target);
    } catch (err) {
      if (gen !== this.dialGen || this.stopped) return;
      this.log(`cannot reach root ${target}: ${(err as Error).message}`);
      this.rootFailed();
      this.scheduleReconnect();
      return;
    }
    // A newer dial (setRoot, a reconnect) superseded this one while we were resolving. Compare against
    // the target this dial was started for, not `config.root`: rotation dials learned addresses (#104).
    if (gen !== this.dialGen || this.stopped || this.dialTarget !== target) return;
    let ws: WebSocket;
    let certificate: X509Certificate | undefined;
    try {
      ws = new WebSocket(`${url}/ws`, this.linkOptions(undefined, (cert) => { certificate = cert; }));
    } catch (err) {
      // A persisted bad address must not crash the daemon on every boot (#76): say so and keep
      // retrying at the normal backoff, so `cafe root set` can still repair it later.
      this.log(`cannot dial root '${target}': ${(err as Error).message}; fix it with \`cafe root set <host:port>\``);
      this.rootFailed();
      this.scheduleReconnect();
      return;
    }
    this.uplinkSocket = ws;
    // A half-open uplink never fires `close`; the pong watcher is what notices (#99).
    this.watchLink(ws, () => (this.rootLastSeenAt = Date.now()));
    const peer = new Peer(ws);
    ws.on("open", async () => {
      try {
        const hello = await peer.request<{ host: string; displayName?: string; aliases?: string[]; cafeVersion?: string; features?: string[]; protocolVersion?: number; hostId?: string; rootHostId?: string; hostBindings?: unknown; isRoot?: boolean }>(Methods.initialize, {
          ...this.hostLinkHello(),
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
        // A rotated candidate may answer from a different Root (same token, a sibling network, a
        // spoofed discovery answer). Only an address the person set is trusted to change the Root.
        const knownRoot = this.rootHost ?? this.store.getKv<string>("rootHost");
        if (target !== this.config.root && knownRoot && hello.host !== knownRoot) {
          throw new Error(`this address answers as root '${hello.host}', but the Root was '${knownRoot}'; refusing it (run \`cafe root set <host:port>\` if the Root really moved)`);
        }
        if (this.tlsContext?.network) {
          if (!certificate || !hello.isRoot) throw new RpcError("host_auth_required", "uplink requires an authenticated Root");
          const id = this.verifyHostHello(hello, certificate);
          if (!Array.isArray(hello.hostBindings) || !hello.hostBindings.some((item) => {
            const binding = HostIdentity.safeParse(item);
            return binding.success && binding.data.hostId === id && binding.data.host === hello.host &&
              binding.data.state === "enrolled" && binding.data.keyFingerprint === keyFingerprintOf(certificate!.toString());
          })) throw new RpcError("bad_identity", "Root certificate does not match its advertised binding");
          this.installRootBindings(hello.hostBindings);
          this.bindHostCertificate(peer, certificate, id);
          bindUplink();
          await peer.request("host/ready", {}, this.timing.linkConnectTimeoutMs);
          if (peer.isClosed || this.uplinkSocket !== ws) throw new RpcError("closed", "Root link was superseded during initialization");
        }
        this.uplink = peer;
        this.bindAgentMethods(peer); // the Root may relay agent/rename down this connection
        this.rootHost = hello.host;        this.rootVersion = hello.cafeVersion;
        this.rootFeatures = hello.features ?? [];
        this.rootDisplayName = hello.displayName;
        this.store.setKv("rootHost", hello.host);
        this.reconnectDelay = 0;
        this.rootDialIndex = 0;
        this.rootConnectedAddr = target;
        this.rootLastSeenAt = Date.now();
        this.discoveryDelayMs = DISCOVERY_MIN_MS;
        this.discoveryTries = 0;
        if (this.lastRootAddr !== target) this.log(`root reachable at ${target}`);
        // The address that worked is remembered as a candidate, not written over the person's
        // `root:` setting: a hand-set root may be an ssh tunnel that is right even when a probe fails.
        this.lastRootAddr = target;
        this.store.setKv("lastRoot", target);
        this.setRootOnline(true);
        await peer.request("registry/sync", { records: [...this.local.values()].filter((r) => this.publishableTo(r, this.rootFeatures)) });
        // A roster learned while the Root was offline was stored but never published. The Root
        // replays its own records on connect; send this Host's rosters the other way too (v4-11 review).
        if (this.rootSupports("teams")) for (const team of this.teamRecords.values()) if (team.host === this.host) peer.notify(Methods.teamUpsert, { team });
        void this.flushBackfill();
        this.log(`connected to root ${target}`);
      } catch (err) {
        this.log(`root handshake failed: ${(err as Error).message}`);
        this.rootFailed();
        ws.close();
      }
    });
    const bindUplink = () => this.bindUplinkHandlers(peer, ws);
    if (!this.tlsContext?.network) bindUplink();
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("error", () => {});
    ws.on("close", () => {
      this.dropHostCertificate(peer);
      peer.closed();
      if (this.uplinkSocket !== ws) return;
      const wasOnline = this.uplink === peer;
      this.uplink = undefined;
      this.rootHints = undefined;
      if (wasOnline) {
        this.setRootOnline(false);
        this.log("root connection lost");
      }
      this.rootFailed();
      this.scheduleReconnect();
    });
  }

  private bindUplinkHandlers(peer: Peer, ws: WebSocket): void {
    peer.on("host/bindings", (bindings: unknown) => {
      if (peer.hostIdentity?.hostId === this.rootHostId && this.uplinkSocket === ws) this.installRootBindings(bindings);
    });
    peer.on(Methods.registrySnapshot, (x: { version: number; records: AgentRecord[] }) => {
      const remote = x.records.filter((r) => r.host !== this.host);
      this.registry.applySnapshot(x.version, [...remote, ...this.local.values()]);
    });
    peer.on(Methods.teamUpsert, (x: { team: TeamRecord }) => {
      this.storeTeam(x.team, peer);
      return {};
    });
    peer.on(Methods.teamRemove, (x: { team?: unknown; host?: unknown }) => {
      if (typeof x?.team !== "string" || !x.team) throw new RpcError("bad_request", "team is required");
      this.removeTeam(x.team, typeof x.host === "string" && x.host ? x.host : this.host, peer);
      return {};
    });
    peer.on(Methods.channelDigest, (x: { agentId?: string; digest: ChannelDigest }) => {
      if (x.agentId) this.agents.get(x.agentId)?.notify(Methods.channelDigest, { digest: x.digest });
      return {};
    });
    peer.on(Methods.teamRoster, (x: { agentId?: string; update: TeamRosterUpdate }) => {
      if (x.agentId) this.notifyAgent(x.agentId, Methods.teamRoster, { update: x.update });
      return {};
    });
    peer.on(Methods.daemonsChanged, (list: DaemonRecord[]) => this.learnPeers(list));
    peer.on(Methods.rootMoved, (x: { addresses?: string[] }) => this.rememberRootAddresses(x?.addresses ?? []));
    peer.on(Methods.hostForgotten, (x: { host: string }) => this.onHostForgotten(x));
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
  }

  private setRootOnline(online: boolean): void {
    const rootAddr = this.rootConnectedAddr ?? this.config.root;
    const rec: DaemonRecord = this.daemonRecords.get("__root__") ?? { host: this.rootHost ?? "root", hostId: this.rootHost, aliases: [], legacyAliases: [], url: rootAddr ? `ws://${rootAddr}` : "", isRoot: true, online, lastSeenAt: Date.now() };
    rec.online = online;
    if (this.rootHost) rec.host = this.rootHost;
    if (this.rootDisplayName) rec.displayName = this.rootDisplayName;
    if (online) rec.version = this.rootVersion;
    if (online) rec.features = [...this.rootFeatures];
    // Show where the uplink actually is, not only what the file says: after a move they differ (#104).
    rec.url = rootAddr ? `ws://${rootAddr}` : "";
    rec.lastSeenAt = Date.now();
    if (online) rec.connectedAt = Date.now();
    else this.rootConnectedAddr = undefined;
    // v4-13 digest handover: the Root publishes while connected. When a child takes over, start
    // from now instead of replaying activity the Root already summarized (#109).
    if (online) this.digestTakeoverAt = undefined;
    else if (!this.isRoot && !this.stopped) {
      this.digestTakeoverAt = Date.now();
      for (const ch of this.digestSince.keys()) this.digestSince.set(ch, this.digestTakeoverAt);
      this.store.setKv("digestSince", Object.fromEntries(this.digestSince));
    }
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
    this.rootDialIndex = 0;
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
    opts: { budgetMs?: number; stats?: { scanned: number; elapsedMs: number; truncated: boolean }; channel?: string } = {},
  ): { meta: ThreadMeta; hits: { orderId: string; who: string; text: string; at: number }[] }[] {
    const started = performance.now();
    const channel = opts.channel;
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
        const indexed = this.store.searchIndex(q, limit * 5, channel);
        if (!indexed.short) {
          const byThread = new Map<string, { meta: ThreadMeta; hits: { orderId: string; who: string; text: string; at: number }[] }>();
          const seenEvents = new Set<string>();
          for (const h of indexed.hits) {
            const meta = this.metas.get(h.threadId) ?? this.store.getThread(h.threadId);
            if (!meta) continue;
            if (channel && (meta.channel ?? DEFAULT_CHANNEL) !== channel) continue;
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
      if (channel && (meta.channel ?? DEFAULT_CHANNEL) !== channel) continue;
      scanned++;
      const hits: { orderId: string; who: string; text: string; at: number }[] = [];
      for (const env of this.store.readEvents(meta.file)) {
        const ev = env.event;
        const [who, text] =
          ev.type === "order.created" ? [ev.order.from.address, ev.order.body] : ev.type === "order.replied" || ev.type === "order.reported" ? [this.registry.get(ev.agentId)?.address ?? ev.agentId, ev.text] : [undefined, undefined];
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
   * Index Threads that predate search indexing and scan each existing Thread once for result reports.
   * Runs bounded batches at startup so upgrades converge without blocking the event loop.
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
          this.store.markSearchBackfilled(m.threadId);
        } catch {
          // An unreadable Thread must not stop the backfill; it remains eligible on the next start.
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
    // only knows an address nobody else can reach. It only wins once the Root has proven it reachable
    // though — an unverified pin must not hide the address an online Host is reachable at (#103).
    for (const [host, addr] of Object.entries(this.config.pinnedDaemons)) {
      const rec = this.daemonRecords.get(host);
      if (!rec || !addr) continue;
      const pin = this.pinnedAddress(host)!;
      if (rec.online && this.verifiedAddress(host) !== pin) continue;
      rec.url = pin;
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
      const rootAddresses = this.rootAddressesForPeers();
      for (const child of this.children.values()) {
        child.notify(Methods.daemonsChanged, verified);
        child.notify(Methods.rootMoved, { addresses: rootAddresses });
      }
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
      if (this.isRoot) {
        const legacy = [...new Set([...Object.keys(this.config.knownDaemons), ...this.daemonRecords.keys()])]
          .filter((host) => host !== this.host && !this.store.getHostIdentityByHost(host));
        if (legacy.length) checks.push({
          name: "host-auth",
          level: "warn",
          detail: `these machines need Host enrollment: ${legacy.join(", ")}`,
          next: "upgrade them and create a one-use invitation on this Root for each Host",
        });
        else checks.push({ name: "host-auth", level: "ok", detail: "Host connections require an enrolled certificate" });
      } else if (this.config.root && this.tlsContext.network && !this.rootOnline) {
        checks.push({
          name: "host-auth",
          level: "warn",
          detail: "Root is offline. Direct links can use cached Host bindings until the peer certificate expires.",
          next: "restore the Root connection to refresh Host bindings and revocations",
        });
      }
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

  private localChildren(threadId: string, limit: number): ThreadMeta[] {
    return this.store.listThreadsByParent(threadId, limit).map((meta) => this.summaryMeta(this.metas.get(meta.threadId) ?? meta));
  }

  private localTaskChildren(threadId: string, orderId: string, limit = 10_001): ThreadMeta[] {
    // `order.created`/`order.closed` are written to SQLite synchronously, so the row carries the
    // durable lifecycle status; an in-memory meta may still hold an earlier snapshot of it.
    return this.store.listThreadsByParentOrder(threadId, orderId, limit).map((meta) => {
      const live = this.metas.get(meta.threadId);
      return this.summaryMeta(live
        ? { ...meta, lastActivityAt: Math.max(meta.lastActivityAt ?? 0, live.lastActivityAt ?? 0) }
        : meta);
    });
  }

  async childView(threadId: string, limit: number): Promise<{ children: ThreadMeta[]; partial: boolean }> {
    const pageLimit = Math.max(1, Math.min(limit, 200));
    const localPage = this.localChildren(threadId, pageLimit + 1);
    const localPartial = localPage.length > pageLimit;
    const local = localPage.slice(0, pageLimit);
    if (this.isRoot) return { children: local, partial: localPartial };
    const parent = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (parent?.from.host !== this.host || !this.rootOnline || !this.rootSupports("team-child-view")) {
      return { children: local, partial: true };
    }
    try {
      const remote = await this.uplink!.request<ThreadMeta[]>("thread/children", { threadId, limit: pageLimit + 1 }, 2000);
      const byId = new Map(localPage.map((child) => [child.threadId, child]));
      for (const child of remote) if (child.from.host !== this.host || !byId.has(child.threadId)) byId.set(child.threadId, child);
      const all = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
      return { children: all.slice(0, pageLimit), partial: localPartial || all.length > pageLimit };
    } catch {
      return { children: local, partial: true };
    }
  }

  /** Whether the selected Order was created in this Thread, including earlier turns. */
  hasOrder(threadId: string, orderId: string): boolean {
    return this.findParentOrder(orderId, threadId)?.threadId === threadId;
  }

  private taskOrderMeta(threadId: string, orderId: string): ThreadMeta | undefined {
    const meta = this.metas.get(threadId) ?? this.store.getThread(threadId);
    if (!meta || meta.orderId === orderId) return meta;
    const order = this.findParentOrder(orderId, threadId);
    const closed = this.closingEvent(threadId, orderId)?.event;
    if (order?.threadId !== threadId || closed?.type !== "order.closed") return undefined;
    const reported = this.store.findLastEvent(meta.file, (env) => env.orderId === orderId && env.event.type === "order.reported");
    return {
      ...meta,
      orderId,
      from: order.from,
      origin: order.origin,
      status: closed.status,
      reportedOrderId: reported ? orderId : undefined,
    };
  }

  /** Waiters read reports after the terminal Order stream has ended. */
  async orderResult(threadId: string, orderId: string) {
    let meta = this.taskOrderMeta(threadId, orderId);
    if (!meta) return undefined;
    if (!this.isRoot && this.rootOnline && this.rootSupports("team-child-view") && meta.from.host === this.host && meta.from.id.startsWith("cli:")) {
      await this.catchUpReports(meta, orderId);
      meta = this.taskOrderMeta(threadId, orderId) ?? meta;
    }
    const projected = await this.projectTaskMeta(meta, false);
    const reports = this.store.readOrderEvents(meta.file, orderId).flatMap(({ event }) =>
      event.type === "order.reported" ? [{ agentId: event.agentId, text: event.text }] : [],
    );
    return { taskStatus: projected.taskStatus, reports };
  }

  async projectTaskMeta(meta: ThreadMeta, includeRemote = true): Promise<ThreadMeta> {
    const [projected] = await this.projectTaskMetas([meta]);
    if (!includeRemote) return projected;
    const display = await this.childView(meta.threadId, 200);
    return display.partial ? { ...projected, childrenPartial: true } : projected;
  }

  private rememberTaskStatus(meta: ThreadMeta, status: NonNullable<ThreadMeta["taskStatus"]>): void {
    if (meta.parentThreadId) return;
    this.restoredTaskStatuses.set(meta.threadId, { orderId: meta.orderId, status });
    if (this.restoredTaskStatuses.size > 2000) this.restoredTaskStatuses.delete(this.restoredTaskStatuses.keys().next().value!);
  }

  async projectTaskMetas(metas: ThreadMeta[]): Promise<ThreadMeta[]> {
    const parents = this.isRoot ? [] : metas.filter((meta) => meta.from.host === this.host);
    let remote = new Map<string, { taskStatus?: ThreadMeta["taskStatus"]; pendingChildren?: number; childrenPartial: boolean; reportedOrderId?: string }>();
    if (!this.isRoot && this.rootOnline && this.rootSupports("team-child-view") && parents.length) {
      try {
        const rows = await this.uplink!.request<Array<{ threadId: string; orderId: string; taskStatus?: ThreadMeta["taskStatus"]; pendingChildren?: number; childrenPartial: boolean; reportedOrderId?: string }>>(
          Methods.threadTaskStatuses,
          { parents: parents.map(({ threadId, orderId }) => ({ threadId, orderId })) },
          3000,
        );
        remote = new Map(rows.map((row) => [`${row.threadId}:${row.orderId}`, row]));
      } catch {
        // A list must remain bounded when the Root cannot answer. Fall back to local evidence below.
      }
    }
    return Promise.all(metas.map(async (meta) => {
      const localChildren = this.localTaskChildren(meta.threadId, meta.orderId);
      const localStatus = projectTaskStatus(meta, localChildren, false);
      const projected = remote.get(`${meta.threadId}:${meta.orderId}`);
      const restored = this.restoredTaskStatuses.get(meta.threadId);
      if (projected) {
        // The Root sees every Host's children, so its answer wins when it has one. Local evidence only
        // fills a status Root omitted (work created here that has not synced yet) or a view Root
        // called incomplete.
        let taskStatus = projected.taskStatus;
        if (taskStatus === undefined || (projected.childrenPartial === true && localStatus)) taskStatus = localStatus ?? taskStatus;
        if ((meta.reportedOrderId === meta.orderId || projected.reportedOrderId === meta.orderId) && taskStatus !== "working" && taskStatus !== "unknown") taskStatus = "done";
        return { ...this.summaryMeta(meta), ...projected, ...(taskStatus ? { taskStatus } : {}) };
      }
      if (localStatus && localStatus !== "unknown") return { ...this.summaryMeta(meta), taskStatus: localStatus };
      const canUseRestored = restored?.orderId === meta.orderId && meta.reportedOrderId !== meta.orderId;
      if (canUseRestored) return { ...this.summaryMeta(meta), taskStatus: restored!.status };
      if (localStatus) return { ...this.summaryMeta(meta), taskStatus: localStatus };
      return this.summaryMeta(meta);
    }));
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

  snapshot(channel?: string) {
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
      features: [...this.features()],
      agents: this.registry.all(),
      daemons: this.daemons(),
      threads: (channel ? this.store.listThreadsIn(channel, 200) : this.store.listThreads(200)).map((m) => this.summaryMeta(m)),
    };
    this.stats.snapshotMs = performance.now() - started;
    return result;
  }

  private async catchUpReports(meta: ThreadMeta, orderId?: string): Promise<void> {
    const link = this.uplink!;
    try {
      const reports = await link.request<ThreadEnvelope[]>("thread/reports", { threadId: meta.threadId, orderId }, 2000);
      for (const env of reports) {
        if (env.threadId !== meta.threadId || (orderId && env.orderId !== orderId) || env.event.type !== "order.reported") continue;
        if (!this.store.findLastEvent(meta.file, (event) => event.eventId === env.eventId)) this.recordEvent(env, { from: link, skipTrack: true });
      }
    } catch {
      // Local reports remain readable while Root is unavailable.
    }
  }

  async linkedThreadDetail(threadId: string, opts: { limit?: number; before?: string }) {
    const local = this.thread(threadId, opts);
    if (this.isRoot || !this.rootOnline || !this.rootSupports("team-child-view")) return local;
    if (!local || (local.meta.parentThreadId && local.meta.from.host !== this.host)) {
      try {
        return await this.uplink!.request<ReturnType<Daemon["thread"]>>("thread/linked-detail", { threadId, ...opts }, 2000) ?? local;
      } catch {
        return local;
      }
    }
    if (local.meta.from.host === this.host && local.meta.from.id?.startsWith("cli:")) {
      await this.catchUpReports(local.meta);
      return this.thread(threadId, opts);
    }
    return local;
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
    for (const stop of this.linkWatchers) stop();
    this.linkWatchers.clear();
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
    clearInterval(this.digestTimer);
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

/** The addresses another machine can try to join this Root at (#95); see `Daemon.joinHint()`. */
export function joinAddresses(o: { advertise?: string; port: number; tlsPort?: number; lan: string[] }): { addresses: string[]; advertised: boolean } {
  const port = o.tlsPort || o.port;
  if (o.advertise) {
    const address = hostWithPort(o.advertise, port);
    // An explicit public port may be forwarded by NAT. Keep it as a candidate, and include
    // the TLS listener when the old advertised address explicitly names the main port.
    const namesMainPort = address === hostWithPort(bareHost(address), o.port);
    const tlsAddress = hostWithPort(bareHost(address), port);
    return { addresses: namesMainPort && tlsAddress !== address ? [tlsAddress, address] : [address], advertised: true };
  }
  const lan = o.lan.length ? o.lan : ["127.0.0.1"];
  return { addresses: lan.map((a) => hostWithPort(a, port)), advertised: false };
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
