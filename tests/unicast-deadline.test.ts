import { afterEach, describe, expect, it } from "vitest";
import { customer, identity, barista, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// #60: a Barista that acks and keeps heartbeating but never answers used to hold a unicast Order open
// forever, and `cafe ask` waited on it with no timeout. Ctrl-C left `thread_busy` behind.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("unicast has an upper bound (#60)", () => {
  it("closes a unicast Order whose Barista only heartbeats", async () => {
    const d = await startDaemon("pc1", { timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 600 } });
    cleanup.push(d.stop);
    // ack + heartbeat, never a final reply (the scripted helper keeps the lease alive).
    const b = await barista(d.addr, identity("busy"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 5000));
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "are you there?", to: "busy" });
    const events = await untilClosed(c, res.threadId, res.orderId, 5000);
    const failed = events.find((e) => e.event.type === "order.failed");
    expect(failed?.event).toMatchObject({ reason: "deadline", unavailable: true });
    expect(events.at(-1)?.event).toMatchObject({ type: "order.closed", status: "failed" });
  });

  it("keeps an explicit per-order deadline ahead of the default", async () => {
    const d = await startDaemon("pc1", { timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 5000 } });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("busy"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 5000));
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const start = Date.now();
    const res = await c.ask({ body: "slow", to: "busy", deadlineMs: 500 });
    const events = await untilClosed(c, res.threadId, res.orderId, 5000);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(events.find((e) => e.event.type === "order.failed")?.event).toMatchObject({ reason: "deadline" });
  });

  it("does not time out a unicast that is answered in time", async () => {
    const d = await startDaemon("pc1", { timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 3000 } });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("quick"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 100));
      await h.reply("here");
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hi", to: "quick" });
    const events = await untilClosed(c, res.threadId, res.orderId, 5000);
    expect(events.at(-1)?.event).toMatchObject({ type: "order.closed", status: "done" });
  });
});

describe("thread_busy gives a way out (#60)", () => {
  it("names the cancel command and can replace the stuck order", async () => {
    const d = await startDaemon("pc1", { timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 60_000 } });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("busy"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 5000));
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "stuck", to: "busy" });
    await waitFor(() => d.daemon.thread(first.threadId)?.meta.status === "working");

    await expect(c.ask({ body: "again", threadId: first.threadId })).rejects.toMatchObject({
      code: "thread_busy",
      message: expect.stringContaining(`cafe cancel ${first.threadId}`),
    });
    const replaced = await c.ask({ body: "replacement", threadId: first.threadId, replace: true });
    expect(replaced.threadId).toBe(first.threadId);
    expect(replaced.decision).toBeTruthy();
  });
});