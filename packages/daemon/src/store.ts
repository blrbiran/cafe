import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_CHANNEL, type AgentRecord, type HostIdentity, type OrderAssignment, type ThreadEnvelope, type ThreadMeta } from "@cafe/protocol";

/** Decode a Thread's metadata; a Thread written before channels existed is a default-channel Thread. */
function threadMeta(raw: string): ThreadMeta {
  const meta = JSON.parse(raw) as ThreadMeta;
  return meta.channel === undefined ? { ...meta, channel: DEFAULT_CHANNEL } : meta;
}

export interface StoredArtifact {
  id: string;
  /** Unset while the blob is staged, before its Order (and Thread) exists. */
  threadId?: string;
  host: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: number;
}

export interface RecipientAssignmentRecord extends OrderAssignment {
  orderId: string;
  threadId: string;
  receivedAt: number;
}

export interface RecipientAssignmentReceipt {
  assignmentId: string;
  agentId: string;
  acceptedAt: number;
}

export interface StoredOrderAssignment {
  orderId: string;
  threadId: string;
  assignment: OrderAssignment;
}

export interface MissingEventAuthority {
  kind: "order" | "assignment";
  id: string;
}

export interface InviteRedemptionRecord {
  inviteDigest: string;
  requestId: string;
  publicKeyFingerprint: string;
  sansHash: string;
  hostId: string;
  /** Returned only while this issuance remains current; cleared on supersession. */
  certificate?: string;
  state: "current" | "superseded";
  supersededByHostId?: string;
  supersededByRevision?: number;
}

export interface HostInviteRecord {
  inviteDigest: string;
  createdAt: number;
  expiresAt: number;
  hostId: string;
  host: string;
  expectedHostRevision?: number;
  expectedKeyFingerprint?: string;
  /** Existing routing slug being re-enrolled, including legacy Hosts without HostIdentity yet. */
  replaceHostSlug?: string;
  state: "issued" | "consumed" | "superseded";
  requestId?: string;
  publicKeyFingerprint?: string;
  sansHash?: string;
}

export interface HostEnrollmentInput {
  inviteDigest: string;
  now: number;
  requestId: string;
  publicKeyFingerprint: string;
  sansHash: string;
  certificate: string;
  /** Computed by the Root immediately before the synchronous commit. */
  replacementHostOnline?: boolean;
}

export interface HostEnrollmentResult {
  identity: HostIdentity;
  redemption: InviteRedemptionRecord;
  retry: boolean;
}

export interface CallerPrincipalRecord {
  kind: "human" | "connector" | "operator";
  credentialDigest: string;
  principalId: string;
}

const PENDING_EVENTS_MAX = 5000;
// Fail closed at capacity; evicting a receipt could let a replay inject accepted work twice.
const RECIPIENT_ASSIGNMENTS_MAX = 5000;

/**
 * Thread content lives in append-only JSONL files; SQLite keeps only metadata
 * and the Registry cache (ADR-0003).
 */
export class Store {
  private db: DatabaseSync;
  readonly home: string;

