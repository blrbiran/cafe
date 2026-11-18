import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";

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
    const rows = (status
      ? this.db.prepare("SELECT meta FROM threads WHERE status = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(status, before, limit)
      : this.db.prepare("SELECT meta FROM threads WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit)) as { meta: string }[];
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
      this.db.exec("DELETE FROM registry");
      const ins = this.db.prepare("INSERT INTO registry(agent_id, record) VALUES (?, ?)");
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
