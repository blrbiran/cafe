import { describe, expect, it } from "vitest";
import * as protocol from "@cafe/protocol";

const id = "01J11111111111111111111111";
const hostId = "01J22222222222222222222222";

describe("Host and caller authorization protocol", () => {
  it("defines stable Host identities separately from routing slugs", () => {
    expect(protocol.HostIdentity.parse({
      hostId,
      host: "laptop",
      keyFingerprint: "AA:BB:CC",
      state: "enrolled",
    })).toEqual({
      hostId,
      host: "laptop",
      keyFingerprint: "AA:BB:CC",
      state: "enrolled",
    });
  });

  it("only advertises the implemented authorization capabilities", () => {
    expect(protocol.CURRENT_FEATURES).toContain("host-auth-v1");
    expect(protocol.FEATURES).toContain("caller-auth-v1");
    expect(protocol.CURRENT_FEATURES).not.toContain("caller-auth-v1");
    expect(protocol.CURRENT_FEATURES).not.toContain("team-roster-ack-v1");
    expect(protocol.PROTOCOL_VERSION).toBe(1);
  });

  it("accepts legacy envelopes while retaining authenticated source and actor on new envelopes", () => {
    const legacy = protocol.ThreadEnvelope.parse({
      eventId: "legacy-event",
      threadId: "thread-1",
      orderId: "order-1",
      host: "laptop",
      at: 1,
      event: { type: "order.created", order: {
        orderId: "order-1",
        threadId: "thread-1",
        kind: "order",
        from: { id: "cli:legacy", address: "cli@laptop", host: "laptop" },
        body: "legacy question",
        createdAt: 1,
      } },
    });
    expect(legacy.eventHostId).toBeUndefined();
    expect(legacy.actor).toBeUndefined();

    const current = protocol.ThreadEnvelope.parse({
      ...legacy,
      eventId: "current-event",
      eventHostId: hostId,
      actor: { kind: "human", principalId: "principal-1" },
    });
    expect(current).toMatchObject({
      eventHostId: hostId,
      actor: { kind: "human", principalId: "principal-1" },
    });
  });

  it("requires assignment identity on new assignment and delivery records", () => {
    expect(protocol.ThreadEvent.parse({
      type: "order.assigned",
      assignment: {
        assignmentId: id,
        targetAgentId: "agent-1",
        targetHostId: hostId,
        body: "question",
        bodyHash: "sha256:abc",
      },
    })).toMatchObject({ type: "order.assigned", assignment: { assignmentId: id, targetHostId: hostId } });

    expect(protocol.ThreadEvent.parse({
      type: "order.delivered",
      agentId: "agent-1",
      assignmentId: id,
    })).toMatchObject({ type: "order.delivered", assignmentId: id });
  });

  it("represents replacements and operator overrides as distinct events", () => {
    expect(protocol.ThreadEvent.parse({
      type: "order.replaced",
      previousOrderId: "order-old",
      order: {
        orderId: "order-new",
        threadId: "thread-1",
        kind: "order",
        from: { id: "cli:human", address: "person@laptop", host: "laptop" },
        body: "new question",
        createdAt: 2,
      },
      decision: { targets: ["agent-1"], mode: "unicast", reason: "explicit", router: "explicit", candidates: [] },
      assignments: [{ assignmentId: id, targetAgentId: "agent-1", targetHostId: hostId, body: "new question", history: [] }],
    })).toMatchObject({ type: "order.replaced", previousOrderId: "order-old", order: { orderId: "order-new" }, assignments: [{ assignmentId: id }] });

    expect(protocol.ThreadEvent.parse({
      type: "order.overridden",
      targetAgentId: "agent-1",
      text: "operator answer",
      final: true,
    })).toMatchObject({ type: "order.overridden", targetAgentId: "agent-1", final: true });
  });

  it("carries a one-use owner attestation on a human follow-up Order", () => {
    const order = protocol.Order.parse({
      orderId: "order-answer",
      threadId: "thread-clarification",
      kind: "order",
      from: { id: "human-1", address: "person@laptop", host: "laptop" },
      body: "answer",
      createdAt: 1,
      turn: 2,
      parentOrderId: "order-parent",
      parentThreadId: "thread-parent",
      parentOwnerAttestation: {
        attestationId: id,
        parentOrderId: "order-parent",
        parentThreadId: "thread-parent",
        clarificationOrderId: "order-clarification",
        recipientAgentId: "agent-1",
        recipientHostId: hostId,
        answerRequestId: "answer-request-1",
        answerHash: "sha256:answer",
      },
    });
    expect(order.parentOwnerAttestation?.attestationId).toBe(id);
  });

  it("carries an exact replaceOrderId for follow-up transitions", () => {
    const params = protocol.CreateOrderParams.parse({ body: "follow up", threadId: "thread-1", replaceOrderId: "order-old" });
    expect(params.replaceOrderId).toBe("order-old");
  });

  it("models operator override as a terminal target state", () => {
    expect(protocol.TargetState.parse("overridden")).toBe("overridden");
  });
});
