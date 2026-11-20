import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(reply: string) {
  const d = await startDaemon("pc1", { mode: "root" });
  cleanup.push(d.stop);
  const b = await barista(d.addr, identity("widgets"), async (h) => {
    await h.ack();
    await h.reply(reply);
  });
  cleanup.push(() => b.client.close());
  const c = await customer(d.addr);
  cleanup.push(() => c.close());
  const res = await c.ask({ body: "hello" });
  const events = await untilClosed(c, res.threadId);
  return { d, threadId: res.threadId, events };
}

describe("thread detail pagination", () => {
  it("returns the newest page and lets the client walk backwards", async () => {
    const { d, threadId, events } = await setup("ok");
    expect(events.length).toBeGreaterThanOrEqual(3);

    const get = async (q: string) => (await (await fetch(`http://${d.addr}/api/threads/${threadId}${q}`)).json()) as { events: ThreadEnvelope[]; hasMore: boolean };
    const all = await get("");
    expect(all.events.length).toBeGreaterThanOrEqual(3);
    expect(all.hasMore).toBe(false);

    const first = await get("?limit=2");
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.events.at(-1)!.eventId).toBe(all.events.at(-1)!.eventId);

    const older = await get(`?limit=2&before=${first.events[0]!.eventId}`);
    expect(older.events).toHaveLength(Math.min(2, all.events.length - 2));
    expect(older.events.at(-1)!.eventId).not.toBe(first.events[0]!.eventId);
  });
});

describe("limit validation", () => {
  it("rejects negative, zero and non-numeric page sizes instead of leaking SQLite errors", async () => {
    const { d, threadId } = await setup("ok");
    const code = async (path: string) => (await fetch(`http://${d.addr}${path}`)).status;
    expect(await code("/api/threads?limit=-1")).toBe(400);
    expect(await code("/api/threads?limit=nope")).toBe(400);
    expect(await code("/api/threads?limit=0")).toBe(400);
    expect(await code("/api/threads?limit=1001")).toBe(400);
    expect(await code("/api/threads?status=bogus")).toBe(400);
    expect(await code("/api/threads?before=nope")).toBe(400);
    expect(await code(`/api/threads/${threadId}?limit=-1`)).toBe(400);
    expect(await code("/api/search?q=hello&limit=nope")).toBe(400);
    expect(await code("/api/search?q=hello&limit=-1")).toBe(400);
    const zero = (await (await fetch(`http://${d.addr}/api/search?q=hello&limit=0`)).json()) as unknown[];
    expect(zero).toEqual([]);
  });
});

describe("thread stream", () => {
  it("returns 404 for an unknown Thread instead of an SSE stream that never closes", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const res = await fetch(`http://${d.addr}/api/threads/nosuch/stream`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });
});

describe("snapshot summaries", () => {
  it("tolerates old thread metadata without replies/declines arrays", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    expect(() => d.daemon.summaryMeta({ threadId: "t1", replies: undefined, declines: undefined } as never)).not.toThrow();
  });

  it("clips long reply texts so the list payload stays small", async () => {
    const long = "x".repeat(2000);
    const { d, threadId } = await setup(long);
    const snap = (await (await fetch(`http://${d.addr}/api/snapshot`)).json()) as { threads: Array<{ threadId: string; replies: Array<{ text: string }> }> };
    const row = snap.threads.find((t) => t.threadId === threadId)!;
    expect(row.replies).toHaveLength(1);
    expect(row.replies[0]!.text.length).toBeLessThanOrEqual(160);
  });
});