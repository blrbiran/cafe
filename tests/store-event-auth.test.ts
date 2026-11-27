import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import { Store } from "../packages/daemon/src/store.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "cafe-auth-store-"));
}

const envelope = (eventId: string, orderId: string, event: unknown): ThreadEnvelope => ({
  eventId,
  threadId: "thread-1",
  orderId,
  host: "laptop",
  eventHostId: "01J22222222222222222222222",
  actor: { kind: "agent", principalId: "agent-1" },
  at: 1,
  event,
} as ThreadEnvelope);

describe("Store auth journal indexes", () => {
  it("indexes one replacement event under both the old and new Order IDs", () => {
    const store = new Store(home());
    const file = store.threadFile("thread-1", 1);
    store.appendEvent(file, envelope("created-old", "order-old", {
      type: "order.created",
      order: { orderId: "order-old", threadId: "thread-1" },
    }));
    store.appendEvent(file, envelope("replace-1", "order-new", {
      type: "order.replaced",
      previousOrderId: "order-old",
      order: { orderId: "order-new", threadId: "thread-1" },
      assignmentIds: ["assignment-1"],
    }));

    expect(store.readOrderEvents(file, "order-old").map((row) => row.eventId)).toEqual(["created-old", "replace-1"]);
    expect(store.readOrderEvents(file, "order-new").map((row) => row.eventId)).toEqual(["replace-1"]);
  });

  it("durably stages an event until its authoritative Order/assignment arrives", () => {
    const path = home();
    const store = new Store(path);
    const pending = envelope("late-reply", "order-1", {
      type: "order.replied",
      agentId: "agent-1",
      assignmentId: "assignment-1",
      text: "answer",
      final: true,
    });
    store.stagePendingEvent(pending, { kind: "assignment", id: "assignment-1" });
    expect(store.listPendingEvents("thread-1").map((row) => row.eventId)).toEqual(["late-reply"]);

    const recovered = new Store(path);
    const file = recovered.threadFile("thread-1", 1);
    recovered.commitPendingEvents(file, ["late-reply"]);
    recovered.commitPendingEvents(file, ["late-reply"]);

    expect(recovered.readEvents(file).map((row) => row.eventId)).toEqual(["late-reply"]);
    expect(recovered.listPendingEvents("thread-1")).toEqual([]);
  });
});
