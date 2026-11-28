import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CafeClient, keepAlive } from "@cafe/protocol/client";
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

  it("answers an owner-bound clarification on a remote member's child Thread", async () => {
    const root = await startDaemon("clar-root", { mode: "root" });
    cleanup.push(root.stop);
    const remote = await startDaemon("clar-member", { config: { root: root.addr } });
    cleanup.push(remote.stop);
    const received: Array<{ threadId: string; body: string }> = [];
    const worker = await barista(remote.addr, identity("tester"), async (h) => {
      await h.ack();
      received.push(h.order);
      await h.reply(h.order.turn === 1 ? "will confirm" : "continuing the parser checks");
    });
    cleanup.push(() => worker.client.close());
    await waitFor(() => !!root.daemon.registry.get(worker.rec.agentId));
    const owner = "a".repeat(64);
    const post = (path: string, value: unknown, key?: string) => fetch(`http://${root.addr}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-cafe-order-owner": key } : {}) },
      body: JSON.stringify(value),
    });
    const parent = await (await post("/api/orders", { body: "check parsing", to: "tester" }, owner)).json() as Delegated;
    await waitFor(() => remote.daemon.thread(parent.threadId)?.meta.status === "done");
    const question = await worker.client.ask({ body: `${"Background. ".repeat(400)}Include old syntax too?`, escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    expect(question.decision).toMatchObject({ needsHuman: true, targets: [] });
    const path = `/api/threads/${parent.threadId}/clarifications/${question.threadId}/answer`;
    const input = { clarificationOrderId: question.orderId, text: "yes, cover old syntax" };
    expect((await post(path, input, "b".repeat(64))).ok).toBe(false);
    expect((await post(path, { ...input, clarificationOrderId: parent.orderId }, owner)).ok).toBe(false);
    const accepted = await post(path, input, owner);
    expect(accepted.ok).toBe(true);
    const answer = await accepted.json() as Delegated;
    expect(await (await post(path, input, owner)).json()).toMatchObject({ orderId: answer.orderId });
    expect((await post(path, { ...input, text: "a conflicting answer" }, owner)).ok).toBe(false);
    await waitFor(() => root.daemon.thread(question.threadId)?.meta.replies.some((r) => r.text === "continuing the parser checks") === true);
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ threadId: question.threadId, body: input.text, history: [{ text: expect.stringContaining("Include old syntax too?") }] });
    expect(root.daemon.thread(parent.threadId)?.meta).toMatchObject({ status: "done", turns: 1 });
  });

  it("keeps a pending clarification across a daemon restart and refuses a namesake", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-clarification-restart-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const daemon = await startDaemon("clar-restart", { mode: "root", home });
    cleanup.push(daemon.stop);
    const client = new CafeClient({ daemon: daemon.addr });
    cleanup.push(() => client.close());
    const handled: string[] = [];
    client.onOrder((h) => void (async () => {
      handled.push(h.order.body);
      await h.ack();
      await h.reply("done");
    })().catch(() => {}));
    const worker = (await client.connect(identity("tester")))!;
    const owner = "d".repeat(64);
    const parent = await daemon.daemon.createOrder({ body: "check parser", kind: "order", to: "tester" }, undefined, owner);
    await waitFor(() => daemon.daemon.thread(parent.threadId)?.meta.status === "done");
    const clarification = await client.ask({ body: "include old syntax?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    expect(clarification.decision.needsHuman).toBe(true);
    client.close();
    await daemon.stop();
    const restored = await startDaemon("clar-restart", { mode: "root", home, port: daemon.server.port });
    cleanup.push(restored.stop);
    const namesake = await barista(restored.addr, identity("tester"));
    cleanup.push(() => namesake.client.close());
    const input = { clarificationOrderId: clarification.orderId, text: "yes" };
    expect(() => restored.daemon.answerClarification(parent.threadId, clarification.threadId, input, owner)).toThrow(/offline/);
    const impostor = new CafeClient({ daemon: restored.addr });
    cleanup.push(() => impostor.close());
    await expect(impostor.connect(identity("tester", { resumeAgentId: worker.agentId }))).rejects.toMatchObject({ code: "bad_identity" });
    await client.connect(identity("tester"));
    const answer = restored.daemon.answerClarification(parent.threadId, clarification.threadId, input, owner);
    expect(answer.decision.targets).toEqual([worker.agentId]);
    await waitFor(() => handled.includes("yes"));
    await waitFor(() => restored.daemon.thread(clarification.threadId)?.meta.clarification?.acknowledged === true);
    await waitFor(() => restored.daemon.thread(clarification.threadId)?.meta.status === "done");
    expect(await restored.daemon.orderResult(parent.threadId, parent.orderId)).toMatchObject({ taskStatus: "awaiting_report" });
    await expect(namesake.client.report({ threadId: parent.threadId, orderId: parent.orderId, text: "wrong reporter" })).rejects.toMatchObject({ code: "not_a_target" });
    await client.report({ threadId: parent.threadId, orderId: parent.orderId, text: "Parser checked with old syntax." });
    await client.report({ threadId: parent.threadId, orderId: parent.orderId, text: "Parser checked with old syntax." });
    expect(await restored.daemon.orderResult(parent.threadId, parent.orderId)).toEqual({
      taskStatus: "done", reports: [{ agentId: worker.agentId, text: "Parser checked with old syntax." }],
    });
  });

  it("replays an accepted answer after restart using its original Order ID", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-clarification-delivery-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const first = await startDaemon("answer-recovery", { mode: "root", home });
    cleanup.push(first.stop);
    const worker = new CafeClient({ daemon: first.addr, reconnect: true });
    cleanup.push(() => worker.close());
    let answerHandle: import("@cafe/protocol/client").OrderHandle | undefined;
    let answerCount = 0;
    worker.onOrder((h) => {
      if (h.order.clarificationRecipient) {
        answerCount++;
        answerHandle = h;
      } else void h.ack().then(() => h.reply("checking scope")).catch(() => {});
    });
    await worker.connect(identity("tester"));
    const owner = "f".repeat(64);
    const parent = await first.daemon.createOrder({ body: "check parsing", kind: "order", to: "tester" }, undefined, owner);
    await waitFor(() => first.daemon.thread(parent.threadId)?.meta.status === "done");
    const question = await worker.ask({ body: "Include old syntax?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    const input = { clarificationOrderId: question.orderId, text: "include it" };
    const answer = first.daemon.answerClarification(parent.threadId, question.threadId, input, owner);
    await waitFor(() => answerHandle?.order.orderId === answer.orderId);
    await first.stop();
    await waitFor(() => !worker.connected);
    const originalAck = answerHandle!.ack().then(
      () => answerHandle!.reply("tests complete"),
      (error: unknown) => error,
    );
    const restored = await startDaemon("answer-recovery", { mode: "root", home, port: first.server.port });
    cleanup.push(restored.stop);
    expect(await originalAck).toBeUndefined();
    await waitFor(() => restored.daemon.thread(question.threadId)?.meta.clarification?.acknowledged === true);
    expect(answerCount).toBe(1);
    expect(restored.daemon.answerClarification(parent.threadId, question.threadId, input, owner).orderId).toBe(answer.orderId);
    await waitFor(() => restored.daemon.thread(question.threadId)?.meta.status === "done");
  });

  it.each([false, true])("recovers a journaled answer when a crash leaves its SQLite metadata behind (transient assignment write failure: %s)", async (failAssignmentWrite) => {
    const home = mkdtempSync(join(tmpdir(), "cafe-clarification-journal-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const first = await startDaemon("answer-journal", { mode: "root", home });
    cleanup.push(first.stop);
    const worker = new CafeClient({ daemon: first.addr, reconnect: true });
    cleanup.push(() => worker.close());
    const received: string[] = [];
    worker.onOrder((h) => void h.ack().then(() => {
      if (h.order.clarificationRecipient) received.push(h.order.orderId);
      return h.reply("done");
    }).catch(() => {}));
    await worker.connect(identity("tester"));
    const owner = "9".repeat(64);
    const parent = await first.daemon.createOrder({ body: "check parsing", kind: "order", to: "tester" }, undefined, owner);
    await waitFor(() => first.daemon.thread(parent.threadId)?.meta.status === "done");
    const question = await worker.ask({ body: "cover older syntax?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    const input = { clarificationOrderId: question.orderId, text: "yes" };
    const write = vi.spyOn(first.daemon.store, "putThread").mockImplementationOnce(() => { throw new Error("simulated index interruption"); });
    expect(() => first.daemon.answerClarification(parent.threadId, question.threadId, input, owner)).toThrow("simulated index interruption");
    write.mockRestore();
    const original = first.daemon.thread(question.threadId)!.meta.orderId;
    await first.stop();
    const restored = await startDaemon("answer-journal", { mode: "root", home, port: first.server.port });
    cleanup.push(restored.stop);
    let failures = 0;
    const append = restored.daemon.store.appendEvent.bind(restored.daemon.store);
    const interrupted = vi.spyOn(restored.daemon.store, "appendEvent").mockImplementation((file, env) => {
      if (failAssignmentWrite && env.orderId === original && env.event.type === "order.assigned" && failures === 0) {
        failures++;
        throw new Error("simulated assignment write failure");
      }
      return append(file, env);
    });
    cleanup.push(() => { interrupted.mockRestore(); });
    expect(restored.daemon.answerClarification(parent.threadId, question.threadId, input, owner).orderId).toBe(original);
    await waitFor(() => received.length === 1);
    expect(failures).toBe(failAssignmentWrite ? 1 : 0);
    expect(received).toEqual([original]);
    expect(restored.daemon.thread(question.threadId)?.meta.turns).toBe(2);
  });

  it.each(["order.assigned", "order.routed"] as const)("closes an accepted clarification at its deadline when %s persistence fails and the member goes offline", async (failedEvent) => {
    const d = await startDaemon("answer-deadline", { mode: "root", timing: { ...FAST, unicastDeadlineMs: 1000 } });
    cleanup.push(d.stop);
    const worker = await barista(d.addr, identity("tester"));
    cleanup.push(() => worker.client.close());
    const owner = "9".repeat(64);
    const parent = await d.daemon.createOrder({ body: "check parsing", kind: "order", to: "tester" }, undefined, owner);
    await waitFor(() => d.daemon.thread(parent.threadId)?.meta.status === "done");
    const question = await worker.client.ask({ body: "cover older syntax?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    const input = { clarificationOrderId: question.orderId, text: "yes" };
    const append = d.daemon.store.appendEvent.bind(d.daemon.store);
    const interrupted = vi.spyOn(d.daemon.store, "appendEvent").mockImplementation((file, env) => {
      const bytes = append(file, env);
      if (env.threadId === question.threadId && env.event.type === failedEvent) throw new Error("simulated journal interruption");
      return bytes;
    });
    try {
      expect(() => d.daemon.answerClarification(parent.threadId, question.threadId, input, owner)).toThrow("simulated journal interruption");
    } finally {
      interrupted.mockRestore();
      worker.client.close();
    }
    const answer = d.daemon.answerClarification(parent.threadId, question.threadId, input, owner);
    await waitFor(() => d.daemon.thread(question.threadId)?.events.some(({ orderId, event }) =>
      orderId === answer.orderId && event.type === "order.closed" && event.status === "failed") ?? false);
  });

  it("does not assign a clarification answer once its deadline elapsed during routing", async () => {
    const d = await startDaemon("answer-expired", { mode: "root", timing: { ...FAST, unicastDeadlineMs: 1000 } });
    cleanup.push(d.stop);
    const worker = await barista(d.addr, identity("tester"));
    cleanup.push(() => worker.client.close());
    const owner = "9".repeat(64);
    const parent = await d.daemon.createOrder({ body: "check parsing", kind: "order", to: "tester" }, undefined, owner);
    await waitFor(() => d.daemon.thread(parent.threadId)?.meta.status === "done");
    const question = await worker.client.ask({ body: "cover older syntax?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    const now = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    const append = d.daemon.store.appendEvent.bind(d.daemon.store);
    const routing = vi.spyOn(d.daemon.store, "appendEvent").mockImplementation((file, env) => {
      const bytes = append(file, env);
      if (env.threadId === question.threadId && env.event.type === "order.routed") offset = 2000;
      return bytes;
    });
    const answer = (() => {
      try {
        return d.daemon.answerClarification(parent.threadId, question.threadId, { clarificationOrderId: question.orderId, text: "yes" }, owner);
      } finally {
        routing.mockRestore();
        clock.mockRestore();
      }
    })();
    const events = d.daemon.thread(question.threadId)!.events.filter(({ orderId }) => orderId === answer.orderId);
    expect(events.some(({ event }) => event.type === "order.assigned")).toBe(false);
    expect(events.some(({ event }) => event.type === "order.closed" && event.status === "failed")).toBe(true);
  });

  it("lets a front door relay the person's scope decision back to the assigned member", async () => {
    const d = await startDaemon("clar-team", { mode: "root", timing: { ...FAST, heartbeatIntervalMs: 1000 } });
    cleanup.push(d.stop);
    let original: { threadId: string; orderId: string } | undefined;
    let workerQuestion: import("@cafe/protocol/client").OrderHandle | undefined;
    let humanQuestion: Delegated | undefined;
    let assignment: Delegated | undefined;
    let workerQuestionId: string | undefined;
    const worker = await barista(d.addr, identity("tester"), async (h) => {
      await h.ack();
      const q = await worker.client.ask({ body: "Legacy syntax too?", parentThreadId: h.order.threadId, parentOrderId: h.order.orderId, escalate: true });
      workerQuestionId = q.threadId;
      await waitFor(() => d.daemon.thread(q.threadId)?.meta.status === "done");
      const decision = d.daemon.thread(q.threadId)?.meta.replies[0]?.text;
      await h.reply(`tested with decision: ${decision}`);
    });
    cleanup.push(() => worker.client.close());
    const lead = await barista(d.addr, identity("front-door"), async (h) => {
      await h.ack();
      if (h.order.clarificationRecipient) {
        await workerQuestion!.reply(h.order.body);
        await h.reply("relayed to tester");
      } else if (h.order.escalate) {
        workerQuestion = h;
        humanQuestion = await lead.client.ask({ body: h.order.body, parentThreadId: original!.threadId, parentOrderId: original!.orderId, escalate: true });
        await waitFor(() => d.daemon.thread(h.order.threadId)?.meta.status === "done");
      } else {
        original = h.order;
        assignment = await lead.client.ask({ body: "test parsing", to: "tester", parentThreadId: h.order.threadId, parentOrderId: h.order.orderId });
        await h.reply("tester is working", false);
        await waitFor(() => d.daemon.thread(assignment!.threadId)?.meta.status === "done");
        const outcome = d.daemon.thread(assignment!.threadId)?.meta.replies[0]?.text;
        await h.reply(`Result: ${outcome}`);
      }
    });
    cleanup.push(() => lead.client.close());
    const owner = "e".repeat(64);
    const parent = await d.daemon.createOrder({ body: "verify parser", kind: "order", to: "front-door" }, undefined, owner);
    await waitFor(() => humanQuestion?.threadId !== undefined && workerQuestionId !== undefined);
    expect(d.daemon.thread(parent.threadId)?.meta.status).toBe("working");
    expect(humanQuestion!.decision).toMatchObject({ needsHuman: true });
    d.daemon.answerClarification(parent.threadId, humanQuestion!.threadId, { clarificationOrderId: humanQuestion!.orderId, text: "include legacy" }, owner);
    await waitFor(() => d.daemon.thread(parent.threadId)?.meta.status === "done");
    expect(d.daemon.thread(parent.threadId)?.meta.replies[0]?.text).toBe("Result: tested with decision: include legacy");
  });

  it("opens and answers a clarification whose live updates the human Host missed", async () => {
    const root = await startDaemon("catchup-root", { mode: "root" });
    cleanup.push(root.stop);
    const origin = await startDaemon("catchup-origin", { config: { root: root.addr } });
    cleanup.push(origin.stop);
    const worker = await barista(root.addr, identity("tester"));
    cleanup.push(() => worker.client.close());
    await waitFor(() => !!origin.daemon.registry.get(worker.rec.agentId));
    const owner = "c".repeat(64);
    const parent = await origin.daemon.createOrder({ body: "check parsing", kind: "order", to: "tester" }, undefined, owner);
    await waitFor(() => origin.daemon.thread(parent.threadId)?.meta.status === "done");
    const record = origin.daemon.recordEvent.bind(origin.daemon);
    // Simulate the requester missing the publication while Root retains its real journal.
    const missed = vi.spyOn(origin.daemon, "recordEvent").mockImplementation((env, options) => {
      if (env.threadId === parent.threadId) record(env, options);
    });
    cleanup.push(() => { missed.mockRestore(); });
    const question = await worker.client.ask({ body: "old syntax too?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    expect(question.decision).toMatchObject({ needsHuman: true });
    expect(origin.daemon.thread(question.threadId)).toBeUndefined();
    missed.mockRestore();
    const response = await fetch(`http://${origin.addr}/api/threads/${question.threadId}`);
    expect(await response.json()).toMatchObject({ meta: { clarification: { orderId: question.orderId } } });
    const answer = await fetch(`http://${origin.addr}/api/threads/${parent.threadId}/clarifications/${question.threadId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-order-owner": owner },
      body: JSON.stringify({ clarificationOrderId: question.orderId, text: "yes" }),
    });
    expect(answer.ok).toBe(true);
    await waitFor(() => origin.daemon.thread(question.threadId)?.meta.clarification?.acknowledged === true);
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