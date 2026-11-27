import { describe, expect, it } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import { projectFollowupOutcomes } from "../packages/daemon/src/followup-outcome.ts";

const env = (eventId: string, orderId: string, event: ThreadEnvelope["event"], at = 1): ThreadEnvelope => ({
  eventId, threadId: "thread", orderId, host: "root", at, event,
} as ThreadEnvelope);
const created = (orderId: string, turn: number) => env(`${orderId}-created`, orderId, {
  type: "order.created",
  order: { orderId, threadId: "thread", kind: "order", from: { id: "cli:user", address: "cli@root", host: "root" }, body: `question ${turn}`, chain: [], depth: 0, createdAt: turn, turn, history: [] },
});
const routed = (orderId: string, targets: string[]) => env(`${orderId}-routed`, orderId, {
  type: "order.routed", decision: { targets, mode: "unicast", reason: "no recipient", router: "explicit", candidates: [] },
});
const reply = (orderId: string, text: string, options: { agentId?: string; source?: "operator" | "agent"; final?: boolean } = {}) => env(`${orderId}-reply-${text}`, orderId, {
  type: "order.replied", agentId: options.agentId ?? "agent-1", text, final: options.final ?? true, ...(options.source ? { source: options.source } : {}),
} as ThreadEnvelope["event"]);
const closed = (orderId: string, status: "done" | "failed" | "cancelled") => env(`${orderId}-closed`, orderId, { type: "order.closed", status });

const baseline = [created("first", 1), reply("first", "prior answer", { agentId: "agent-1" }), closed("first", "done")];

describe("follow-up answer projection", () => {
  it("keeps the prior answer beside the exact failed empty-route follow-up", () => {
    const result = projectFollowupOutcomes([...baseline, created("follow", 2), routed("follow", []), closed("follow", "failed")], "follow", "failed");
    expect(result).toEqual({
      lastAnswer: { orderId: "first", turn: 1, agentId: "agent-1", text: "prior answer", truncated: false },
      followupOutcome: { orderId: "follow", answer: { orderId: "first", turn: 1, agentId: "agent-1", text: "prior answer", truncated: false } },
    });
  });

  it("selects the last appended final in the greatest eligible prior turn", () => {
    const events = [...baseline, created("second", 2), reply("second", "first answer two"), reply("second", "last answer two"), closed("second", "done"), created("third", 3), routed("third", []), closed("third", "failed")];
    expect(projectFollowupOutcomes(events, "third", "failed").followupOutcome?.answer).toMatchObject({ orderId: "second", turn: 2, text: "last answer two" });
  });

  it("does not turn a post-close late final into the conversation answer", () => {
    const result = projectFollowupOutcomes([created("first", 1), reply("first", "audit late", { agentId: "late" }), closed("first", "failed"), reply("first", "arrived after close", { agentId: "late" }), created("follow", 2), routed("follow", []), closed("follow", "failed")], "follow", "failed");
    expect(result.lastAnswer).toBeUndefined();
  });

  it("does not infer an empty route when the routed event is absent", () => {
    const events = [...baseline, created("follow", 2), closed("follow", "failed")];
    expect(projectFollowupOutcomes(events, "follow", "failed").followupOutcome).toBeUndefined();
  });

  it("does not infer an explicit empty route from an order replacement decision", () => {
    const order = { orderId: "follow", threadId: "thread", kind: "order" as const, from: { id: "cli:user", address: "cli@root", host: "root" }, body: "question 2", chain: [], depth: 0, createdAt: 2, turn: 2, history: [] };
    const replaced = env("replaced", "follow", { type: "order.replaced", previousOrderId: "older", order, decision: { targets: [], mode: "unicast", reason: "empty", router: "explicit", candidates: [] }, assignments: [] });
    expect(projectFollowupOutcomes([...baseline, replaced, closed("follow", "failed")], "follow", "failed").followupOutcome).toBeUndefined();
  });

  it("does not classify a routed timeout with targets as an undelivered follow-up", () => {
    const events = [...baseline, created("follow", 2), routed("follow", ["offline"]), closed("follow", "failed")];
    expect(projectFollowupOutcomes(events, "follow", "failed").followupOutcome).toBeUndefined();
  });

  it("keeps operator provenance and truncates at 300 UTF-16 units without splitting a pair", () => {
    const text = `${"a".repeat(299)}😀tail`;
    const events = [created("first", 1), reply("first", text, { agentId: "operator", source: "operator" }), closed("first", "done"), created("follow", 2), routed("follow", []), closed("follow", "failed")];
    const answer = projectFollowupOutcomes(events, "follow", "failed").followupOutcome?.answer;
    expect(answer).toMatchObject({ agentId: "operator", source: "operator", text: "a".repeat(299), truncated: true });
    expect(answer?.text.length).toBe(299);
  });

  it("does not replace a newer turn answer with a replayed older turn", () => {
    const events = [...baseline, created("second", 2), reply("second", "newer"), closed("second", "done"), reply("first", "late replay"), created("third", 3), routed("third", []), closed("third", "failed")];
    expect(projectFollowupOutcomes(events, "third", "failed").lastAnswer).toMatchObject({ orderId: "second", text: "newer" });
  });
});
