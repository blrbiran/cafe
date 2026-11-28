import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Peer } from "@cafe/protocol/peer";
import type { OrderAssignment, ThreadEnvelope } from "@cafe/protocol";
import { Store } from "../packages/daemon/src/store.ts";
import { barista, customer, identity, startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("canonical Order assignments", () => {
  it("stages a valid owner route and close until its original creation is durable", async () => {
    const receiver = await startDaemon("owner-events", { mode: "root" });
    cleanup.push(receiver.stop);
    const peer = new Peer({ send() {}, close() {} });
    peer.meta.host = "owner";
    peer.bindHostIdentity({ hostId: "owner-host-id", keyFingerprint: "fixture" });
    const routed = envelope({ type: "order.routed", decision: { targets: [], mode: "unicast", reason: "fixture", router: "rules", candidates: [] } }, "routed");
    const closed = envelope({ type: "order.closed", status: "failed" }, "closed");
    receiver.daemon.recordEvent(routed, { from: peer });
    receiver.daemon.recordEvent(closed, { from: peer });
    expect(receiver.daemon.store.listPendingEvents("thread-1").map((env) => env.eventId)).toEqual(expect.arrayContaining(["routed", "closed"]));
    const created = envelope({ type: "order.created", order: {
      orderId: "order-1", threadId: "thread-1", kind: "order", from: { id: "requester", address: "requester", host: "owner" },
      createdAt: 100, body: "check the parser", chain: [], depth: 0, history: [], turn: 1,
    } }, "created");
    receiver.daemon.recordEvent(created, { from: peer });
    const thread = receiver.daemon.thread("thread-1");
    expect(thread?.events.map((event) => event.eventId)).toEqual(["created", "routed", "closed"]);
    expect(thread?.meta.status).toBe("failed");
    expect(receiver.daemon.store.listPendingEvents("thread-1")).toEqual([]);
  });
  it.each([undefined, "delivery-1"])("retains an authenticated recipient failure for its exact assignment (%s)", async (assignmentId) => {
    const receiver = await startDaemon("recipient-failure", { mode: "root" });
    cleanup.push(receiver.stop);
    const owner = new Peer({ send() {}, close() {} });
    owner.meta.host = "owner";
    owner.bindHostIdentity({ hostId: "owner-host-id", keyFingerprint: "owner-fixture" });
    const target = new Peer({ send() {}, close() {} });
    target.meta.host = "target";
    target.bindHostIdentity({ hostId: "target-host-id", keyFingerprint: "target-fixture" });
    receiver.daemon.recordEvent(envelope({ type: "order.created", order: {
      orderId: "order-1", threadId: "thread-1", kind: "order", from: { id: "requester", address: "requester", host: "owner" },
      createdAt: 100, body: "check the parser", chain: [], depth: 0, history: [], turn: 1,
    } }, "created"), { from: owner });
    receiver.daemon.recordEvent(envelope({ type: "order.assigned", assignment: {
      assignmentId: "delivery-1", targetAgentId: "worker", targetHostId: "target-host-id", bodyHash: "a".repeat(64),
    } }), { from: owner });
    receiver.daemon.recordEvent({ ...envelope({ type: "order.failed", agentId: "worker", assignmentId, reason: "attachment unavailable" }, "failure"),
      host: "target", eventHostId: "target-host-id" }, { from: target });
    expect(receiver.daemon.thread("thread-1")?.events.at(-1)?.event).toMatchObject({ type: "order.failed", agentId: "worker" });
  });

  it("journals the target assignment before handing it to delivery with canonical event references", async () => {
    const daemon = await startDaemon("assignment-owner", { mode: "root" });
    cleanup.push(daemon.stop);
    const worker = await barista(daemon.addr, identity("worker"));
    cleanup.push(() => worker.client.close());
    const caller = await customer(daemon.addr);
    cleanup.push(() => caller.close());

    let delivered = false;
    vi.spyOn(daemon.daemon as any, "deliver").mockImplementation((...args: any[]) => {
      const [order, agentId, proof] = args;
      const events = daemon.daemon.thread(order.threadId)!.events;
      const created = events.find((env) => env.orderId === order.orderId && env.event.type === "order.created")!;
      const assigned = events.find((env) => env.orderId === order.orderId && env.event.type === "order.assigned");
      expect(assigned).toBeDefined();
      expect(assigned!.event).toMatchObject({
        type: "order.assigned",
        assignment: {
          assignmentId: expect.any(String),
          targetAgentId: agentId,
          targetHostId: expect.any(String),
          bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(assigned!.event).not.toHaveProperty("assignment.body");
      expect(assigned!.event).not.toHaveProperty("assignment.history");
      expect(assigned!.eventId).toBe(proof.assignmentEventId);
      expect(proof).toMatchObject({
        assignment: (assigned!.event as Extract<ThreadEnvelope["event"], { type: "order.assigned" }>).assignment,
        ownerHostId: expect.any(String),
        orderCreatedEventId: created.eventId,
        assignmentEventId: assigned!.eventId,
      });
      delivered = true;
    });

    const result = await caller.ask({ body: "write the parser", to: "worker" });
    expect(result.decision.targets).toEqual([worker.rec.agentId]);
    expect(delivered).toBe(true);
  });

  it("reuses a journaled assignment if dispatch was interrupted after append", async () => {
    const daemon = await startDaemon("assignment-retry", { mode: "root" });
    cleanup.push(daemon.stop);
    const worker = await barista(daemon.addr, identity("worker"));
    cleanup.push(() => worker.client.close());
    const caller = await customer(daemon.addr);
    cleanup.push(() => caller.close());
    const internal = daemon.daemon as unknown as {
      tracking: Map<string, { order: { threadId: string } }>;
      dispatch: (tracking: { order: { threadId: string } }, agentId: string) => void;
    };
    const append = daemon.daemon.store.appendEvent.bind(daemon.daemon.store);
    const spy = vi.spyOn(daemon.daemon.store, "appendEvent").mockImplementation((file, event) => {
      const bytes = append(file, event);
      if (event.event.type === "order.assigned") throw new Error("interrupted after append");
      return bytes;
    });
    try {
      await expect(caller.ask({ body: "write the parser", to: "worker" })).rejects.toThrow("interrupted after append");
    } finally {
      spy.mockRestore();
    }
    const tracking = [...internal.tracking.values()][0]!;
    internal.dispatch(tracking, worker.rec.agentId);
    const { events } = daemon.daemon.thread(tracking.order.threadId)!;
    expect(events.filter(({ event }) => event.type === "order.assigned")).toHaveLength(1);
  });

  it("rejects reuse of an assignment ID for a different target payload", () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-assignment-conflict-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new Store(home);
    const file = store.threadFile("thread-1", 100);
    const assignment: OrderAssignment = {
      assignmentId: "assignment-1",
      targetAgentId: "agent-1",
      targetHostId: "host-1",
      body: "do the task",
      history: [],
      bodyHash: "a".repeat(64),
    };
    store.appendEvent(file, envelope({ type: "order.assigned", assignment }));

    expect(() => store.appendEvent(file, envelope({
      type: "order.assigned",
      assignment: { ...assignment, targetAgentId: "agent-2", body: "different task", bodyHash: "b".repeat(64) },
    }, "assigned-conflict"))).toThrow(/assignment.*conflict/i);
  });
});

function envelope(event: ThreadEnvelope["event"], eventId = "assigned-1"): ThreadEnvelope {
  return {
    eventId,
    threadId: "thread-1",
    orderId: "order-1",
    host: "owner",
    eventHostId: "owner-host-id",
    at: 100,
    event,
  };
}
