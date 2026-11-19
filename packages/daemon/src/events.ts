import type { ThreadEnvelope } from "@cafe/protocol";

/** Filters for the global event stream (`GET /api/events`, `cafe tail`). */
export interface EventFilter {
  /** Origin host (`env.host`), not the host that relayed it. */
  host?: string;
  /** Event types to include; undefined = all. */
  types?: string[];
  thread?: string;
  /** Heartbeats are hidden unless explicitly requested. */
  includeHeartbeat?: boolean;
}

/** Events in the ring that came after `lastId`; empty when the id is unknown (too old). */
export function replayAfter(recent: ThreadEnvelope[], lastId?: string): ThreadEnvelope[] {
  if (!lastId) return [];
  const at = recent.findIndex((e) => e.eventId === lastId);
  return at >= 0 ? recent.slice(at + 1) : [];
}

export function parseEventFilter(url: URL): EventFilter {
  const types = (url.searchParams.get("type") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const verbose = url.searchParams.get("verbose") === "1" || url.searchParams.get("heartbeat") === "1";
  return {
    ...(url.searchParams.get("host") ? { host: url.searchParams.get("host")! } : {}),
    ...(types.length ? { types } : {}),
    ...(url.searchParams.get("thread") ? { thread: url.searchParams.get("thread")! } : {}),
    includeHeartbeat: verbose,
  };
}

export function eventMatches(env: ThreadEnvelope, filter: EventFilter): boolean {
  if (!filter.includeHeartbeat && env.event.type === "order.heartbeat") return false;
  if (filter.host && env.host !== filter.host) return false;
  if (filter.thread && env.threadId !== filter.thread) return false;
  if (filter.types && !filter.types.includes(env.event.type)) return false;
  return true;
}