/**
 * Keep only the last `max` items. Thread metadata carries reply/decline
 * summaries for list views; the full history is the JSONL event log, so the
 * in-memory copy is bounded instead of growing (and being re-serialised) with
 * every event (#31).
 */
export function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}