import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Write JSON through a temp file + rename so a crash never leaves a half-written state file. */
export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** platformThreadId (channel / chat id) → cafe Thread id. Persisted across restarts. */
export class ThreadMap {
  private path: string;
  private map: Record<string, string>;

  constructor(stateDir: string) {
    this.path = join(stateDir, "threads.json");
    const raw = readJsonFile<Record<string, unknown>>(this.path, {});
    this.map = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === "string" && value) this.map[key] = value;
  }

  get(platformThreadId: string): string | undefined {
    return this.map[platformThreadId];
  }

  set(platformThreadId: string, threadId: string): void {
    if (this.map[platformThreadId] === threadId) return;
    this.map[platformThreadId] = threadId;
    this.save();
  }

  /** Forget the mapping so the next message on this platform thread starts a new cafe Thread. */
  delete(platformThreadId: string): void {
    if (!(platformThreadId in this.map)) return;
    delete this.map[platformThreadId];
    this.save();
  }

  all(): Record<string, string> {
    return { ...this.map };
  }

  private save(): void {
    atomicWriteJson(this.path, this.map);
  }
}

export interface SeenEventRecord {
  id: string;
  at: number;
}

export interface SeenEventsOptions {
  /** How long an event id is remembered. Default: 7 days. */
  maxAgeMs?: number;
  /** Upper bound (oldest are dropped first). Default: 2000. */
  max?: number;
}

/** Event ids already handled, with a time window and a hard cap. */
export class SeenEvents {
  private path: string;
  private events: SeenEventRecord[];
  private maxAgeMs: number;
  private max: number;

  constructor(stateDir: string, opts: SeenEventsOptions = {}) {
    this.path = join(stateDir, "seen-events.json");
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600_000;
    this.max = opts.max ?? 2000;
    const raw = readJsonFile<{ events?: unknown }>(this.path, {});
    const list = Array.isArray(raw.events) ? raw.events : [];
    this.events = list
      .filter((e): e is SeenEventRecord => !!e && typeof (e as SeenEventRecord).id === "string" && typeof (e as SeenEventRecord).at === "number")
      .sort((a, b) => a.at - b.at);
    this.prune();
  }

  has(id: string, now = Date.now()): boolean {
    this.prune(now);
    return this.events.some((e) => e.id === id);
  }

  add(id: string, at = Date.now()): void {
    if (this.events.some((e) => e.id === id)) return;
    this.events.push({ id, at });
    this.prune(at);
    atomicWriteJson(this.path, { events: this.events });
  }

  get size(): number {
    return this.events.length;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.maxAgeMs;
    this.events = this.events.filter((e) => e.at > cutoff);
    if (this.events.length > this.max) this.events = this.events.slice(-this.max);
  }
}

export type OutboxStatus = "pending" | "sent" | "failed";

/** One platform event on its way to cafe (and its final replies on the way back). */
export interface OutboxItem {
  eventId: string;
  channel: string;
  user: string;
  text: string;
  status: OutboxStatus;
  at: number;
  updatedAt: number;
  threadId?: string;
  orderId?: string;
  /** The final reply has been written to stdout; a crash after this is safe to skip. */
  delivered?: boolean;
  error?: string;
}

export interface OutboxOptions {
  /** Keep at most this many finished items. Default: 500. */
  max?: number;
  /** Drop finished items older than this. Default: 7 days. */
  maxAgeMs?: number;
}

/**
 * Pending / sent events. Sending uses the event id as the Daemon idempotency key,
 * so a retry after a crash cannot create a second Thread.
 */
export class Outbox {
  private path: string;
  private items: OutboxItem[];
  private max: number;
  private maxAgeMs: number;

  constructor(stateDir: string, opts: OutboxOptions = {}) {
    this.path = join(stateDir, "outbox.json");
    this.max = opts.max ?? 500;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600_000;
    const raw = readJsonFile<{ items?: unknown }>(this.path, {});
    const list = Array.isArray(raw.items) ? raw.items : [];
    this.items = list.filter((i): i is OutboxItem => !!i && typeof (i as OutboxItem).eventId === "string" && typeof (i as OutboxItem).channel === "string");
    this.prune();
  }

  get(eventId: string): OutboxItem | undefined {
    return this.items.find((i) => i.eventId === eventId);
  }

  add(item: Omit<OutboxItem, "at" | "updatedAt"> & Partial<Pick<OutboxItem, "at" | "updatedAt">>): OutboxItem {
    const now = Date.now();
    const record: OutboxItem = { at: now, updatedAt: now, ...item };
    const at = this.items.findIndex((i) => i.eventId === item.eventId);
    if (at >= 0) this.items[at] = record;
    else this.items.push(record);
    this.save();
    return record;
  }

  pending(): OutboxItem[] {
    return this.items.filter((i) => i.status === "pending" || i.status === "failed");
  }

  /** Sent, but the final reply was not written before the process stopped. */
  undelivered(): OutboxItem[] {
    return this.items.filter((i) => i.status === "sent" && !i.delivered && i.threadId && i.orderId);
  }

  markSent(eventId: string, threadId: string, orderId: string): OutboxItem | undefined {
    return this.update(eventId, { status: "sent", threadId, orderId, error: undefined });
  }

  markDelivered(eventId: string): OutboxItem | undefined {
    return this.update(eventId, { delivered: true });
  }

  markFailed(eventId: string, error: string): OutboxItem | undefined {
    return this.update(eventId, { status: "failed", error });
  }

  private update(eventId: string, patch: Partial<OutboxItem>): OutboxItem | undefined {
    const item = this.get(eventId);
    if (!item) return undefined;
    Object.assign(item, patch, { updatedAt: Date.now() });
    this.save();
    return item;
  }

  private save(): void {
    this.prune();
    atomicWriteJson(this.path, { items: this.items });
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.maxAgeMs;
    // Keep unfinished work regardless of age; finished items are the ones we bound.
    this.items = this.items.filter((i) => i.status !== "sent" || !i.delivered || i.updatedAt > cutoff);
    const finished = this.items.filter((i) => i.status === "sent" && i.delivered);
    if (finished.length > this.max) {
      const drop = new Set(finished.slice(0, finished.length - this.max).map((i) => i.eventId));
      this.items = this.items.filter((i) => !drop.has(i.eventId));
    }
  }
}

/** Every state file the SDK keeps under CAFE_CONNECTOR_STATE. */
export interface ConnectorState {
  threads: ThreadMap;
  seen: SeenEvents;
  outbox: Outbox;
}

export function openState(stateDir: string): ConnectorState {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  return { threads: new ThreadMap(stateDir), seen: new SeenEvents(stateDir), outbox: new Outbox(stateDir) };
}