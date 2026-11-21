import { describe, expect, it } from "vitest";
import type { ThreadMeta } from "@cafe/protocol";
import { routingStats, formatRoutingStats } from "../packages/daemon/src/routing-stats.ts";

const meta = (over: Partial<ThreadMeta>): ThreadMeta => ({
  threadId: "t",
  orderId: "o",
  kind: "order",
  from: { id: "you", address: "you@here", host: "here" },
  targets: [],
  status: "done",
  summary: "q",
  summaryTurn: 1,
  createdAt: 1_000,
  file: "/tmp/t.jsonl",
  turns: 1,
  replies: [],
  declines: [],
  ...over,
});

describe("routingStats", () => {
  it("summarises modes, fan-out and the time to first reply / close", () => {
    const s = routingStats([
      meta({ threadId: "a", mode: "unicast", targets: ["x"], firstReplyAt: 2_000, closedAt: 3_000 }),
      meta({ threadId: "b", mode: "multicast", targets: ["x", "y"], firstReplyAt: 1_500, closedAt: 4_000 }),
      meta({ threadId: "c", mode: "broadcast", targets: ["x", "y", "z"], status: "working" }),
      meta({ threadId: "d" }), // older Thread with no mode
    ]);
    expect(s).toMatchObject({ threads: 4, unicast: 1, multicast: 1, broadcast: 1, unknownMode: 1, open: 1 });
    expect(s.avgFanout).toBe(1.5); // (1 + 2 + 3 + 0) / 4
    expect(s.avgFirstReplyMs).toBe(750); // (1000 + 500) / 2
    expect(s.avgCloseMs).toBe(2500); // (2000 + 3000) / 2
  });

  it("returns zeroed averages for an empty list", () => {
    const s = routingStats([]);
    expect(s).toMatchObject({ threads: 0, avgFanout: 0, open: 0 });
    expect(s.avgFirstReplyMs).toBeUndefined();
    expect(s.avgCloseMs).toBeUndefined();
  });

  it("formats one line for cafe stats", () => {
    const line = formatRoutingStats(
      routingStats([meta({ threadId: "a", mode: "unicast", targets: ["x"], firstReplyAt: 2_000, closedAt: 3_500 }), meta({ threadId: "b", mode: "multicast", targets: ["x", "y"] })]),
    );
    expect(line).toContain("routing (recent 2 threads)");
    expect(line).toContain("unicast 1");
    expect(line).toContain("avg fanout 1.5");
    expect(line).toContain("first reply 1.0s");
  });
});