import { afterEach, describe, expect, it } from "vitest";
import { keepAlive } from "@cafe/protocol/client";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("fan-out wait policy (#39)", () => {
  it("closes after the first final answer and marks silent targets skipped", async () => {
    const d = await startDaemon("pc1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const fast = await barista(d.addr, identity("fast"), async (h) => {
      await h.ack();
      await h.reply("quick");
    });
    cleanup.push(() => fast.client.close());
    const silent = await barista(d.addr, identity("silent"), async (h) => {
      await h.ack();
      const stop = keepAlive(h, 50);
      await new Promise((r) => setTimeout(r, 5000));
      stop();
    });
    cleanup.push(() => silent.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const started = Date.now();
    const res = await c.ask({ body: "anything", broadcast: true });
    expect(res.decision).toMatchObject({ mode: "broadcast" });
    expect(res.decision.targets).toHaveLength(2);
    const events = await untilClosed(c, res.threadId, res.orderId);
    // Old behavior waited for the 800 ms broadcast deadline; the grace window
    // closes it right after the first answer.
    expect(Date.now() - started).toBeLessThan(500);
    expect(events.find((e) => e.event.type === "order.closed")?.event).toMatchObject({ status: "done" });
    const skipped = events.filter((e) => e.event.type === "order.declined" && e.event.unavailable);
    expect(skipped.map((e) => (e.event as { agentId: string }).agentId)).toContain(silent.rec.agentId);
  });

  // #101: the skip is audit-worthy, but booking it as a *decline* made `cafe stats` say the slow
  // Barista refused work it actually did, and put the same agent in `meta.declines` and `meta.replies`.
  it("keeps a grace skip out of the decline books when the answer arrives anyway", async () => {
    const d = await startDaemon("pc1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const fast = await barista(d.addr, identity("fast"), async (h) => {
      await h.ack();
      await h.reply("quick");
    });
    cleanup.push(() => fast.client.close());
    const slow = await barista(d.addr, identity("slow"), async (h) => {
      await h.ack();
      await new Promise((r) => setTimeout(r, 250));
      await h.reply("late but done");
    });
    cleanup.push(() => slow.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "anything", broadcast: true });
    const events = await untilClosed(c, res.threadId, res.orderId);
    // The skip is still on the wire, for audit.
    const skipped = events.filter((e) => e.event.type === "order.declined");
    expect(skipped.map((e) => (e.event as { agentId: string }).agentId)).toContain(slow.rec.agentId);

    // The late reply lands, and the books no longer contradict themselves.
    await waitFor(() => (d.daemon.thread(res.threadId)?.meta.replies ?? []).some((r) => r.agentId === slow.rec.agentId), 5000);
    const meta = d.daemon.thread(res.threadId)!.meta;
    expect(meta.declines ?? []).not.toContainEqual(expect.objectContaining({ agentId: slow.rec.agentId }));
    expect(d.daemon.routingHints()[`slow@pc1`]?.declined ?? 0).toBe(0);
  });
});