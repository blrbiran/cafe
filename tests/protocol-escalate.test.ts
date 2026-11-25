import { describe, expect, it } from "vitest";
import { ChannelName, CreateOrderParams, RoutingDecision, SubOrderFailure, channelsOf } from "@cafe/protocol";

describe("v4-11 protocol additions", () => {
  it("carries explicit escalation and the parent Thread", () => {
    const p = CreateOrderParams.parse({ body: "why?", parentOrderId: "o1", parentThreadId: "t1", escalate: true });
    expect(p).toMatchObject({ parentOrderId: "o1", parentThreadId: "t1", escalate: true });
  });

  it("does not invent escalate on a legacy parentOrderId", () => {
    const p = CreateOrderParams.parse({ body: "legacy", parentOrderId: "o1" });
    expect(p.escalate).toBeUndefined();
  });

  it("carries a machine-readable sub-order failure", () => {
    const d = RoutingDecision.parse({ targets: [], mode: "unicast", reason: "parent is offline", router: "explicit", failure: "parent_offline" });
    expect(d.failure).toBe("parent_offline");
    expect(SubOrderFailure.options).toContain("no_channel_members");
    expect(() => RoutingDecision.parse({ targets: [], mode: "unicast", reason: "x", router: "explicit", failure: "whatever" })).toThrow();
  });

  it("treats an Agent with no channels as default-only", () => {
    expect(channelsOf({})).toEqual(["default"]);
    expect(channelsOf({ channels: ["team"] })).toEqual(["team"]);
  });

  it("rejects invalid channel names", () => {
    expect(ChannelName.parse("myproj-dev")).toBe("myproj-dev");
    expect(() => ChannelName.parse("my.proj")).toThrow();
    expect(() => ChannelName.parse("default ")).toThrow();
  });
});