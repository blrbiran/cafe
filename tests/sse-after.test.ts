import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import { startDaemon } from "./helpers.ts";

// #31 (tester's round 10): `/api/threads/:id/stream?after=<eventId>` sliced the default 200-event page.
// A cursor older than that page fell through `findIndex = -1` → the whole page was replayed, and the
// events between the cursor and the page start were never sent, with no gap marker. Now the replay
// reads from the cursor itself; a cursor the Thread does not have is announced as `event: gap`.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const id = (i: number) => String(i).padStart(26, "0");

async function bigThread(n: number) {
  const d = await startDaemon("sa1");
  cleanup.push(d.stop);
  const now = Date.now();
  const file = d.daemon.store.threadFile("big", now);
  const at = (i: number) => now + i;
  d.daemon.store.appendEvent(file, { eventId: id(0), threadId: "big", orderId: "o1", host: "sa1", at: at(0), event: { type: "order.created", order: { body: "q" } } } as unknown as ThreadEnvelope);
  for (let i = 1; i < n - 1; i++) {
    d.daemon.store.appendEvent(file, { eventId: id(i), threadId: "big", orderId: "o1", host: "sa1", at: at(i), event: { type: "order.heartbeat", agentId: "a" } } as ThreadEnvelope);
  }
  d.daemon.store.appendEvent(file, { eventId: id(n - 1), threadId: "big", orderId: "o1", host: "sa1", at: at(n - 1), event: { type: "order.closed", status: "answered" } } as unknown as ThreadEnvelope);
  d.daemon.store.putThread({ threadId: "big", orderId: "o1", file, status: "answered", createdAt: now, lastActivityAt: at(n - 1), from: { address: "cli@sa1", host: "sa1" }, replies: [], declines: [] } as never);
  return d;
}

async function blocks(addr: string, query: string): Promise<Array<{ event?: string; data: unknown }>> {
  const text = await (await fetch(`http://${addr}/api/threads/big/stream${query}`, { signal: AbortSignal.timeout(5000) })).text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => {
      const lines = b.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      return { ...(event ? { event } : {}), data: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) };
    });
}

describe("SSE replay after a cursor (#31)", () => {
  it("replays every event after a cursor older than the default page", async () => {
    const d = await bigThread(300);
    const got = await blocks(d.addr, `?after=${id(50)}`);
    const ids = got.map((b) => (b.data as ThreadEnvelope).eventId);
    expect(ids[0]).toBe(id(51));
    expect(ids).toHaveLength(249);
    expect(ids.at(-1)).toBe(id(299));
  }, 20_000);

  it("still resumes inside the default page", async () => {
    const d = await bigThread(300);
    const ids = (await blocks(d.addr, `?after=${id(290)}`)).map((b) => (b.data as ThreadEnvelope).eventId);
    expect(ids).toEqual([291, 292, 293, 294, 295, 296, 297, 298, 299].map(id));
  }, 20_000);

  it("announces a gap for a cursor the Thread does not have, then replays the page", async () => {
    const d = await bigThread(300);
    const got = await blocks(d.addr, `?after=nosuch`);
    expect(got[0]).toEqual({ event: "gap", data: { after: "nosuch", reason: "unknown_cursor" } });
    expect(got.slice(1).every((b) => b.event === undefined)).toBe(true);
    expect((got.at(-1)!.data as ThreadEnvelope).eventId).toBe(id(299));
  }, 20_000);
});
