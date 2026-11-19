import { describe, expect, it } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import { eventMatches, parseEventFilter, replayAfter } from "../packages/daemon/src/events.ts";

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