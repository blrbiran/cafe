import { afterEach, describe, expect, it } from "vitest";
import { keepAlive } from "@cafe/protocol/client";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("collect all (v4-11)", () => {
  it("waits for a slow target instead of the 2 s grace", async () => {
    const d = await startDaemon("ca1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const fast = await barista(d.addr, identity("fast"), async (h) => {
      await h.ack();
      await h.reply("fast");
    });
    cleanup.push(() => fast.client.close());
    const slow = await barista(d.addr, identity("slow"), async (h) => {
      await h.ack();
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      await new Promise((r) => setTimeout(r, 300));
      stop();
      await h.reply("slow");
    });
    cleanup.push(() => slow.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const started = Date.now();
    const res = await c.ask({ body: "everyone", broadcast: true, collect: "all" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    const replies = events.filter((e) => e.event.type === "order.replied" && e.event.final);
    expect(replies.map((e) => (e.event as { agentId: string }).agentId).sort()).toEqual([fast.rec.agentId, slow.rec.agentId].sort());
    expect(events.find((e) => e.event.type === "order.closed")?.event).toMatchObject({ status: "done" });
    await waitFor(() => (d.daemon.thread(res.threadId)?.meta.targetStates ?? []).length === 2, 5000);
    expect(d.daemon.thread(res.threadId)!.meta.targetStates).toEqual(
      expect.arrayContaining([
        { agentId: fast.rec.agentId, state: "replied" },
        { agentId: slow.rec.agentId, state: "replied" },
      ]),
    );
  });

  it("marks a silent target skipped at the deadline, not declined", async () => {
    const d = await startDaemon("ca2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const fast = await barista(d.addr, identity("fast"), async (h) => {
      await h.ack();
      await h.reply("fast");
    });
    cleanup.push(() => fast.client.close());
    const silent = await barista(d.addr, identity("silent"), async (h) => {
      await h.ack();
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      await new Promise((r) => setTimeout(r, 5000));
      stop();
    });
    cleanup.push(() => silent.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "everyone", broadcast: true, collect: "all", deadlineMs: 300 });
    const events = await untilClosed(c, res.threadId, res.orderId);
    const skip = events.find((e) => e.event.type === "order.declined" && (e.event as { agentId?: string }).agentId === silent.rec.agentId);
    expect(skip?.event).toMatchObject({ skipped: true, reason: "deadline" });
    await waitFor(() => d.daemon.thread(res.threadId) !== undefined, 5000);
    const meta = d.daemon.thread(res.threadId)!.meta;
    expect(meta.declines ?? []).toEqual([]);
    expect(meta.targetStates).toEqual(
      expect.arrayContaining([
        { agentId: fast.rec.agentId, state: "replied" },
        { agentId: silent.rec.agentId, state: "skipped" },
      ]),
    );
    expect(meta.status).toBe("done");
  });

  it("keeps the any policy: first answer plus grace closes the thread", async () => {
    const d = await startDaemon("ca3", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const fast = await barista(d.addr, identity("fast"), async (h) => {
      await h.ack();
      await h.reply("fast");
    });
    cleanup.push(() => fast.client.close());
    const slow = await barista(d.addr, identity("slow"), async (h) => {
      await h.ack();
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      await new Promise((r) => setTimeout(r, 300));
      stop();
      await h.reply("slow");
    });
    cleanup.push(() => slow.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const started = Date.now();
    const res = await c.ask({ body: "everyone", broadcast: true });
    await untilClosed(c, res.threadId, res.orderId);
    expect(Date.now() - started).toBeLessThan(250);
  });
});