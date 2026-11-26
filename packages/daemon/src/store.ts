import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CHANNEL, type AgentRecord, type ThreadEnvelope, type ThreadMeta } from "@cafe/protocol";

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
      -- Full-text index over the searchable text of each Order/reply (#34). Trigram tokenizer =
      -- case-insensitive substring match (cafe search is substring, not word, matching); a query
      -- shorter than 3 characters falls back to the JSONL scan.
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(event_id UNINDEXED, thread_id UNINDEXED, order_id UNINDEXED, who UNINDEXED, at UNINDEXED, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS search_indexed (event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
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
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_channel_created ON threads(channel, created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_channel_activity ON threads(channel, last_activity DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_parent ON threads(parent_thread_id, created_at DESC)");
    this.upsertIndexRows = this.prepareIndexRows();
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

  /** The last `limit` events, read from the end so a long Thread is not parsed whole. */
  readEventsTail(file: string, limit: number): ThreadEnvelope[] {
    return this.readEventsPage(file, limit).events;
  }

  // ---------------------------------------------------------------------------
  // Search index (#34)
  // ---------------------------------------------------------------------------

  /** The searchable text of an event: the question (as ordered) or a Barista reply; undefined otherwise. */
  private static searchable(env: ThreadEnvelope, who: (agentId: string) => string): { who: string; text: string } | undefined {
    const ev = env.event;
    if (ev.type === "order.created") return { who: ev.order.from.address, text: ev.order.body };
    if (ev.type === "order.replied") return { who: who(ev.agentId), text: ev.text };
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

  /** Threads with at least one event not yet in the search index, newest first (backfill after an upgrade). */
  threadsNeedingIndex(limit: number): ThreadMeta[] {
    const rows = this.db
      .prepare("SELECT meta FROM threads WHERE thread_id NOT IN (SELECT DISTINCT thread_id FROM search_indexed) ORDER BY created_at DESC LIMIT ?")
      .all(limit) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
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
    let found = false;
    this.scanBackward(file, (env) => {
      if (env.orderId !== orderId) return false;
      newestFirst.push(env);
      return (found = env.event.type === "order.created");
    });
    return found ? newestFirst.reverse() : [];
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

  /** Upsert one Thread's metadata; returns the serialized bytes (for /api/health counters). */
  putThread(meta: ThreadMeta): number {
    const json = JSON.stringify(meta);
    this.db
      .prepare("INSERT INTO threads(thread_id, created_at, status, channel, last_activity, parent_thread_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET status=excluded.status, channel=excluded.channel, last_activity=excluded.last_activity, parent_thread_id=excluded.parent_thread_id, meta=excluded.meta")
      .run(meta.threadId, meta.createdAt, meta.status, meta.channel ?? "default", meta.lastActivityAt ?? meta.createdAt, meta.parentThreadId ?? null, json);
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
  listThreadsInByActivity(channel: string, opts: { after?: number; before?: number; limit?: number } = {}): ThreadMeta[] {
    const n = Number.isInteger(opts.limit) && (opts.limit ?? 0) > 0 ? Math.min(opts.limit!, 10_000) : 200;
    const after = Number.isFinite(opts.after) && (opts.after ?? 0) > 0 ? opts.after! : 0;
    const before = Number.isFinite(opts.before) ? opts.before! : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare("SELECT meta FROM threads WHERE channel = ? AND last_activity > ? AND last_activity < ? ORDER BY last_activity DESC, thread_id DESC LIMIT ?")
      .all(channel, after, before, n) as { meta: string }[];
    return rows.map((r) => threadMeta(r.meta));
  }

  /** Per-channel counts for /api/channels (v4-11). */
  channelStats(): { channel: string; threads: number; lastActivityAt: number }[] {
    const rows = this.db.prepare("SELECT COALESCE(channel, 'default') AS channel, COUNT(*) AS n, MAX(created_at) AS at FROM threads GROUP BY COALESCE(channel, 'default')").all() as {
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
