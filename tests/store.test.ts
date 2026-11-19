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
