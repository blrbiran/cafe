import type { Router } from "../packages/daemon/src/router.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customer, identity, barista, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// #60: a Barista that acks and keeps heartbeating but never answers used to hold a unicast Order open
// forever, and `cafe ask` waited on it with no timeout. Ctrl-C left `thread_busy` behind.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.useRealTimers();
});

describe("unicast has an upper bound (#60)", () => {
  it.each([0, -1, 1.5, 2_147_483_648])("rejects invalid deadlineMs %s before creating an Order", async (deadlineMs) => {
    const d = await startDaemon("deadline-schema");
    cleanup.push(d.stop);
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await expect(c.ask({ body: "invalid deadline", to: "nobody", deadlineMs } as any)).rejects.toMatchObject({ code: "bad_request" });
    const response = await fetch(`http://${d.addr}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "invalid deadline", to: "nobody", deadlineMs }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_request" });
  });

  it("keeps a heartbeating Order open past the legacy ten-minute default", async () => {
    const d = await startDaemon("pc-long", { timing: { ...(await import("./helpers.ts")).FAST, heartbeatIntervalMs: 5 * 60_000 } });
    cleanup.push(d.stop);
    const b = new (await import("@cafe/protocol/client")).CafeClient({ daemon: d.addr });
    let handle: import("@cafe/protocol/client").OrderHandle | undefined;
    let stopHeartbeat = () => {};
    let resolveAck!: () => void;
    const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
    b.onOrder((h) => {
      handle = h;
      void (async () => {
        await h.ack();
        const timer = setInterval(() => void h.heartbeat().catch(() => {}), 5 * 60_000);
        stopHeartbeat = () => clearInterval(timer);
        resolveAck();
      })();
    });
    await b.connect(identity("slow"));
    cleanup.push(() => { stopHeartbeat(); b.close(); });
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const res = await c.ask({ body: "long job", to: "slow" });
      await acked;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);

      expect(d.daemon.thread(res.threadId)?.meta.status).toBe("working");
      await handle!.reply("finished after heartbeating");
    } finally {
      stopHeartbeat();
      vi.useRealTimers();
    }
  });

  it("fails an acked Order after its target stops heartbeating", async () => {
    const d = await startDaemon("pc-idle", { timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 5000 } });
    cleanup.push(d.stop);
    const b = new (await import("@cafe/protocol/client")).CafeClient({ daemon: d.addr });
    b.onOrder((h) => void h.ack());
    await b.connect(identity("silent"));
    cleanup.push(() => b.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "silent worker", to: "silent" });
    const events = await untilClosed(c, res.threadId, res.orderId, 5000);

    expect(events.find((env) => env.event.type === "order.failed")?.event).toMatchObject({ reason: "lost (missed heartbeats)" });
    expect(events.at(-1)?.event).toMatchObject({ type: "order.closed", status: "failed" });
  });

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

  it("does not dispatch when routing has already consumed an explicit hard deadline", async () => {
    const router: Router = {
      name: "rules",
      decide: async ({ candidates }) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const target = candidates.find((candidate) => candidate.name === "slow")!;
        return { targets: [target.agentId], mode: "unicast", reason: "delayed route", router: "rules", candidates: [] };
      },
    };
    const d = await startDaemon("route-deadline", { mode: "root", router, timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 5000 } });
    cleanup.push(d.stop);
    let seen = 0;
    const b = await barista(d.addr, identity("slow"), async (h) => { seen++; await h.ack(); await new Promise((resolve) => setTimeout(resolve, 300)); await h.reply("too late"); });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const order = await c.ask({ body: "deadline during routing", deadlineMs: 50 });
    const events = await untilClosed(c, order.threadId, order.orderId, 2000);
    expect(seen).toBe(0);
    expect(events.find((env) => env.event.type === "order.failed")?.event).toMatchObject({ reason: "deadline" });
    expect(events.at(-1)?.event).toMatchObject({ type: "order.closed", status: "failed" });
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
    await expect(c.ask({ body: "invalid replacement", to: "unknown-address", threadId: first.threadId, replace: true })).rejects.toMatchObject({ code: "replacement_unroutable" });
    expect(d.daemon.thread(first.threadId)?.meta).toMatchObject({ orderId: first.orderId, status: "working" });
    const replaced = await c.ask({ body: "replacement", threadId: first.threadId, replace: true });
    expect(replaced.threadId).toBe(first.threadId);
    expect(replaced.decision).toBeTruthy();
  });
});