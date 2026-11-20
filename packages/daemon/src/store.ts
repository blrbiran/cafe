import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";

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
        meta TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_created ON threads(created_at DESC);
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
    `);
    // v2: identity (`name@host`, survives restarts) and the Order's keywords, for routing hints.
    const cols = new Set((this.db.prepare("PRAGMA table_info(agent_events)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("identity")) this.db.exec("ALTER TABLE agent_events ADD COLUMN identity TEXT");
    if (!cols.has("tokens")) this.db.exec("ALTER TABLE agent_events ADD COLUMN tokens TEXT");
  }

  threadFile(threadId: string, createdAt: number): string {
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const dir = join(this.home, "sessions", day);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${threadId}.jsonl`);
  }

  appendEvent(file: string, env: ThreadEnvelope): void {
    appendFileSync(file, `${JSON.stringify(env)}\n`);
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

  /** The last `limit` events, read from the end so a long Thread is not parsed whole. */
  readEventsTail(file: string, limit: number): ThreadEnvelope[] {
    return this.readEventsPage(file, limit).events;
  }

  /**
   * A page of events read backwards from the end: the newest `limit` events, or
   * those strictly before `before` (an eventId). The cost is proportional to the
   * bytes scanned, not to the Thread length, and `hasMore` tells the client
   * whether older events remain (#31).
   */
  readEventsPage(file: string, limit: number, before?: string): { events: ThreadEnvelope[]; hasMore: boolean } {
    if (!existsSync(file) || limit <= 0) return { events: [], hasMore: false };
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const chunk = 64 * 1024;
      let pos = size;
      // The first line of a backwards chunk can be cut in half; carry it into
      // the next (earlier) read.
      let carry = "";
      let skipping = !!before;
      const newestFirst: ThreadEnvelope[] = [];
      let hasMore = false;
      const take = (line: string): boolean => {
        if (!line) return false;
        let env: ThreadEnvelope;
        try {
          env = JSON.parse(line) as ThreadEnvelope;
        } catch {
          return false;
        }
        if (skipping) {
          if (env.eventId === before) skipping = false;
          return false;
        }
        newestFirst.push(env);
        if (newestFirst.length > limit) {
          hasMore = true;
          return true;
        }
        return false;
      };
      while (pos > 0) {
        const len = Math.min(chunk, pos);
        pos -= len;
        const b = Buffer.allocUnsafe(len);
        readSync(fd, b, 0, len, pos);
        const lines = (b.toString("utf8") + carry).split("\n");
        // With bytes before this chunk, its first line is incomplete.
        carry = pos > 0 ? (lines.shift() ?? "") : "";
        for (let i = lines.length - 1; i >= 0; i--) if (take(lines[i]!)) break;
        if (hasMore) break;
      }
      if (!hasMore && carry) take(carry);
      if (newestFirst.length > limit) {
        newestFirst.length = limit;
        hasMore = true;
      }
      return { events: newestFirst.reverse(), hasMore };
    } finally {
      closeSync(fd);
    }
  }


  /** Unfinished threads (recovery after a restart). Finished ones are never read back. */
  openThreads(limit = 1000): ThreadMeta[] {
    const rows = this.db.prepare("SELECT meta FROM threads WHERE status NOT IN ('done','failed','cancelled') ORDER BY created_at DESC LIMIT ?").all(limit) as { meta: string }[];
    return rows.map((r) => JSON.parse(r.meta) as ThreadMeta);
  }

  putThread(meta: ThreadMeta): void {
    this.db
      .prepare("INSERT INTO threads(thread_id, created_at, status, meta) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET status=excluded.status, meta=excluded.meta")
      .run(meta.threadId, meta.createdAt, meta.status, JSON.stringify(meta));
  }

  getThread(threadId: string): ThreadMeta | undefined {
    const row = this.db.prepare("SELECT meta FROM threads WHERE thread_id = ?").get(threadId) as { meta: string } | undefined;
    return row ? (JSON.parse(row.meta) as ThreadMeta) : undefined;
  }

  /** Newest first. `before`: only threads created before this time (paging to older threads). */
  listThreads(limit = 200, status?: string, before = Number.MAX_SAFE_INTEGER): ThreadMeta[] {
    // Defensive: SQLite reads LIMIT -1 as "all rows", and NaN binds as a datatype error.
    const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 10_000) : 200;
    const at = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
    const rows = (status
      ? this.db.prepare("SELECT meta FROM threads WHERE status = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(status, at, n)
      : this.db.prepare("SELECT meta FROM threads WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(at, n)) as { meta: string }[];
    return rows.map((r) => JSON.parse(r.meta) as ThreadMeta);
  }

  /** Finished threads whose last activity is before `cutoff` (candidates for pruning). */
  staleThreads(cutoff: number): ThreadMeta[] {
    const rows = this.db.prepare("SELECT meta FROM threads WHERE created_at < ?").all(cutoff) as { meta: string }[];
    return rows
      .map((r) => JSON.parse(r.meta) as ThreadMeta)
      .filter((m) => (m.lastActivityAt ?? m.createdAt) < cutoff && ["done", "failed", "cancelled"].includes(m.status));
  }

  /** Delete thread rows and their JSONL files; empty day directories go too. Returns bytes freed. */
  deleteThreads(metas: ThreadMeta[]): number {
    let bytes = 0;
    const dirs = new Set<string>();
    const del = this.db.prepare("DELETE FROM threads WHERE thread_id = ?");
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
    return (this.db.prepare("SELECT meta FROM threads ORDER BY created_at DESC").all() as { meta: string }[]).map((r) => JSON.parse(r.meta) as ThreadMeta);
  }

  saveRegistry(version: number, records: AgentRecord[]): void {
    this.db.exec("BEGIN");
    try {
      const keep = new Set(records.map((r) => r.agentId));
      const existing = (this.db.prepare("SELECT agent_id FROM registry").all() as { agent_id: string }[]).map((r) => r.agent_id);
      const del = this.db.prepare("DELETE FROM registry WHERE agent_id = ?");
      for (const id of existing) if (!keep.has(id)) del.run(id);
      const ins = this.db.prepare("INSERT INTO registry(agent_id, record) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET record=excluded.record");
      for (const r of records) ins.run(r.agentId, JSON.stringify(r));
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
