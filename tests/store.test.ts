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

  // #31: recovery and backfill read only the part of a Thread they need, from the end.
  it("reads one Order's events from the end, stopping at its order.created", () => {
    const home = temp();
    const store = new Store(home);
    const file = join(home, "sessions", "order.jsonl");
    const ev = (i: number, orderId: string, type = "order.heartbeat") =>
      JSON.stringify({ eventId: `E${i}`, threadId: "T", orderId, host: "h", at: i, event: type === "order.created" ? { type, order: { orderId } } : { type, agentId: "A", note: "x".repeat(1000) } });
    const lines = [ev(0, "O1", "order.created"), ...Array.from({ length: 300 }, (_, i) => ev(i + 1, "O1")), ev(301, "O2", "order.created"), ev(302, "O1"), ev(303, "O2")];
    writeFileSync(file, lines.join("\n") + "\n");
    expect(store.readOrderEvents(file, "O2").map((e) => e.eventId)).toEqual(["E301", "E303"]);
    expect(store.readOrderEvents(file, "O1")).toHaveLength(302);
    expect(store.readOrderEvents(file, "nope")).toEqual([]);
  });

  it("reads the events at or after a time, from the end, across read chunks", () => {
    const home = temp();
    const store = new Store(home);
    const file = join(home, "sessions", "since.jsonl");
    const big = (i: number) => JSON.stringify({ ...env(i), event: { type: "order.heartbeat", agentId: "A", note: "x".repeat(1000) } });
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => big(i)).join("\n") + "\n");
    expect(store.readEventsSince(file, 497).map((e) => e.eventId)).toEqual(["E497", "E498", "E499"]);
    expect(store.readEventsSince(file, 0)).toHaveLength(500);
    expect(store.readEventsSince(file, 1000)).toEqual([]);
  });

  it("finds the newest matching event from the end", () => {
    const home = temp();
    const store = new Store(home);
    const file = join(home, "sessions", "last.jsonl");
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => JSON.stringify(env(i))).join("\n") + "\n");
    expect(store.findLastEvent(file, (e) => e.at % 7 === 0)?.eventId).toBe("E49");
    expect(store.findLastEvent(file, (e) => e.at < 3)?.eventId).toBe("E2");
    expect(store.findLastEvent(file, () => false)).toBeUndefined();
  });

  // #90: a 64 KiB read boundary can split a multi-byte character; every phase must decode intact.
  it("keeps CJK and emoji text intact whatever byte the read boundary falls on", () => {
    const home = temp();
    const store = new Store(home);
    const text = (i: number) => `第${i}轮：根因在字节切分🙂。`.repeat(1 + (i % 7));
    const reply = (i: number) =>
      JSON.stringify({ eventId: `E${i}`, threadId: "T", orderId: "O", host: "h", at: i, event: { type: "order.replied", agentId: "A", text: text(i), final: false } });
    let bad = 0;
    for (let pad = 0; pad < 64; pad++) {
      const file = join(home, "sessions", `utf8-${pad}.jsonl`);
      const body = Array.from({ length: 900 }, (_, i) => reply(i)).join("\n") + "\n";
      writeFileSync(file, "x".repeat(pad) + "\n" + body);
      const check = (envs: ThreadEnvelope[]) => {
        for (const e of envs) if (e.event.type === "order.replied" && e.event.text !== text(e.at)) bad++;
      };
      check(store.readEventsSince(file, 0));
      check(store.readEventsPage(file, 900).events);
      check(store.readOrderEvents(file, "O"));
      const hit = store.findLastEvent(file, (e) => e.at === 3);
      if (hit) check([hit]);
    }
    expect(bad).toBe(0);
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
