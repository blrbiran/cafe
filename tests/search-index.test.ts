import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEnvelope } from "@cafe/protocol";
import { Store } from "../packages/daemon/src/store.ts";

// #67: indexEvent wrote a `search_indexed` row for every event, heartbeats included — 2.9–4.6× the
// cost of the JSONL append itself, for text nobody can search.
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function store(): Store {
  const d = mkdtempSync(join(tmpdir(), "cafe-idx-"));
  dirs.push(d);
  return new Store(d);
}

const at = Date.now();
const env = (id: string, event: ThreadEnvelope["event"]): ThreadEnvelope => ({ eventId: id, threadId: "t1", orderId: "o1", host: "root", at, event } as ThreadEnvelope);
const heartbeat = (id: string) => env(id, { type: "order.heartbeat", agentId: "a" } as ThreadEnvelope["event"]);
const reply = (id: string, text: string) => env(id, { type: "order.replied", agentId: "a", text, final: true } as ThreadEnvelope["event"]);

describe("search index skips events with no text (#67)", () => {
  it("does not index heartbeats, acks or closes", () => {
    const s = store();
    s.indexEvent(heartbeat("h1"), (x) => x);
    s.indexEvent(env("a1", { type: "order.acked", agentId: "a" } as ThreadEnvelope["event"]), (x) => x);
    s.indexEvent(env("c1", { type: "order.closed", status: "done" } as ThreadEnvelope["event"]), (x) => x);
    expect(s.countIndexed()).toBe(0);
    expect(s.isIndexed("h1")).toBe(false);
  });

  it("still indexes questions and replies, and stays idempotent", () => {
    const s = store();
    s.indexEvent(reply("r1", "the brown fox"), (x) => x);
    s.indexEvent(reply("r1", "the brown fox"), (x) => x);
    expect(s.countIndexed()).toBe(1);
    expect(s.searchIndex("brown fox", 10).hits).toHaveLength(1);
  });
});