import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import type { Peer } from "@cafe/protocol/peer";
import type { OrderHandle } from "@cafe/protocol/client";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";
import { enrollTestChild } from "./tls-helpers.ts";

/**
 * A TLS child Daemon reaching a TLS Root over `wss://` (v4-6). In its own file: the child adds the
 * Root's CA to the process-wide trust store, which would otherwise make other TLS tests in the same
 * worker pass for the wrong reason.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

describe("a TLS child daemon reaches a TLS Root", () => {
  it.each([false, true])("relays a child question to a Root Barista (assignment fanout interrupted: %s)", async (interrupted) => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-tls-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-tls-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));

    const root = await startDaemon("tlsroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    // Enrollment installs the Root's CA plus this child's identity certificate and pinned Root ID.
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "tlschild");
    const child = await startDaemon("tlschild", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId } } },
    });
    cleanup.push(child.stop);

    await waitFor(() => child.daemon.rootOnline, 10_000);
    const b = await barista(root.addr, identity("tlsbilling", { tags: ["invoice"] }));
    cleanup.push(() => b.client.close());
    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    let issued: ThreadEnvelope | undefined;
    const request = { body: "the invoice total is wrong", to: "tlsbilling" };
    const res = interrupted ? await (async () => {
      const append = child.daemon.store.appendEvent.bind(child.daemon.store);
      const write = vi.spyOn(child.daemon.store, "appendEvent").mockImplementation((file, env) => {
        const count = append(file, env);
        if (env.event.type === "order.assigned") {
          issued = env;
          throw new Error("simulated interruption after assignment append");
        }
        return count;
      });
      try {
        await expect(c.ask(request)).rejects.toThrow("simulated interruption after assignment append");
      } finally {
        write.mockRestore();
      }
      const internal = child.daemon as unknown as { tracking: Map<string, unknown>; dispatch(tracking: unknown, agentId: string): void };
      const { threadId, orderId } = issued!;
      internal.dispatch(internal.tracking.get(orderId), b.rec.agentId);
      return { threadId, orderId };
    })() : await c.ask(request);
    const events = await untilClosed(c, res.threadId, res.orderId);
    const created = events.find((e) => e.event.type === "order.created");
    const reply = events.find((e) => e.event.type === "order.replied");
    const assigned = child.daemon.thread(res.threadId)?.events.find(({ event }) => event.type === "order.assigned")?.event;
    expect(assigned?.type).toBe("order.assigned");
    if (assigned?.type !== "order.assigned") throw new Error("missing canonical assignment");
    const ack = events.find(({ event }) => event.type === "order.acked");
    expect(ack?.event).toMatchObject({ assignmentId: assigned.assignment.assignmentId });
    expect(reply?.event).toMatchObject({ assignmentId: assigned.assignment.assignmentId, awaitingOwner: true });
    const decision = events.find(({ event }) => event.type === "order.final-accepted");
    expect(decision).toMatchObject({
      eventHostId: child.daemon.hostId,
      event: { replyEventId: reply?.eventId, assignmentId: assigned.assignment.assignmentId, agentId: b.rec.agentId },
    });
    expect(created?.eventHostId).toBe(child.daemon.hostId);
    expect(reply).toMatchObject({ eventHostId: root.daemon.hostId, actor: { kind: "agent", principalId: b.rec.agentId }, event: { agentId: b.rec.agentId } });
    let manual: OrderHandle | undefined;
    const held = await barista(root.addr, identity("held-worker"), async (handle) => {
      manual = handle;
      await handle.ack();
    });
    cleanup.push(() => held.client.close());
    const contested = await c.ask({ body: "check competing results", to: "held-worker" });
    await waitFor(() => !!manual && child.daemon.thread(contested.threadId)?.meta.status === "working");
    const uplink = (child.daemon as unknown as { uplink: Peer }).uplink;
    const notify = uplink.notify.bind(uplink);
    const delayed: ThreadEnvelope[] = [];
    const delay = vi.spyOn(uplink, "notify").mockImplementation((method, params) => {
      const env = params as ThreadEnvelope | undefined;
      if (method === "thread/event" && env?.orderId === contested.orderId &&
          (env.event.type === "order.overridden" || env.event.type === "order.closed")) delayed.push(env);
      else notify(method, params);
    });
    try {
      child.daemon.replyAs(contested.threadId, { orderId: contested.orderId, agent: held.rec.address, text: "operator result" });
      await manual!.reply("late Agent result");
    } finally {
      delay.mockRestore();
    }
    expect(root.daemon.thread(contested.threadId)?.meta.replies).toEqual([]);
    for (const env of delayed) notify("thread/event", env);
    await waitFor(() => root.daemon.thread(contested.threadId)?.meta.status === "done");
    for (const d of [root, child]) {
      expect(d.daemon.thread(contested.threadId)?.meta.replies.map(({ text }) => text)).toEqual(["operator result"]);
      expect(d.daemon.store.outcomes(0).filter((entry) => entry.agentId === held.rec.agentId && entry.kind === "answered")).toEqual([]);
    }

    const owner = "c".repeat(64);
    const parent = await child.daemon.createOrder({ kind: "order", body: "check syntax", to: "held-worker" }, undefined, owner);
    await waitFor(() => child.daemon.thread(parent.threadId)?.meta.status === "working");
    const question = await held.client.ask({ body: "Check older syntax too?", escalate: true, parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    await waitFor(() => !!child.daemon.closingEvent(question.threadId, question.orderId));
    const answer = child.daemon.answerClarification(parent.threadId, question.threadId, { clarificationOrderId: question.orderId, text: "yes" }, owner);
    await waitFor(() => root.daemon.thread(question.threadId)?.events.some((env) => env.orderId === answer.orderId && env.event.type === "order.delivered") ?? false);
    const publication = root.daemon.thread(question.threadId)?.events.find((env) => env.orderId === answer.orderId && env.event.type === "order.created");
    expect(publication).toMatchObject({
      eventHostId: child.daemon.hostId,
      actor: { kind: "human" },
      event: { order: { parentOwnerAttestation: {
        parentOrderId: parent.orderId,
        parentThreadId: parent.threadId,
        clarificationOrderId: question.orderId,
        recipientAgentId: held.rec.agentId,
        recipientHostId: root.daemon.hostId,
        parentAssignmentId: expect.any(String),
      } } },
    });
  }, 40_000);
});