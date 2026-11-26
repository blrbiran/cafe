import { afterEach, describe, expect, it } from "vitest";
import { keepAlive } from "@cafe/protocol/client";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

type Delegated = { orderId: string; threadId: string; decision: { mode: string; targets: string[]; reason: string; failure?: string } };

describe("explicit escalation (v4-11)", () => {
  it("creates a sub-thread and reaches the parent sender", async () => {
    const d = await startDaemon("esc1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);

    let delegated: Delegated | undefined;
    let escalated: Delegated | undefined;

    // `leader` is declared before its behavior uses it.
    let leader!: Awaited<ReturnType<typeof barista>>;
    leader = await barista(d.addr, identity("leader"), async (h) => {
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      try {
        if (h.order.body === "task") {
          delegated = (await leader.client.ask({ body: "subtask", to: "dev" })) as Delegated;
          await h.reply("delegated");
        } else if (h.order.body === "clarify") {
          await h.reply("because reasons");
        } else {
          await h.reply("ok");
        }
      } finally {
        stop();
      }
    });
    cleanup.push(() => leader.client.close());

    let dev!: Awaited<ReturnType<typeof barista>>;
    dev = await barista(d.addr, identity("dev"), async (h) => {
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      try {
        if (h.order.body === "subtask") {
          escalated = (await dev.client.ask({
            body: "clarify",
            escalate: true,
            parentOrderId: h.order.orderId,
            parentThreadId: h.order.threadId,
          })) as Delegated;
          await h.reply("doing it");
        } else {
          await h.reply("ok");
        }
      } finally {
        stop();
      }
    });
    cleanup.push(() => dev.client.close());

    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await c.ask({ body: "task" });

    await waitFor(() => !!escalated, 5000);
    expect(escalated!.decision).toMatchObject({ mode: "unicast", targets: [leader.rec.agentId] });
    expect(escalated!.decision.reason).toContain("escalate to parent");
    await untilClosed(dev.client, escalated!.threadId, escalated!.orderId);

    await waitFor(() => d.daemon.thread(escalated!.threadId) !== undefined, 5000);
    const child = d.daemon.thread(escalated!.threadId)!.meta;
    expect(child.parentThreadId).toBe(delegated!.threadId);
    expect(child.replies.some((r) => r.agentId === leader.rec.agentId)).toBe(true);
    // The parent Thread did not absorb the clarification.
    const parent = d.daemon.thread(delegated!.threadId)!.meta;
    expect(parent.replies.some((r) => r.text.includes("because reasons"))).toBe(false);
  });

  it("fails parent_offline instead of broadcasting to strangers", async () => {
    const d = await startDaemon("esc2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);

    let delegated: Delegated | undefined;
    let leader!: Awaited<ReturnType<typeof barista>>;
    leader = await barista(d.addr, identity("leader"), async (h) => {
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      try {
        if (h.order.body === "task") {
          delegated = (await leader.client.ask({ body: "subtask", to: "dev" })) as Delegated;
          await h.reply("delegated");
        } else {
          await h.reply("ok");
        }
      } finally {
        stop();
      }
    });
    cleanup.push(() => leader.client.close());

    let dev!: Awaited<ReturnType<typeof barista>>;
    dev = await barista(d.addr, identity("dev"), async (h) => {
      await h.reply("doing it");
    });
    cleanup.push(() => dev.client.close());

    let bystanderSaw = 0;
    const bystander = await barista(d.addr, identity("bystander"), async (h) => {
      bystanderSaw++;
      await h.reply("unrelated");
    });
    cleanup.push(() => bystander.client.close());

    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await c.ask({ body: "task", to: "leader" });
    await waitFor(() => !!delegated, 5000);

    leader.client.close();
    await waitFor(() => d.daemon.registry.get(leader.rec.agentId) === undefined, 5000);

    const res = await dev.client.ask({
      body: "clarify",
      escalate: true,
      parentOrderId: delegated!.orderId,
      parentThreadId: delegated!.threadId,
    });
    expect(res.decision).toMatchObject({ failure: "parent_offline", targets: [] });
    const events = await untilClosed(dev.client, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.failed")?.event).toMatchObject({ reason: "parent_offline" });
    expect(bystanderSaw).toBe(0);
  });

  it("explains when the parent requester is a person", async () => {
    const d = await startDaemon("human-parent", { mode: "root" });
    cleanup.push(d.stop);
    const dev = await barista(d.addr, identity("dev"));
    cleanup.push(() => dev.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const parent = await c.ask({ body: "check the parser", to: "dev" });
    await untilClosed(c, parent.threadId);
    const question = await dev.client.ask({ body: "which syntax?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    expect(question.decision.targets).toEqual([]);
    expect(question.decision.failure).toBe("parent_not_agent");
    expect(question.decision.reason).toMatch(/original conversation/);
  });

  it("rejects an escalation whose parent cannot be resolved", async () => {
    const d = await startDaemon("esc3", { mode: "root", timing: FAST });
    cleanup.push(d.stop);
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await expect(c.ask({ body: "clarify", escalate: true, parentOrderId: "nope" })).rejects.toMatchObject({ code: "unknown_parent" });
  });

  it("lets an explicit address name a chain member", async () => {
    const d = await startDaemon("esc4", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);

    let leader!: Awaited<ReturnType<typeof barista>>;
    let sawExplicit = false;
    leader = await barista(d.addr, identity("leader"), async (h) => {
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      try {
        if (h.order.body === "task") {
          await leader.client.ask({ body: "subtask", to: "dev" });
          await h.reply("delegated");
        } else if (h.order.body === "explicit ask") {
          sawExplicit = true;
          await h.reply("reached me");
        } else {
          await h.reply("ok");
        }
      } finally {
        stop();
      }
    });
    cleanup.push(() => leader.client.close());

    let dev!: Awaited<ReturnType<typeof barista>>;
    dev = await barista(d.addr, identity("dev"), async (h) => {
      const stop = keepAlive(h, FAST.heartbeatIntervalMs);
      try {
        if (h.order.body === "subtask") {
          const r = await dev.client.ask({ body: "explicit ask", to: leader.rec.address, parentOrderId: h.order.orderId, parentThreadId: h.order.threadId });
          expect(r.decision.targets).toEqual([leader.rec.agentId]);
          await h.reply("doing it");
        } else {
          await h.reply("ok");
        }
      } finally {
        stop();
      }
    });
    cleanup.push(() => dev.client.close());

    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await c.ask({ body: "task", to: "leader" });
    await waitFor(() => sawExplicit, 5000);
  });
});