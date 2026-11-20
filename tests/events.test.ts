import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import { eventMatches, parseEventFilter, replayAfter } from "../packages/daemon/src/events.ts";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const env = (host: string, type: string, threadId = "T1"): ThreadEnvelope =>
  ({ eventId: "E1", threadId, orderId: "O1", host, at: 1, event: { type } as ThreadEnvelope["event"] });

describe("event stream filters", () => {
  it("hides heartbeats unless asked for", () => {
    const beat = env("mac", "order.heartbeat");
    expect(eventMatches(beat, {})).toBe(false);
    expect(eventMatches(beat, { includeHeartbeat: true })).toBe(true);
  });

  it("filters by origin host, event type and thread", () => {
    const e = env("ssh1", "order.replied", "T9");
    expect(eventMatches(e, { host: "ssh1" })).toBe(true);
    expect(eventMatches(e, { host: "mac" })).toBe(false);
    expect(eventMatches(e, { types: ["order.routed", "order.replied"] })).toBe(true);
    expect(eventMatches(e, { types: ["order.routed"] })).toBe(false);
    expect(eventMatches(e, { thread: "T9" })).toBe(true);
    expect(eventMatches(e, { thread: "T1" })).toBe(false);
  });

  it("parses comma-separated types and the verbose flag", () => {
    const f = parseEventFilter(new URL("http://x/api/events?host=ssh1&type=order.routed,%20order.replied&thread=T9&verbose=1"));
    expect(f).toEqual({ host: "ssh1", types: ["order.routed", "order.replied"], thread: "T9", includeHeartbeat: true });
  });

  it("resumes after the last event id", () => {
    const a = { ...env("mac", "order.created"), eventId: "E1" };
    const b = { ...env("mac", "order.routed"), eventId: "E2" };
    const c = { ...env("mac", "order.replied"), eventId: "E3" };
    const ring = [a, b, c];
    expect(replayAfter(ring, "E1").map((e) => e.eventId)).toEqual(["E2", "E3"]);
    expect(replayAfter(ring, "E3")).toEqual([]);
    expect(replayAfter(ring, "gone")).toEqual([]);
    expect(replayAfter(ring)).toEqual([]);
  });
});

describe("event history endpoint", () => {
  it("replays the ring after the last event the Web client saw", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hello" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    const first = events[0]!.eventId;

    const body = (await (await fetch(`http://${d.addr}/api/events/history?after=${first}`)).json()) as { events: ThreadEnvelope[]; gap: boolean };
    expect(body.gap).toBe(false);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0]!.eventId).not.toBe(first);

    const tooOld = (await (await fetch(`http://${d.addr}/api/events/history?after=gone`)).json()) as { events: ThreadEnvelope[]; gap: boolean };
    expect(tooOld).toEqual({ events: [], gap: true });
  });
});

describe("thread stream close (#54)", () => {
  it("does not write to a response that already ended", async () => {
    // The old 15 s ping made this race hard to hit in a test; the interval is
    // overridable so the regression is deterministic.
    process.env.CAFE_SSE_PING_MS = "20";
    try {
      const d = await startDaemon("sse1", { mode: "root" });
      cleanup.push(d.stop);
      const b = await barista(d.addr, identity("widgets"));
      cleanup.push(() => b.client.close());
      const c = await customer(d.addr);
      cleanup.push(() => c.close());
      const res = await c.ask({ body: "hi" });
      await untilClosed(c, res.threadId, res.orderId);
      const follow = await c.ask({ body: "again", threadId: res.threadId });
      await untilClosed(c, res.threadId, follow.orderId);

      // Follow one earlier turn: the replay ends at that turn's order.closed and
      // then keeps walking the rest of the Thread.
      const body = await (await fetch(`http://${d.addr}/api/threads/${res.threadId}/stream?orderId=${res.orderId}`)).text();
      expect(body).toContain("order.closed");

      // Anything emitted after the stream ended must not hit the response.
      d.daemon.emit("thread", {
        eventId: "late",
        threadId: res.threadId,
        orderId: res.orderId,
        host: "sse1",
        at: Date.now(),
        event: { type: "order.heartbeat", agentId: b.rec.agentId },
      }, undefined);
      // The old code left its listener attached and its ping running, so this
      // window produced ERR_STREAM_WRITE_AFTER_END.
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      delete process.env.CAFE_SSE_PING_MS;
    }
  });
});