  constructor(home: string) {
    this.home = home;
    mkdirSync(join(home, "sessions"), { recursive: true });
    this.db = new DatabaseSync(join(home, "cafe.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        channel TEXT,
        parent_order_id TEXT,
        meta TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_created ON threads(created_at DESC);
      CREATE INDEX IF NOT EXISTS threads_status_created_id ON threads(status, created_at, thread_id);
      CREATE TABLE IF NOT EXISTS registry (
        agent_id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_events (
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        thread_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_events_at ON agent_events(at);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        kind TEXT NOT NULL,
        cwd TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, cwd, thread_id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        host TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_thread ON artifacts(thread_id);
      -- Full-text index over the searchable text of each Order/reply (#34). Trigram tokenizer =
      -- case-insensitive substring match (cafe search is substring, not word, matching); a query
      -- shorter than 3 characters falls back to the JSONL scan.
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(event_id UNINDEXED, thread_id UNINDEXED, order_id UNINDEXED, who UNINDEXED, at UNINDEXED, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS search_indexed (event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_backfilled_threads (thread_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pending_events (
        event_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        missing_authority TEXT NOT NULL,
        event_json TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_events_order_at ON pending_events(order_id, at, event_id);
      CREATE TABLE IF NOT EXISTS host_identities (
        host_id TEXT PRIMARY KEY,
        host TEXT NOT NULL UNIQUE,
        key_fingerprint TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        revision INTEGER,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_redemptions (
        invite_digest TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL,
        sans_hash TEXT NOT NULL,
        host_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_invites (
        invite_digest TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS caller_principals (
        kind TEXT NOT NULL,
        credential_digest TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        PRIMARY KEY(kind, credential_digest),
        UNIQUE(kind, principal_id)
      );
      CREATE TABLE IF NOT EXISTS recipient_assignments (
        assignment_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        target_host_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recipient_assignments_received ON recipient_assignments(received_at, assignment_id);
      CREATE TABLE IF NOT EXISTS recipient_assignment_receipts (
        assignment_id TEXT PRIMARY KEY REFERENCES recipient_assignments(assignment_id),
        agent_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
    `);
    // v2: identity (`name@host`, survives restarts) and the Order's keywords, for routing hints.
    const cols = new Set((this.db.prepare("PRAGMA table_info(agent_events)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("identity")) this.db.exec("ALTER TABLE agent_events ADD COLUMN identity TEXT");
    if (!cols.has("tokens")) this.db.exec("ALTER TABLE agent_events ADD COLUMN tokens TEXT");
    // After the migration: an older database gets `identity` just above (#68).
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_events_identity ON agent_events(identity, kind, at DESC)");
    // v4-11: channel is a first-class column so filtering never scans the 200-Thread snapshot
    // or the metadata JSON. Old rows are default-channel Threads.
    const threadCols = new Set((this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name));
    if (!threadCols.has("channel")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN channel TEXT");
      this.db.exec("UPDATE threads SET channel = COALESCE(json_extract(meta, '$.channel'), 'default')");
    }
    // v4-12: channel history and observer digests page by ACTIVITY, not creation time. An old
    // Thread that receives a reply must not fall outside the newest-500-by-creation window.
    if (!threadCols.has("last_activity")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN last_activity INTEGER");
      this.db.exec("UPDATE threads SET last_activity = COALESCE(json_extract(meta, '$.lastActivityAt'), created_at)");
    }
    // v4-13: a sub-Thread's parent is queryable without scanning the metadata JSON (#112).
    if (!threadCols.has("parent_thread_id")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN parent_thread_id TEXT");
      this.db.exec("UPDATE threads SET parent_thread_id = json_extract(meta, '$.parentThreadId')");
    }
    if (!threadCols.has("parent_order_id")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN parent_order_id TEXT");
      this.db.exec("UPDATE threads SET parent_order_id = json_extract(meta, '$.parentOrderId')");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_channel_created ON threads(channel, created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_channel_activity ON threads(channel, last_activity DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_parent ON threads(parent_thread_id, created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_parent_order ON threads(parent_thread_id, parent_order_id, created_at DESC)");
    this.upsertIndexRows = this.prepareIndexRows();
  }

  putHostIdentity(identity: HostIdentity): void {
    const record = JSON.stringify(identity);
    this.db.prepare(`
      INSERT INTO host_identities(host_id, host, key_fingerprint, state, revision, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        host = excluded.host,
        key_fingerprint = excluded.key_fingerprint,
        state = excluded.state,
        revision = excluded.revision,
        record_json = excluded.record_json
    `).run(identity.hostId, identity.host, identity.keyFingerprint, identity.state, identity.revision ?? null, record);
  }

  getHostIdentity(hostId: string): HostIdentity | undefined {
    const row = this.db.prepare("SELECT record_json FROM host_identities WHERE host_id = ?").get(hostId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as HostIdentity : undefined;
  }

  getHostIdentityByHost(host: string): HostIdentity | undefined {
    const row = this.db.prepare("SELECT record_json FROM host_identities WHERE host = ?").get(host) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as HostIdentity : undefined;
  }

  getHostIdentityByKeyFingerprint(keyFingerprint: string): HostIdentity | undefined {
    const row = this.db.prepare("SELECT record_json FROM host_identities WHERE key_fingerprint = ?").get(keyFingerprint) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as HostIdentity : undefined;
  }

  createHostInvite(invite: HostInviteRecord): void {
    if (invite.state !== "issued" || !invite.inviteDigest || invite.expiresAt <= invite.createdAt) {
      throw new Error("invalid Host invite");
    }
    const current = this.getHostInvite(invite.inviteDigest);
    if (current) {
      if (JSON.stringify(current) === JSON.stringify(invite)) return;
      throw new Error("invite digest already exists");
    }
    if (invite.expectedHostRevision !== undefined) {
      const old = this.getHostIdentity(invite.hostId);
      if (!old || old.revision !== invite.expectedHostRevision || old.keyFingerprint !== invite.expectedKeyFingerprint) {
        throw new Error("Host replacement precondition does not match current identity");
      }
    } else if (invite.replaceHostSlug) {
      if (invite.replaceHostSlug !== invite.host || this.getHostIdentityByHost(invite.host)) throw new Error("legacy Host replacement precondition does not match current identity");
    } else if (this.getHostIdentity(invite.hostId) || this.getHostIdentityByHost(invite.host)) {
      throw new Error("Host identity or routing slug already exists");
    }
    this.db.prepare("INSERT INTO host_invites(invite_digest, host_id, expires_at, state, record_json) VALUES (?, ?, ?, ?, ?)")
      .run(invite.inviteDigest, invite.hostId, invite.expiresAt, invite.state, JSON.stringify(invite));
  }

  getHostInvite(inviteDigest: string): HostInviteRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM host_invites WHERE invite_digest = ?").get(inviteDigest) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as HostInviteRecord : undefined;
  }

  commitHostEnrollment(input: {
    inviteDigest: string;
    now: number;
    requestId: string;
    publicKeyFingerprint: string;
    sansHash: string;
    certificate: string;
    replacementHostOnline?: boolean;
  }): HostEnrollmentResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const invite = this.getHostInvite(input.inviteDigest);
      if (!invite) throw new Error("unknown Host invite");
      const existingRedemption = this.getInviteRedemption(input.inviteDigest);
      const sameRequest = invite.requestId === input.requestId &&
        invite.publicKeyFingerprint === input.publicKeyFingerprint && invite.sansHash === input.sansHash;
      const identity = this.getHostIdentity(invite.hostId);
      if (invite.state === "superseded" || existingRedemption?.state === "superseded") {
        if (!identity || !existingRedemption) throw new Error("credential_superseded");
        this.db.exec("COMMIT");
        return { identity, redemption: existingRedemption, retry: false };
      }
      if (invite.state === "consumed") {
        if (!sameRequest || !existingRedemption) throw new Error("invite already redeemed by a different request");
        if (!identity || identity.keyFingerprint !== input.publicKeyFingerprint) throw new Error("credential_superseded");
        this.db.exec("COMMIT");
        return { identity, redemption: existingRedemption, retry: true };
      }
      if (input.now >= invite.expiresAt) throw new Error("Host invite expired");
      if (invite.expectedHostRevision !== undefined || invite.replaceHostSlug) {
        if (input.replacementHostOnline !== false) throw new Error("Host replacement requires the previous Host to be offline");
        if (invite.expectedHostRevision !== undefined) {
          if (!identity || identity.revision !== invite.expectedHostRevision || identity.keyFingerprint !== invite.expectedKeyFingerprint) {
            throw new Error("Host replacement revision/fingerprint conflict");
          }
        } else if (identity || this.getHostIdentityByHost(invite.host)) {
          throw new Error("legacy Host replacement precondition changed");
        }
      } else if (identity || this.getHostIdentityByHost(invite.host)) {
        throw new Error("Host identity or routing slug already exists");
      }
      const nextRevision = invite.expectedHostRevision === undefined ? 1 : invite.expectedHostRevision + 1;
      const nextIdentity: HostIdentity = {
        hostId: invite.hostId,
        host: invite.host,
        keyFingerprint: input.publicKeyFingerprint,
        state: "enrolled",
        revision: nextRevision,
      };
      const redemption: InviteRedemptionRecord = {
        inviteDigest: invite.inviteDigest,
        requestId: input.requestId,
        publicKeyFingerprint: input.publicKeyFingerprint,
        sansHash: input.sansHash,
        hostId: invite.hostId,
        certificate: input.certificate,
        state: "current",
      };
      const consumed: HostInviteRecord = {
        ...invite,
        state: "consumed",
        requestId: input.requestId,
        publicKeyFingerprint: input.publicKeyFingerprint,
        sansHash: input.sansHash,
      };
      this.putHostIdentity(nextIdentity);
      this.db.prepare("UPDATE host_invites SET state = ?, record_json = ? WHERE invite_digest = ?")
        .run(consumed.state, JSON.stringify(consumed), invite.inviteDigest);
      this.db.prepare(`
        INSERT INTO invite_redemptions(invite_digest, request_id, public_key_fingerprint, sans_hash, host_id, state, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(redemption.inviteDigest, redemption.requestId, redemption.publicKeyFingerprint, redemption.sansHash,
        redemption.hostId, redemption.state, JSON.stringify(redemption));
      if (invite.expectedHostRevision !== undefined) {
        const oldRows = this.db.prepare("SELECT invite_digest, record_json FROM invite_redemptions WHERE host_id = ? AND invite_digest <> ? AND state = 'current'")
          .all(invite.hostId, invite.inviteDigest) as { invite_digest: string; record_json: string }[];
        for (const oldRow of oldRows) {
          const oldRedemption = JSON.parse(oldRow.record_json) as InviteRedemptionRecord;
          const tombstone: InviteRedemptionRecord = {
            ...oldRedemption,
            certificate: undefined,
            state: "superseded",
            supersededByHostId: invite.hostId,
            supersededByRevision: nextRevision,
          };
          this.db.prepare("UPDATE invite_redemptions SET state = ?, record_json = ? WHERE invite_digest = ?")
            .run(tombstone.state, JSON.stringify(tombstone), oldRow.invite_digest);
          const oldInvite = this.getHostInvite(oldRow.invite_digest);
          if (oldInvite) {
            this.db.prepare("UPDATE host_invites SET state = ?, record_json = ? WHERE invite_digest = ?")
              .run("superseded", JSON.stringify({ ...oldInvite, state: "superseded" }), oldRow.invite_digest);
          }
        }
      }
      this.db.exec("COMMIT");
      return { identity: nextIdentity, redemption, retry: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  putInviteRedemption(record: InviteRedemptionRecord): InviteRedemptionRecord {
    const existing = this.getInviteRedemption(record.inviteDigest);
    if (existing) {
      const sameRequest = existing.requestId === record.requestId &&
        existing.publicKeyFingerprint === record.publicKeyFingerprint &&
        existing.sansHash === record.sansHash;
      if (!sameRequest) throw new Error("invite already redeemed by a different request");
      if (existing.hostId !== record.hostId) throw new Error("invite redemption host identity conflict");
      if (existing.state === "superseded") return existing;
      return existing;
    }
    this.db.prepare(`
      INSERT INTO invite_redemptions(invite_digest, request_id, public_key_fingerprint, sans_hash, host_id, state, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.inviteDigest, record.requestId, record.publicKeyFingerprint, record.sansHash, record.hostId, record.state, JSON.stringify(record));
    return record;
  }

  getInviteRedemption(inviteDigest: string): InviteRedemptionRecord | undefined {
    const row = this.db.prepare("SELECT record_json, state FROM invite_redemptions WHERE invite_digest = ?").get(inviteDigest) as { record_json: string; state: InviteRedemptionRecord["state"] } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.record_json) as InviteRedemptionRecord;
    return { ...record, ...(row.state === "superseded" ? { certificate: undefined } : {}) };
  }

  markInviteSuperseded(inviteDigest: string, supersededByHostId: string, revision: number): void {
    const current = this.getInviteRedemption(inviteDigest);
    if (!current) throw new Error("unknown invite redemption");
    const record: InviteRedemptionRecord = {
      ...current,
      certificate: undefined,
      state: "superseded",
      supersededByHostId,
      supersededByRevision: revision,
    };
    this.db.prepare("UPDATE invite_redemptions SET state = ?, record_json = ? WHERE invite_digest = ?")
      .run(record.state, JSON.stringify(record), inviteDigest);
  }

  putCallerPrincipal(principal: CallerPrincipalRecord): string {
    const existing = this.getCallerPrincipal(principal.kind, principal.credentialDigest);
    if (existing) return existing;
    this.db.prepare("INSERT INTO caller_principals(kind, credential_digest, principal_id) VALUES (?, ?, ?)")
      .run(principal.kind, principal.credentialDigest, principal.principalId);
    return principal.principalId;
  }

  getCallerPrincipal(kind: CallerPrincipalRecord["kind"], credentialDigest: string): string | undefined {
    const row = this.db.prepare("SELECT principal_id FROM caller_principals WHERE kind = ? AND credential_digest = ?")
      .get(kind, credentialDigest) as { principal_id: string } | undefined;
    return row?.principal_id;
  }

  putRecipientAssignment(record: RecipientAssignmentRecord): RecipientAssignmentRecord {
    if (!record.assignmentId || !record.orderId || !record.threadId || !record.targetAgentId || !record.targetHostId || !record.bodyHash) {
      throw new Error("recipient assignment requires exact IDs and body hash");
    }
    const existing = this.getRecipientAssignment(record.assignmentId);
    if (existing) {
      if (!isDeepStrictEqual(existing, record)) throw new Error(`recipient assignment conflict: ${record.assignmentId}`);
      return existing;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Recheck under the write lock so parallel retries cannot exceed the bounded inbox.
      const raced = this.getRecipientAssignment(record.assignmentId);
      if (raced) {
        if (!isDeepStrictEqual(raced, record)) throw new Error(`recipient assignment conflict: ${record.assignmentId}`);
        this.db.exec("COMMIT");
        return raced;
      }
      const count = (this.db.prepare("SELECT COUNT(*) AS n FROM recipient_assignments").get() as { n: number }).n;
      if (count >= RECIPIENT_ASSIGNMENTS_MAX) throw new Error(`recipient assignment inbox is full (${RECIPIENT_ASSIGNMENTS_MAX})`);
      this.db.prepare(`
        INSERT INTO recipient_assignments(assignment_id, order_id, thread_id, target_agent_id, target_host_id, record_json, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.assignmentId, record.orderId, record.threadId, record.targetAgentId, record.targetHostId, JSON.stringify(record), record.receivedAt);
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRecipientAssignment(assignmentId: string): RecipientAssignmentRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM recipient_assignments WHERE assignment_id = ?")
      .get(assignmentId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as RecipientAssignmentRecord : undefined;
  }

  putRecipientAssignmentReceipt(receipt: RecipientAssignmentReceipt): RecipientAssignmentReceipt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const assignment = this.getRecipientAssignment(receipt.assignmentId);
      if (!assignment) throw new Error(`recipient assignment not found: ${receipt.assignmentId}`);
      const existing = this.getRecipientAssignmentReceipt(receipt.assignmentId);
      if (existing) {
        if (!isDeepStrictEqual(existing, receipt)) throw new Error(`recipient receipt conflict: ${receipt.assignmentId}`);
        this.db.exec("COMMIT");
        return existing;
      }
      if (assignment.targetAgentId !== receipt.agentId) throw new Error("recipient receipt Agent does not match assignment target Agent");
      this.db.prepare(`
        INSERT INTO recipient_assignment_receipts(assignment_id, agent_id, accepted_at, record_json)
        VALUES (?, ?, ?, ?)
      `).run(receipt.assignmentId, receipt.agentId, receipt.acceptedAt, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRecipientAssignmentReceipt(assignmentId: string): RecipientAssignmentReceipt | undefined {
    const row = this.db.prepare("SELECT record_json FROM recipient_assignment_receipts WHERE assignment_id = ?")
      .get(assignmentId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as RecipientAssignmentReceipt : undefined;
  }

  /** Look up one journaled assignment by both its owning Order ID and immutable assignment ID. */
  getOrderAssignment(file: string, orderId: string, assignmentId: string): StoredOrderAssignment | undefined {
    let found: StoredOrderAssignment | undefined;
    for (const env of this.readEvents(file)) {
      if (env.orderId !== orderId) continue;
      const event = env.event;
      const assignments = event.type === "order.assigned"
        ? [event.assignment]
        : event.type === "order.replaced" && event.order.orderId === orderId && event.order.threadId === env.threadId
          ? event.assignments
          : [];
      for (const assignment of assignments) {
        if (assignment.assignmentId !== assignmentId) continue;
        const candidate = { orderId, threadId: env.threadId, assignment };
        if (found && !isDeepStrictEqual(found, candidate)) {
          throw new Error(`assignment ID is ambiguous within Order ${orderId}: ${assignmentId}`);
        }
        found = candidate;
      }
    }
    return found;
  }

  threadFile(threadId: string, createdAt: number): string {
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const dir = join(this.home, "sessions", day);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${threadId}.jsonl`);
  }

  /** Append one event line; returns the bytes written (for /api/health counters). */
  appendEvent(file: string, env: ThreadEnvelope): number {
    const fd = openSync(file, "a+");
    try {
      const size = fstatSync(fd).size;
      const tail = Buffer.alloc(1);
      // Preserve a torn record as-is and separate it from the next complete record.
      const separator = size > 0 && readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 0x0a ? "\n" : "";
      const line = `${separator}${JSON.stringify(env)}\n`;
      appendFileSync(fd, line);
      return Buffer.byteLength(line);
    } finally {
      closeSync(fd);
    }
  }

  readEvents(file: string): ThreadEnvelope[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ThreadEnvelope];
        } catch {
          return [];
        }
      });
  }

  /** Persist an authenticated event that is waiting for its Order/assignment evidence. */
  stagePendingEvent(env: ThreadEnvelope, missing: MissingEventAuthority): void {
    if (!env.eventHostId) throw new Error("pending event must have an authenticated eventHostId");
    if (!missing.id) throw new Error("pending event requires a missing authority id");
    const eventJson = JSON.stringify(env);
    const existing = this.db.prepare("SELECT event_json FROM pending_events WHERE event_id = ?").get(env.eventId) as { event_json: string } | undefined;
    if (existing) {
      if (existing.event_json !== eventJson) throw new Error(`pending event id conflict: ${env.eventId}`);
      return;
    }
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM pending_events").get() as { n: number }).n;
    if (count >= PENDING_EVENTS_MAX) throw new Error(`pending event journal is full (${PENDING_EVENTS_MAX})`);
    this.db.prepare(
      "INSERT INTO pending_events(event_id, thread_id, order_id, missing_authority, event_json, at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(env.eventId, env.threadId, env.orderId, JSON.stringify(missing), eventJson, env.at);
  }

  /** Pending events are returned oldest-first so dependencies can be applied in journal order. */
  listPendingEvents(threadId?: string): ThreadEnvelope[] {
    const rows = threadId
      ? this.db.prepare("SELECT event_json FROM pending_events WHERE thread_id = ? ORDER BY at, event_id").all(threadId) as { event_json: string }[]
      : this.db.prepare("SELECT event_json FROM pending_events ORDER BY at, event_id").all() as { event_json: string }[];
    return rows.map((row) => JSON.parse(row.event_json) as ThreadEnvelope);
  }

  /**
   * Append staged envelopes to their Thread journal and then delete their pending rows. If the process
   * crashes between append and delete, replay is safe because eventId is checked before appending again.
   */
  commitPendingEvents(file: string, eventIds: string[]): ThreadEnvelope[] {
    const unique = [...new Set(eventIds)];
    const current = new Set(this.readEvents(file).map((env) => env.eventId));
    const committed: ThreadEnvelope[] = [];
    const remove = this.db.prepare("DELETE FROM pending_events WHERE event_id = ?");
    for (const eventId of unique) {
      const row = this.db.prepare("SELECT event_json, thread_id FROM pending_events WHERE event_id = ?").get(eventId) as { event_json: string; thread_id: string } | undefined;
      if (!row) continue;
      const env = JSON.parse(row.event_json) as ThreadEnvelope;
      if (row.thread_id !== env.threadId) throw new Error(`pending event thread mismatch: ${eventId}`);
      if (!current.has(eventId)) {
        this.appendEvent(file, env);
        current.add(eventId);
      }
      committed.push(env);
      remove.run(eventId);
    }
    return committed;
  }

  /** The last `limit` events, read from the end so a long Thread is not parsed whole. */
  readEventsTail(file: string, limit: number): ThreadEnvelope[] {
    return this.readEventsPage(file, limit).events;
  }

  // ---------------------------------------------------------------------------
  // Search index (#34)
  // ---------------------------------------------------------------------------

  /** The searchable text of an event: the question, a Barista reply, or a result report; undefined otherwise. */
  private static searchable(env: ThreadEnvelope, who: (agentId: string) => string): { who: string; text: string } | undefined {
    const ev = env.event;
    if (ev.type === "order.created") return { who: ev.order.from.address, text: ev.order.body };
    if (ev.type === "order.replied" || ev.type === "order.reported") return { who: who(ev.agentId), text: ev.text };
    return undefined;
  }

  /**
   * Index one event for `cafe search`. `who` resolves an agent id to its display address. Text shorter
   * than the trigram minimum still goes in (trigram ignores it) — `search()` scans the JSONL for short
   * queries.
   */
  indexEvent(env: ThreadEnvelope, who: (agentId: string) => string): void {
    // Only events with searchable text belong in the index (#67). Heartbeats, acks and closes made
    // up most of the write volume and produced nothing `cafe search` could ever match.
    const hit = Store.searchable(env, who);
    if (!hit?.text) return;
    if (this.upsertIndexRows) {
      this.upsertIndexRows(env, hit);
      return;
    }
    if (this.db.prepare("SELECT 1 FROM search_indexed WHERE event_id = ?").get(env.eventId)) return;
    this.db.prepare("INSERT OR IGNORE INTO search_indexed(event_id, thread_id) VALUES (?, ?)").run(env.eventId, env.threadId);
    this.db.prepare("INSERT INTO search_index(event_id, thread_id, order_id, who, at, text) VALUES (?, ?, ?, ?, ?, ?)").run(env.eventId, env.threadId, env.orderId, hit.who, env.at, hit.text);
  }

  /** Pre-compiled index statements; `indexEvent` runs on the event hot path. */
  private upsertIndexRows?: ReturnType<Store["prepareIndexRows"]>;

  private prepareIndexRows() {
    const seen = this.db.prepare("SELECT 1 FROM search_indexed WHERE event_id = ?");
    const mark = this.db.prepare("INSERT OR IGNORE INTO search_indexed(event_id, thread_id) VALUES (?, ?)");
    const insert = this.db.prepare("INSERT INTO search_index(event_id, thread_id, order_id, who, at, text) VALUES (?, ?, ?, ?, ?, ?)");
    return (env: ThreadEnvelope, hit: { who: string; text: string }) => {
      if (seen.get(env.eventId)) return;
      mark.run(env.eventId, env.threadId);
      insert.run(env.eventId, env.threadId, env.orderId, hit.who, env.at, hit.text);
    };
  }

  /** Whether the FTS index has an entry for this event (a Thread migrated before indexing). */
  isIndexed(eventId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM search_indexed WHERE event_id = ?").get(eventId);
  }

  /** Number of indexed events, for diagnostics. */
  countIndexed(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM search_indexed").get() as { n: number }).n;
  }

  /** Drop all index rows for a Thread (prune). */
  unindexThread(threadId: string): void {
    this.db.prepare("DELETE FROM search_index WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM search_indexed WHERE thread_id = ?").run(threadId);
  }

  /** Threads requiring search-index work, including the one-time report upgrade scan, oldest first. */
  threadsNeedingIndex(limit: number): ThreadMeta[] {
    const rows = this.db
      .prepare(
        "SELECT meta FROM threads WHERE thread_id NOT IN (SELECT thread_id FROM search_backfilled_threads) OR thread_id NOT IN (SELECT DISTINCT thread_id FROM search_indexed) ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Mark a Thread scanned for report events during the bounded search-index upgrade. */
  markSearchBackfilled(threadId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO search_backfilled_threads(thread_id) VALUES (?)").run(threadId);
  }

  /**
   * Substring search over the FTS trigram index. Returns raw hits in recency order (newest first),
   * capped at `limit` Threads. A query shorter than 3 characters (the trigram minimum) yields `short: true`.
   */
  searchIndex(q: string, limit: number, channel?: string): { hits: { eventId: string; threadId: string; orderId: string; who: string; at: number; text: string }[]; short: boolean } {
    if (q.length < 3) return { hits: [], short: true };
    // FTS5 string literals: wrap in double quotes, doubling any embedded quote; the trigram tokenizer
    // then treats the whole thing as a case-insensitive substring.
    const phrase = `"${q.replace(/"/g, '""')}"`;
    let rows: { event_id: string; thread_id: string; order_id: string; who: string; at: string; text: string }[];
    try {
      // The channel predicate is applied BEFORE the limit so a channel with matches is never
      // starved by hits from other channels (v4-11 review).
      rows = (
        channel
          ? this.db
              .prepare(
                "SELECT si.event_id, si.thread_id, si.order_id, si.who, si.at, si.text FROM search_index si JOIN threads t ON t.thread_id = si.thread_id WHERE si.search_index MATCH ? AND t.channel = ? ORDER BY si.at DESC LIMIT ?",
              )
              .all(phrase, channel, Math.max(1, limit) * 20)
          : this.db
              .prepare("SELECT event_id, thread_id, order_id, who, at, text FROM search_index WHERE search_index MATCH ? ORDER BY at DESC LIMIT ?")
              .all(phrase, Math.max(1, limit) * 20)
      ) as typeof rows;
    } catch {
      // A query the tokenizer rejects (unbalanced quote, symbol-only): no hits rather than an error.
      return { hits: [], short: false };
    }
    return { hits: rows.map((r) => ({ eventId: r.event_id, threadId: r.thread_id, orderId: r.order_id, who: r.who, at: Number(r.at), text: r.text })), short: false };
  }

  /** Everything indexed so far, grouped by Thread — used to backfill the index once on first start. */
  indexedThreadIds(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT thread_id FROM search_index").all() as { thread_id: string }[];
    return new Set(rows.map((r) => r.thread_id));
  }

  /**
   * A page of events read backwards from the end: the newest `limit` events, or
   * those strictly before `before` (an eventId). The cost is proportional to the
   * bytes scanned, not to the Thread length, and `hasMore` tells the client
   * whether older events remain (#31).
   */
  readEventsPage(file: string, limit: number, before?: string): { events: ThreadEnvelope[]; hasMore: boolean } {
    if (limit <= 0) return { events: [], hasMore: false };
    let skipping = !!before;
    const newestFirst: ThreadEnvelope[] = [];
    let hasMore = false;
    this.scanBackward(file, (env) => {
      if (skipping) {
        if (env.eventId === before) skipping = false;
        return false;
      }
      if (newestFirst.length === limit) {
        hasMore = true;
        return true;
      }
      newestFirst.push(env);
      return false;
    });
    return { events: newestFirst.reverse(), hasMore };
  }

  /**
   * The events of one Order, oldest first, read backwards until its `order.created` (#31: recovery
   * re-arms the latest Order of a Thread without parsing the whole Thread).
   */
  readOrderEvents(file: string, orderId: string): ThreadEnvelope[] {
    const newestFirst: ThreadEnvelope[] = [];
    let foundCreation = false;
    this.scanBackward(file, (env) => {
      const event = env.event;
      const isCreatedHere = event.type === "order.created" && event.order.orderId === orderId;
      const isReplacementOfOrder = event.type === "order.replaced" && event.previousOrderId === orderId;
      const isReplacementCreation = event.type === "order.replaced" && event.order.orderId === orderId;
      if (env.orderId !== orderId && !isReplacementOfOrder) return false;
      newestFirst.push(env);
      return (foundCreation = isCreatedHere || isReplacementCreation);
    });
    return foundCreation ? newestFirst.reverse() : [];
  }

  /**
   * Events whose `at` is at or after `since`, oldest first, read backwards until the first older one
   * (#31: a backfill touches only the window the Root missed). Events are appended in arrival order, so
   * callers pass a margin for clock skew between Hosts.
   */
  readEventsSince(file: string, since: number): ThreadEnvelope[] {
    const newestFirst: ThreadEnvelope[] = [];
    this.scanBackward(file, (env) => {
      if (env.at < since) return true;
      newestFirst.push(env);
      return false;
    });
    return newestFirst.reverse();
  }

  /**
   * Events strictly after `after` (an eventId), oldest first, read backwards until the cursor (#31: an
   * SSE client resuming from a cursor older than the default page must get every later event).
   * `found: false` when the cursor is not in the file, or more than `max` events follow it — the caller
   * reports a gap rather than silently sending a partial replay.
   */
  readEventsAfter(file: string, after: string, max: number): { events: ThreadEnvelope[]; found: boolean } {
    const newestFirst: ThreadEnvelope[] = [];
    let found = false;
    this.scanBackward(file, (env) => {
      if (env.eventId === after) return (found = true);
      if (newestFirst.length === max) return true;
      newestFirst.push(env);
      return false;
    });
    return found ? { events: newestFirst.reverse(), found } : { events: [], found };
  }

  /** The latest matching events, in chronological order. Only matches count toward the limit. */
  readMatchingEvents(file: string, limit: number, matches: (env: ThreadEnvelope) => boolean): ThreadEnvelope[] {
    if (limit <= 0) return [];
    const events: ThreadEnvelope[] = [];
    this.scanBackward(file, (env) => {
      if (matches(env)) events.push(env);
      return events.length >= limit;
    });
    return events.reverse();
  }

  /** The newest event matching `match`, read from the end; stops at the first hit (#31). */
  findLastEvent(file: string, match: (env: ThreadEnvelope) => boolean): ThreadEnvelope | undefined {
    let hit: ThreadEnvelope | undefined;
    this.scanBackward(file, (env) => {
      if (!match(env)) return false;
      hit = env;
      return true;
    });
    return hit;
  }

  /**
   * Visit a Thread's events newest first, reading 64 KiB chunks from the end; `visit` returns true to
   * stop. Unparseable lines are skipped.
   */
  private scanBackward(file: string, visit: (env: ThreadEnvelope) => boolean): void {
    if (!existsSync(file)) return;
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const chunk = 64 * 1024;
      let pos = size;
      // The first line of a backwards chunk can be cut in half; carry its bytes into the next (earlier)
      // read. Lines are split on the 0x0A byte and decoded whole: a chunk boundary can fall inside a
      // multi-byte UTF-8 character, and decoding a chunk before joining would turn it into U+FFFD (#90).
      // 0x0A never occurs inside a multi-byte sequence, so splitting the raw bytes is safe.
      let carry: Buffer = Buffer.alloc(0);
      const take = (line: Buffer): boolean => {
        if (!line.length) return false;
        let env: ThreadEnvelope;
        try {
          env = JSON.parse(line.toString("utf8")) as ThreadEnvelope;
        } catch {
          return false;
        }
        return visit(env);
      };
      while (pos > 0) {
        const len = Math.min(chunk, pos);
        pos -= len;
        const b = Buffer.allocUnsafe(len);
        readSync(fd, b, 0, len, pos);
        const buf = carry.length ? Buffer.concat([b, carry]) : b;
        // Walk the lines newest first; `end` is the exclusive end of the current line.
        let end = buf.length;
        for (let nl = buf.lastIndexOf(0x0a, end - 1); nl >= 0; nl = buf.lastIndexOf(0x0a, end - 1)) {
          if (take(buf.subarray(nl + 1, end))) return;
          end = nl;
          if (end === 0) break;
        }
        // Whatever precedes the first newline is incomplete when there are bytes before this chunk.
        carry = buf.subarray(0, end);
        if (pos === 0 && take(carry)) return;
      }
    } finally {
      closeSync(fd);
    }
  }



  /** Published clarifications whose metadata has not yet recorded an answer. */
  unansweredClarifications(): ThreadMeta[] {
    const rows = this.db.prepare(`SELECT meta FROM threads
      WHERE json_extract(meta, '$.clarification.orderId') IS NOT NULL
      AND json_extract(meta, '$.turns') = 1`).all() as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Unfinished threads (recovery after a restart). Finished ones are never read back. */
  openThreads(limit = 1000): ThreadMeta[] {
    const rows = this.db.prepare("SELECT meta FROM threads WHERE status NOT IN ('done','failed','cancelled') ORDER BY created_at DESC LIMIT ?").all(limit) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Unfinished threads, in stable creation/id order for keyset recovery pages. */
  openThreadsPage(limit: number, after?: { createdAt: number; threadId: string }): ThreadMeta[] {
    const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 10_000) : 1000;
    if (n === 0) return [];
    const openStatuses = ["routing", "delivering", "working"];
    const statusParams = openStatuses.map(() => "?").join(", ");
    const rows = (after
      ? this.db.prepare(`SELECT meta FROM threads WHERE status IN (${statusParams}) AND (created_at > ? OR (created_at = ? AND thread_id > ?)) ORDER BY created_at ASC, thread_id ASC LIMIT ?`).all(...openStatuses, after.createdAt, after.createdAt, after.threadId, n)
      : this.db.prepare(`SELECT meta FROM threads WHERE status IN (${statusParams}) ORDER BY created_at ASC, thread_id ASC LIMIT ?`).all(...openStatuses, n)) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Upsert one Thread's metadata; returns the serialized bytes (for /api/health counters). */
  putThread(meta: ThreadMeta): number {
    const json = JSON.stringify(meta);
    this.db
      .prepare("INSERT INTO threads(thread_id, created_at, status, channel, last_activity, parent_thread_id, parent_order_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET status=excluded.status, channel=excluded.channel, last_activity=excluded.last_activity, parent_thread_id=excluded.parent_thread_id, parent_order_id=excluded.parent_order_id, meta=excluded.meta")
      .run(meta.threadId, meta.createdAt, meta.status, meta.channel ?? "default", meta.lastActivityAt ?? meta.createdAt, meta.parentThreadId ?? null, meta.parentOrderId ?? null, json);
    return Buffer.byteLength(json);
  }

  getThread(threadId: string): ThreadMeta | undefined {
    const row = this.db.prepare("SELECT meta FROM threads WHERE thread_id = ?").get(threadId) as { meta: string } | undefined;
    return row ? (threadMeta(row.meta)) : undefined;
  }

  /** Cheap count for /api/health; never loads the metadata payloads. */
  countThreads(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;
  }

  /** Newest first. `before`: only threads created before this time (paging to older threads). */
  listThreads(limit = 200, status?: string, before = Number.MAX_SAFE_INTEGER): ThreadMeta[] {
    // Defensive: SQLite reads LIMIT -1 as "all rows", and NaN binds as a datatype error.
    const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 10_000) : 200;
    const at = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
    const rows = (status
      ? this.db.prepare("SELECT meta FROM threads WHERE status = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(status, at, n)
      : this.db.prepare("SELECT meta FROM threads WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(at, n)) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Clarification/assignment sub-Threads of one Thread, newest first (v4-13, #112). */
  listThreadsByParent(parentThreadId: string, limit = 200): ThreadMeta[] {
    const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 10_000) : 200;
    const rows = this.db.prepare("SELECT meta FROM threads WHERE parent_thread_id = ? ORDER BY created_at DESC LIMIT ?").all(parentThreadId, n) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Children of one exact parent Order, newest first; limit+1 lets callers detect truncation. */
  listThreadsByParentOrder(parentThreadId: string, parentOrderId: string, limit = 10_001): ThreadMeta[] {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10_001) : 10_001;
    const rows = this.db.prepare("SELECT meta FROM threads WHERE parent_thread_id = ? AND parent_order_id = ? ORDER BY created_at DESC LIMIT ?").all(parentThreadId, parentOrderId, n) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Newest first, restricted to one channel (v4-11). */
  listThreadsIn(channel: string, limit = 200, status?: string, before = Number.MAX_SAFE_INTEGER): ThreadMeta[] {
    const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 10_000) : 200;
    const at = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
    const rows = (status
      ? this.db.prepare("SELECT meta FROM threads WHERE channel = ? AND status = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(channel, status, at, n)
      : this.db.prepare("SELECT meta FROM threads WHERE channel = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(channel, at, n)) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /**
   * One channel's Threads by last activity, newest first (v4-12). `after`/`before` are activity
   * cursors (exclusive). This is the observer/digest view: a reply on an old Thread belongs here
   * even when the Thread is far outside the newest-created window.
   */
  listThreadsInByActivity(channel: string, opts: { after?: number; before?: number; cursor?: { at: number; threadId: string }; limit?: number } = {}): ThreadMeta[] {
    const n = Number.isInteger(opts.limit) && (opts.limit ?? 0) > 0 ? Math.min(opts.limit!, 10_000) : 200;
    const after = Number.isFinite(opts.after) && (opts.after ?? 0) > 0 ? opts.after! : 0;
    const before = Number.isFinite(opts.before) ? opts.before! : Number.MAX_SAFE_INTEGER;
    const args = opts.cursor ? [opts.cursor.at, opts.cursor.threadId] : [];
    const cursorFilter = opts.cursor ? " AND (last_activity, thread_id) < (?, ?)" : "";
    const rows = this.db
      .prepare(`SELECT meta FROM threads WHERE channel = ? AND last_activity > ? AND last_activity < ?${cursorFilter} ORDER BY last_activity DESC, thread_id DESC LIMIT ?`)
      .all(channel, after, before, ...args, n) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Per-channel counts for /api/channels (v4-11). */
  channelStats(): { channel: string; threads: number; lastActivityAt: number }[] {
    const rows = this.db.prepare("SELECT COALESCE(channel, 'default') AS channel, COUNT(*) AS n, MAX(COALESCE(last_activity, created_at)) AS at FROM threads GROUP BY COALESCE(channel, 'default')").all() as {
      channel: string;
      n: number;
      at: number;
    }[];
    return rows.map((r) => ({ channel: r.channel, threads: r.n, lastActivityAt: r.at }));
  }

  /** Finished threads whose last activity is before `cutoff` (candidates for pruning). */
  /** Rows whose last activity is older than the cutoff and that already finished (#34: push both filters to SQL). */
  staleThreads(cutoff: number, statuses: ThreadMeta["status"][] = ["done", "failed", "cancelled"]): ThreadMeta[] {
    if (!statuses.length) return [];
    const rows = this.db
      .prepare(`SELECT meta FROM threads WHERE created_at < ? AND status IN (${statuses.map(() => "?").join(", ")})`)
      .all(cutoff, ...statuses) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta)).filter((m) => (m.lastActivityAt ?? m.createdAt) < cutoff);
  }

  /** Delete thread rows and their JSONL files; empty day directories go too. Returns bytes freed. */
  deleteThreads(metas: ThreadMeta[]): number {
    let bytes = 0;
    const dirs = new Set<string>();
    const del = this.db.prepare("DELETE FROM threads WHERE thread_id = ?");
    // One transaction for the row deletes (#34); the files go afterwards, outside the transaction.
    this.db.exec("BEGIN");
    try {
      for (const m of metas) {
        del.run(m.threadId);
        // Never touch files outside this home's sessions/ directory, whatever the metadata says.
        const sessions = resolve(this.home, "sessions") + sep;
        if (resolve(m.file).startsWith(sessions) && existsSync(m.file)) {
          bytes += statSync(m.file).size;
          rmSync(m.file, { force: true });
          dirs.add(dirname(m.file));
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    for (const d of dirs) {
      try {
        if (readdirSync(d).length === 0) rmdirSync(d);
      } catch {
        // already gone or not empty
      }
    }
    return bytes;
  }

  /** External session (Codex thread / Claude session) used by a bridged Barista in `cwd` for a cafe Thread. */
  getAgentSession(kind: string, cwd: string, threadId: string): string | undefined {
    const row = this.db.prepare("SELECT session_id FROM agent_sessions WHERE kind = ? AND cwd = ? AND thread_id = ?").get(kind, cwd, threadId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  setAgentSession(kind: string, cwd: string, threadId: string, sessionId: string): void {
    this.db
      .prepare("INSERT INTO agent_sessions(kind, cwd, thread_id, session_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, cwd, thread_id) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at")
      .run(kind, cwd, threadId, sessionId, Date.now());
  }

  /** Forget the session mappings of these Threads (pruning). Only cafe's mapping goes; the Codex / Claude history stays. */
  deleteAgentSessions(threadIds: string[]): void {
    const del = this.db.prepare("DELETE FROM agent_sessions WHERE thread_id = ?");
    for (const id of threadIds) del.run(id);
  }

  putArtifact(a: StoredArtifact): void {
    this.db
      .prepare("INSERT INTO artifacts(id, thread_id, host, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id, host=excluded.host, name=excluded.name, mime=excluded.mime, size=excluded.size, sha256=excluded.sha256, created_at=excluded.created_at")
      .run(a.id, a.threadId ?? null, a.host, a.name, a.mime, a.size, a.sha256, a.createdAt);
  }

  getArtifact(id: string): StoredArtifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | { id: string; thread_id: string | null; host: string; name: string; mime: string; size: number; sha256: string; created_at: number }
      | undefined;
    return row ? { id: row.id, ...(row.thread_id ? { threadId: row.thread_id } : {}), host: row.host, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at } : undefined;
  }

  artifactsForThread(threadId: string): StoredArtifact[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE thread_id = ? ORDER BY created_at").all(threadId) as {
      id: string;
      thread_id: string | null;
      host: string;
      name: string;
      mime: string;
      size: number;
      sha256: string;
      created_at: number;
    }[];
    return rows.map((row) => ({ id: row.id, ...(row.thread_id ? { threadId: row.thread_id } : {}), host: row.host, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at }));
  }

  /** Uploads that never became part of an Order, older than `cutoff` (orphan staging cleanup). */
  stagedArtifacts(cutoff: number): StoredArtifact[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE thread_id IS NULL AND created_at < ?").all(cutoff) as {
      id: string;
      thread_id: string | null;
      host: string;
      name: string;
      mime: string;
      size: number;
      sha256: string;
      created_at: number;
    }[];
    return rows.map((row) => ({ id: row.id, host: row.host, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at }));
  }

  deleteStagedArtifacts(cutoff: number): number {
    return Number(this.db.prepare("DELETE FROM artifacts WHERE thread_id IS NULL AND created_at < ?").run(cutoff).changes);
  }

  deleteArtifactsForThread(threadId: string): StoredArtifact[] {
    const rows = this.artifactsForThread(threadId);
    this.db.prepare("DELETE FROM artifacts WHERE thread_id = ?").run(threadId);
    return rows;
  }

  countAgentEventsBefore(cutoff: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE at < ?").get(cutoff) as { n: number }).n;
  }

  deleteAgentEventsBefore(cutoff: number): number {
    return Number(this.db.prepare("DELETE FROM agent_events WHERE at < ?").run(cutoff).changes);
  }

  /** Every thread, newest first (for full-text search over the JSONL files). */
  allThreads(): ThreadMeta[] {
    return (this.db.prepare("SELECT meta FROM threads ORDER BY created_at DESC").all() as { meta: string }[]).map((r) => threadMeta(r.meta));
  }

  /**
   * `full`: replace (startup, registry snapshot). Otherwise the delta path: only rows whose
   * record changed are rewritten, and a version bump alone costs no row write (#34).
   */
  saveRegistry(version: number, records: AgentRecord[], opts: { full?: boolean } = {}): void {
    const existing = new Map<string, string>();
    for (const row of this.db.prepare("SELECT agent_id, record FROM registry").all() as { agent_id: string; record: string }[]) existing.set(row.agent_id, row.record);
    const keep = new Set(records.map((r) => r.agentId));
    const changed: Array<{ agentId: string; json: string }> = [];
    for (const r of records) {
      const json = JSON.stringify(r);
      if (opts.full || existing.get(r.agentId) !== json) changed.push({ agentId: r.agentId, json });
    }
    const removed = [...existing.keys()].filter((id) => !keep.has(id));
    // A version bump with no row changes (the common status-toggle case) skips the row writes (#34).
    this.db.exec("BEGIN");
    try {
      if (removed.length) {
        const del = this.db.prepare("DELETE FROM registry WHERE agent_id = ?");
        for (const id of removed) del.run(id);
      }
      if (changed.length) {
        const ins = this.db.prepare("INSERT INTO registry(agent_id, record) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET record=excluded.record");
        for (const c of changed) ins.run(c.agentId, c.json);
      }
      this.db.prepare("INSERT INTO kv(key, value) VALUES ('registryVersion', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(version));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  loadRegistry(): { version: number; records: AgentRecord[] } {
    const v = this.db.prepare("SELECT value FROM kv WHERE key='registryVersion'").get() as { value: string } | undefined;
    const rows = this.db.prepare("SELECT record FROM registry").all() as { record: string }[];
    return { version: v ? Number(v.value) : 0, records: rows.map((r) => JSON.parse(r.record) as AgentRecord) };
  }

  getKv<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  setKv(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }

  /** One outcome per Agent per Order (answered / declined / failed), for per-agent stats. */
  recordAgentEvent(
    agentId: string,
    kind: "answered" | "declined" | "failed",
    at: number,
    threadId: string,
    extra: { identity?: string; tokens?: string[] } = {},
  ): void {
    this.db
      .prepare("INSERT INTO agent_events(agent_id, kind, at, thread_id, identity, tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agentId, kind, at, threadId, extra.identity ?? null, extra.tokens?.length ? extra.tokens.join(" ") : null);
  }

  /** Outcomes since `since`, for routing hints. `identity` is null on rows written before v2. */
  outcomes(since: number): { agentId: string; identity: string | null; kind: "answered" | "declined" | "failed"; at: number; tokens: string[] }[] {
    const rows = this.db
      .prepare("SELECT agent_id, identity, kind, at, tokens FROM agent_events WHERE at >= ?")
      .all(since) as { agent_id: string; identity: string | null; kind: string; at: number; tokens: string | null }[];
    return rows
      .filter((r) => r.kind === "answered" || r.kind === "declined" || r.kind === "failed")
      .map((r) => ({ agentId: r.agent_id, identity: r.identity, kind: r.kind as "answered", at: r.at, tokens: r.tokens ? r.tokens.split(" ") : [] }));
  }

  /**
   * Grouped outcome counts for routing hints (#68). The old `outcomes()` pulled every row of the last
   * seven days into JS (200k rows ≈ 258 ms of blocked event loop every 30 s). Counts are aggregated in
   * SQL; only the most recent decline rows are read back for their topic keywords, bounded per identity.
   */
  outcomeSummary(
    since: number,
    opts: { declineTopicRows?: number } = {},
  ): { identity: string; answered: number; declined: number; failed: number; declinedTopics?: string[]; declinedAt?: number }[] {
    const declineRows = Math.max(1, opts.declineTopicRows ?? 20);
    const rows = this.db
      .prepare(
        `SELECT identity,
                SUM(kind = 'answered') AS answered,
                SUM(kind = 'declined') AS declined,
                SUM(kind = 'failed')   AS failed,
                MAX(CASE WHEN kind = 'declined' THEN at END) AS declined_at
           FROM agent_events
          WHERE at >= ? AND identity IS NOT NULL AND kind IN ('answered','declined','failed')
          GROUP BY identity`,
      )
      .all(since) as { identity: string; answered: number; declined: number; failed: number; declined_at: number | null }[];
    const topics = this.db.prepare(
      `SELECT tokens FROM agent_events
        WHERE identity = ? AND kind = 'declined' AND at >= ? AND tokens IS NOT NULL
        ORDER BY at DESC LIMIT ?`,
    );
    return rows.map((r) => {
      const out: { identity: string; answered: number; declined: number; failed: number; declinedTopics?: string[]; declinedAt?: number } = {
        identity: r.identity,
        answered: r.answered,
        declined: r.declined,
        failed: r.failed,
      };
      if (r.declined_at !== null) out.declinedAt = r.declined_at;
      if (r.declined > 0) {
        const toks = new Set<string>();
        for (const row of topics.all(r.identity, since, declineRows) as { tokens: string }[]) {
          for (const t of row.tokens.split(" ")) if (t) toks.add(t);
        }
        out.declinedTopics = [...toks];
      }
      return out;
    });
  }

  agentStats(since: number): Record<string, { answered: number; declined: number; failed: number; lastAnsweredAt?: number }> {
    const rows = this.db
      .prepare("SELECT agent_id, kind, COUNT(*) AS n, MAX(at) AS last FROM agent_events WHERE at >= ? GROUP BY agent_id, kind")
      .all(since) as { agent_id: string; kind: string; n: number; last: number }[];
    const out: Record<string, { answered: number; declined: number; failed: number; lastAnsweredAt?: number }> = {};
    for (const r of rows) {
      const s = (out[r.agent_id] ??= { answered: 0, declined: 0, failed: 0 });
      if (r.kind === "answered" || r.kind === "declined" || r.kind === "failed") s[r.kind] = r.n;
      if (r.kind === "answered") s.lastAnsweredAt = r.last;
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
