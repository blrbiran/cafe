import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
    `);
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

  listThreads(limit = 200, status?: string): ThreadMeta[] {
    const rows = (status
      ? this.db.prepare("SELECT meta FROM threads WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT meta FROM threads ORDER BY created_at DESC LIMIT ?").all(limit)) as { meta: string }[];
    return rows.map((r) => JSON.parse(r.meta) as ThreadMeta);
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

  /** One outcome per Agent per Order (answered / declined / failed), for per-agent stats. */
  recordAgentEvent(agentId: string, kind: "answered" | "declined" | "failed", at: number, threadId: string): void {
    this.db.prepare("INSERT INTO agent_events(agent_id, kind, at, thread_id) VALUES (?, ?, ?, ?)").run(agentId, kind, at, threadId);
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
