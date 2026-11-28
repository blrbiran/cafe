import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Order, OrderAssignment, ThreadEnvelope } from "@cafe/protocol";
import { Store, type RecipientAssignmentRecord, type RecipientAssignmentReceipt } from "../packages/daemon/src/store.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "cafe-assignment-inbox-"));
}

const assignment: OrderAssignment = {
  assignmentId: "assignment-1",
  targetAgentId: "agent-1",
  targetHostId: "host-1",
  body: "do the task",
  history: [],
  bodyHash: "body-hash-1",
};

const recipientRecord: RecipientAssignmentRecord = {
  ...assignment,
  orderId: "order-1",
  threadId: "thread-1",
  receivedAt: 100,
  deadlineAt: Date.now() + 60_000,
};

const receipt: RecipientAssignmentReceipt = {
  assignmentId: assignment.assignmentId,
  agentId: assignment.targetAgentId,
  acceptedAt: 101,
};

function env(event: ThreadEnvelope["event"], orderId = "order-1", eventId = `event-${event.type}`): ThreadEnvelope {
  return {
    eventId,
    threadId: "thread-1",
    orderId,
    host: "owner",
    eventHostId: "owner-host-id",
    at: 100,
    event,
  };
}

describe("Store recipient assignment inbox", () => {
  it("persists one assignment and its acceptance receipt across Store restart", () => {
    const path = home();
    const store = new Store(path);
    expect(store.putRecipientAssignment(recipientRecord)).toEqual(recipientRecord);
    expect(store.putRecipientAssignmentReceipt(receipt)).toEqual(receipt);

    const reloaded = new Store(path);
    expect(reloaded.getRecipientAssignment(assignment.assignmentId)).toEqual(recipientRecord);
    expect(reloaded.getRecipientAssignmentReceipt(assignment.assignmentId)).toEqual(receipt);
  });

  it("returns the prior assignment and receipt on exact duplicate, but rejects ID reuse with changed data", () => {
    const store = new Store(home());
    store.putRecipientAssignment(recipientRecord);
    store.putRecipientAssignmentReceipt(receipt);

    expect(store.putRecipientAssignment(recipientRecord)).toEqual(recipientRecord);
    expect(store.putRecipientAssignmentReceipt(receipt)).toEqual(receipt);
    const reorderedAssignment: RecipientAssignmentRecord = {
      assignmentId: recipientRecord.assignmentId,
      orderId: recipientRecord.orderId,
      threadId: recipientRecord.threadId,
      targetAgentId: recipientRecord.targetAgentId,
      targetHostId: recipientRecord.targetHostId,
      bodyHash: recipientRecord.bodyHash,
      body: recipientRecord.body,
      history: recipientRecord.history,
      receivedAt: recipientRecord.receivedAt,
      deadlineAt: recipientRecord.deadlineAt,
    };
    expect(store.putRecipientAssignment(reorderedAssignment)).toEqual(recipientRecord);
    expect(store.putRecipientAssignmentReceipt({ acceptedAt: receipt.acceptedAt, agentId: receipt.agentId, assignmentId: receipt.assignmentId })).toEqual(receipt);
    expect(() => store.putRecipientAssignment({ ...recipientRecord, body: "changed" })).toThrow(/assignment.*conflict/i);
    expect(() => store.putRecipientAssignmentReceipt({ ...receipt, agentId: "agent-2" })).toThrow(/receipt.*conflict/i);
  });

  it("requires a matching inbox assignment before persisting the target Agent receipt", () => {
    const store = new Store(home());
    expect(() => store.putRecipientAssignmentReceipt(receipt)).toThrow(/assignment.*not found/i);

    store.putRecipientAssignment(recipientRecord);
    expect(() => store.putRecipientAssignmentReceipt({ ...receipt, agentId: "agent-2" })).toThrow(/target Agent/i);
  });

  it("reclaims only expired recipient assignments and their receipts", () => {
    const store = new Store(home());
    const expired: RecipientAssignmentRecord = { ...recipientRecord, assignmentId: "expired", deadlineAt: 99 };
    const live: RecipientAssignmentRecord = { ...recipientRecord, assignmentId: "live", deadlineAt: 101 };
    store.putRecipientAssignment(expired);
    store.putRecipientAssignmentReceipt({ ...receipt, assignmentId: "expired" });

    expect(store.reclaimExpiredRecipientAssignments(99 + 5 * 60_000 - 1)).toBe(0);
    expect(store.reclaimExpiredRecipientAssignments(99 + 5 * 60_000)).toBe(1);
    store.putRecipientAssignment(live);
    store.putRecipientAssignmentReceipt({ ...receipt, assignmentId: "live" });
    expect(store.getRecipientAssignment("expired")).toBeUndefined();
    expect(store.getRecipientAssignmentReceipt("expired")).toBeUndefined();
    expect(store.getRecipientAssignment("live")).toEqual(live);
    expect(store.getRecipientAssignmentReceipt("live")).toEqual({ ...receipt, assignmentId: "live" });
  });

  it("keeps the recipient inbox below its fixed capacity", () => {
    const store = new Store(home());
    for (let i = 0; i < 4999; i++) {
      store.putRecipientAssignment({
        ...recipientRecord,
        assignmentId: `assignment-${i}`,
        receivedAt: i,
      });
    }
    const expired = { ...recipientRecord, assignmentId: "assignment-expired", deadlineAt: Date.now() - 10 * 60_000 };
    store.putRecipientAssignment(expired);
    store.putRecipientAssignmentReceipt({ ...receipt, assignmentId: expired.assignmentId });

    store.putRecipientAssignment({ ...recipientRecord, assignmentId: "assignment-at-capacity" });
    expect(store.getRecipientAssignment(expired.assignmentId)).toBeUndefined();
    expect(store.getRecipientAssignmentReceipt(expired.assignmentId)).toBeUndefined();
    expect(() => store.putRecipientAssignment({
      ...recipientRecord,
      assignmentId: "assignment-over-capacity",
      receivedAt: 5000,
    })).toThrow(/inbox is full/i);
  });

  it("looks up only the exact assignment under its authoritative Order ID", () => {
    const store = new Store(home());
    const file = store.threadFile("thread-1", 100);
    store.appendEvent(file, env({ type: "order.assigned", assignment }, "order-1", "event-assigned-1"));
    store.appendEvent(file, env({ type: "order.assigned", assignment: { ...assignment, assignmentId: "assignment-2" } }, "order-1", "event-assigned-2"));

    expect(store.getOrderAssignment(file, "order-1", "assignment-1")).toEqual({
      orderId: "order-1",
      threadId: "thread-1",
      assignment,
    });
    expect(store.getOrderAssignment(file, "order-other", "assignment-1")).toBeUndefined();
    expect(store.getOrderAssignment(file, "order-1", "missing")).toBeUndefined();
  });

  it("finds assignment IDs nested in a durable replacement event only for the replacement Order", () => {
    const store = new Store(home());
    const file = store.threadFile("thread-1", 100);
    const replacementOrder: Order = {
      orderId: "order-new",
      threadId: "thread-1",
      kind: "order",
      from: { id: "requester", address: "requester", host: "owner" },
      body: "replacement",
      createdAt: 100,
      chain: [],
      depth: 0,
      turn: 1,
      history: [],
    };
    const replacement: ThreadEnvelope["event"] = {
      type: "order.replaced",
      previousOrderId: "order-old",
      order: replacementOrder,
      decision: { targets: [], mode: "unicast", reason: "test", router: "rules", candidates: [] },
      assignments: [assignment],
    };
    store.appendEvent(file, env(replacement, "order-new"));

    expect(store.getOrderAssignment(file, "order-new", "assignment-1")).toEqual({
      orderId: "order-new",
      threadId: "thread-1",
      assignment,
    });
    expect(store.getOrderAssignment(file, "order-old", "assignment-1")).toBeUndefined();
    const wrongThreadReplacement: ThreadEnvelope["event"] = {
      ...replacement,
      order: { ...replacementOrder, orderId: "order-wrong-thread", threadId: "thread-other" },
      assignments: [{ ...assignment, assignmentId: "assignment-wrong-thread" }],
    };
    store.appendEvent(file, env(wrongThreadReplacement, "order-wrong-thread", "event-replacement-wrong-thread"));
    expect(store.getOrderAssignment(file, "order-wrong-thread", "assignment-wrong-thread")).toBeUndefined();
  });
});
