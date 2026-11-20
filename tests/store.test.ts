import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import { Store } from "../packages/daemon/src/store.ts";

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "cafe-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const env = (i: number): ThreadEnvelope => ({ eventId: `E${i}`, threadId: "T", orderId: "O", host: "h", at: i, event: { type: "order.heartbeat", agentId: "A" } });

describe("Store", () => {
  it("reads only the tail of a long event file", () => {
    const home = temp();
    const store = new Store(home);
    const file = join(home, "sessions", "tail.jsonl");
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify(env(i))).join("\n") + "\n";
    writeFileSync(file, lines);
    const tail = store.readEventsTail(file, 12);
    expect(tail).toHaveLength(12);
    expect(tail.at(0)?.eventId).toBe("E488");
    expect(tail.at(-1)?.eventId).toBe("E499");
  });

  it("pages backwards from the end, before an event id, across read chunks", () => {
    const home = temp();
    const store = new Store(home);
    const file = join(home, "sessions", "page.jsonl");
    // Pad each line so the file spans several 64 KiB read chunks.
    const big = (i: number) => JSON.stringify({ ...env(i), event: { type: "order.heartbeat", agentId: "A", note: "x".repeat(1000) } });
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => big(i)).join("\n") + "\n");

    const newest = store.readEventsPage(file, 3);
    expect(newest.events.map((e) => e.eventId)).toEqual(["E497", "E498", "E499"]);
    expect(newest.hasMore).toBe(true);

    const older = store.readEventsPage(file, 3, "E497");
    expect(older.events.map((e) => e.eventId)).toEqual(["E494", "E495", "E496"]);
    expect(older.hasMore).toBe(true);

    const nearStart = store.readEventsPage(file, 5, "E3");
    expect(nearStart.events.map((e) => e.eventId)).toEqual(["E0", "E1", "E2"]);
    expect(nearStart.hasMore).toBe(false);

    const unknown = store.readEventsPage(file, 5, "nope");
    expect(unknown.events).toEqual([]);
    expect(unknown.hasMore).toBe(false);
  });

  it("returns only unfinished threads for recovery", () => {
    const store = new Store(temp());
    const meta = (id: string, status: ThreadMeta["status"]): ThreadMeta => ({
      threadId: id,
      orderId: `O-${id}`,
      kind: "order",
      from: { id: "c", address: "c@h", host: "h" },
      targets: [],
      status,
      summary: id,
      summaryTurn: 1,
      createdAt: 1,
      file: `/nonexistent/${id}.jsonl`,
      turns: 1,
      replies: [],
      declines: [],
    });
    store.putThread(meta("open", "working"));
    store.putThread(meta("routing", "routing"));
    store.putThread(meta("done", "done"));
    store.putThread(meta("failed", "failed"));
    expect(store.openThreads().map((m) => m.threadId).sort()).toEqual(["open", "routing"]);
  });
});
