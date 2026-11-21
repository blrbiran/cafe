import type { ThreadMeta } from "@cafe/protocol";

/** Recent routing mix and timings, computed from Thread metadata (no JSONL scan). */
export interface RoutingStats {
  threads: number;
  unicast: number;
  multicast: number;
  broadcast: number;
  /** Threads from before `mode` was recorded on the meta. */
  unknownMode: number;
  /** Average number of targets per Order (fan-out). */
  avgFanout: number;
  avgFirstReplyMs?: number;
  avgCloseMs?: number;
  /** Threads not finished yet. */
  open: number;
}

const CLOSED = new Set(["done", "failed", "cancelled"]);
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

export function routingStats(threads: ThreadMeta[]): RoutingStats {
  let unicast = 0;
  let multicast = 0;
  let broadcast = 0;
  let unknownMode = 0;
  let open = 0;
  let fanout = 0;
  let firstTotal = 0;
  let firstN = 0;
  let closeTotal = 0;
  let closeN = 0;
  for (const m of threads) {
    if (m.mode === "unicast") unicast++;
    else if (m.mode === "multicast") multicast++;
    else if (m.mode === "broadcast") broadcast++;
    else unknownMode++;
    fanout += m.targets.length;
    if (!CLOSED.has(m.status)) open++;
    if (m.firstReplyAt !== undefined && m.firstReplyAt >= m.createdAt) {
      firstTotal += m.firstReplyAt - m.createdAt;
      firstN++;
    }
    if (m.closedAt !== undefined && m.closedAt >= m.createdAt) {
      closeTotal += m.closedAt - m.createdAt;
      closeN++;
    }
  }
  return {
    threads: threads.length,
    unicast,
    multicast,
    broadcast,
    unknownMode,
    open,
    avgFanout: threads.length ? oneDecimal(fanout / threads.length) : 0,
    ...(firstN ? { avgFirstReplyMs: Math.round(firstTotal / firstN) } : {}),
    ...(closeN ? { avgCloseMs: Math.round(closeTotal / closeN) } : {}),
  };
}

const seconds = (ms: number) => (ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`);

/** One human-readable line for `cafe stats`. */
export function formatRoutingStats(s: RoutingStats): string {
  if (!s.threads) return "routing: no threads yet";
  const parts = [`unicast ${s.unicast}`, `multicast ${s.multicast}`, `broadcast ${s.broadcast}`];
  if (s.unknownMode) parts.push(`older ${s.unknownMode}`);
  parts.push(`avg fanout ${s.avgFanout}`);
  if (s.avgFirstReplyMs !== undefined) parts.push(`first reply ${seconds(s.avgFirstReplyMs)}`);
  if (s.avgCloseMs !== undefined) parts.push(`close ${seconds(s.avgCloseMs)}`);
  if (s.open) parts.push(`${s.open} open`);
  return `routing (recent ${s.threads} threads): ${parts.join(" · ")}`;
}