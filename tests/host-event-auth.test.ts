import { describe, expect, it } from "vitest";
import { assertAgentEventActor, assertAgentEventAuthority } from "../packages/daemon/src/daemon.ts";
import type { ThreadEnvelope } from "@cafe/protocol";

function agentEvent(actor?: ThreadEnvelope["actor"]): ThreadEnvelope {
  return {
    eventId: "event-1",
    threadId: "thread-1",
    orderId: "order-1",
    host: "child",
    eventHostId: "child-host-id",
    ...(actor ? { actor } : {}),
    at: 1,
    event: { type: "order.replied", agentId: "agent-target", text: "answer", final: true },
  };
}

describe("authenticated Host event ingress", () => {
  it("rejects an Agent event whose actor differs from its event Agent", () => {
    expect(() => assertAgentEventActor(agentEvent({ kind: "agent", principalId: "agent-other" })))
      .toThrow(/actor|Agent/i);
  });

  it("rejects authenticated Agent events without an Agent actor", () => {
    expect(() => assertAgentEventActor(agentEvent())).toThrow(/actor|Agent/i);
  });

  it("rejects an Agent event when the authenticated source Host is not its registered Host", () => {
    const env = agentEvent({ kind: "agent", principalId: "agent-target" });
    expect(() => assertAgentEventAuthority(env, "host-other", () => "child"))
      .toThrow(/registered Host/i);
    expect(assertAgentEventAuthority(env, "child", () => "child")).toBe("agent-target");
  });

  it("returns the exact Agent ID only when the actor matches", () => {
    expect(assertAgentEventActor(agentEvent({ kind: "agent", principalId: "agent-target" })))
      .toBe("agent-target");
  });
});
