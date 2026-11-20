import { describe, expect, it } from "vitest";
import type { CafeClient } from "@cafe/protocol/client";
import type { ThreadEnvelope } from "@cafe/protocol";
import { untilClosed } from "./helpers.ts";

/** Minimal client surface `untilClosed` uses, so the race can be replayed without sockets. */
function fakeClient(seed: ThreadEnvelope[]) {
  const listeners = new Set<(env: ThreadEnvelope) => void>();
  return {
    recentEvents: () => seed,
    onThreadEvent: (cb: (env: ThreadEnvelope) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (env: ThreadEnvelope) => {
      for (const cb of [...listeners]) cb(env);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

const env = (orderId: string, eventId: string, event: ThreadEnvelope["event"]): ThreadEnvelope => ({
  eventId,
  threadId: "T",
  orderId,
  host: "h",
  at: 1,
  event,
});

describe("untilClosed (#6 follow-up race)", () => {
  it("anchors on the requested order instead of an older turn's close", async () => {
    // The client already saw turn O1 close; O2's order.created has not arrived
    // yet (the daemon response can beat the WebSocket broadcast).
    const c = fakeClient([
      env("O1", "e1", { type: "order.created", order: { orderId: "O1" } as never }),
      env("O1", "e2", { type: "order.closed", status: "done" }),
    ]);
    let settled = false;
    const p = untilClosed(c as unknown as CafeClient, "T", "O2", 500).then((events) => {
      settled = true;
      return events;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    c.emit(env("O2", "e3", { type: "order.created", order: { orderId: "O2" } as never }));
    c.emit(env("O2", "e4", { type: "order.replied", agentId: "a", text: "ok", final: true }));
    c.emit(env("O2", "e5", { type: "order.closed", status: "done" }));

    const events = await p;
    expect(events.map((e) => e.eventId)).toEqual(["e3", "e4", "e5"]);
    expect(c.listenerCount).toBe(0);
  });

  it("still accepts the old third-argument timeout", async () => {
    const c = fakeClient([]);
    await expect(untilClosed(c as unknown as CafeClient, "T", 10)).rejects.toThrow(/not closed/);
  });
});