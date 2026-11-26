import { describe, expect, it } from "vitest";
import type { ThreadMeta } from "@cafe/protocol";
import { projectTaskStatus } from "@cafe/protocol";
import { dictFor } from "../packages/web/src/i18n.ts";
import { bucketOf, outcome } from "../packages/web/src/outcome.ts";
import { mergeProjectedMeta } from "../packages/web/src/store.ts";

const parent = (overrides: Partial<ThreadMeta> = {}): ThreadMeta => ({
  threadId: "parent",
  orderId: "parent-order",
  kind: "order",
  from: { id: "cli:owner", address: "cli@solo", host: "solo" },
  origin: "human",
  targets: ["lead"],
  status: "done",
  summary: "human task",
  summaryTurn: 1,
  createdAt: 1,
  file: "/sessions/parent.jsonl",
  turns: 1,
  replies: [{ agentId: "lead", address: "lead@solo", text: "delegated", at: 2 }],
  declines: [],
  ...overrides,
});

const child = (overrides: Partial<ThreadMeta> = {}): ThreadMeta => ({
  threadId: "child",
  orderId: "child-order",
  kind: "order",
  channel: "default",
  parentThreadId: "parent",
  parentOrderId: "parent-order",
  from: { id: "lead-id", address: "lead@solo", host: "solo" },
  origin: "agent",
  targets: ["dev"],
  status: "working",
  summary: "implementation",
  summaryTurn: 1,
  createdAt: 3,
  file: "/sessions/child.jsonl",
  turns: 1,
  replies: [],
  declines: [],
  ...overrides,
});

describe("projectTaskStatus", () => {
  it("reports working while a linked child is open, even if the parent Order is terminal", () => {
    expect(projectTaskStatus(parent({ status: "failed" }), [child()])).toBe("working");
  });

  it("reports unknown for a partial view when visible linked work is already closed", () => {
    expect(projectTaskStatus(parent(), [child({ status: "done", closedAt: 10 })], true)).toBe("unknown");
  });

  it("still reports working when a partial view shows a running child", () => {
    expect(projectTaskStatus(parent(), [child()], true)).toBe("working");
  });

  it("does not label an ordinary conversation unknown when its child view is partial", () => {
    expect(projectTaskStatus(parent(), [], true)).toBeUndefined();
  });

  it("ignores children linked to a prior parent Order turn", () => {
    expect(projectTaskStatus(parent(), [child({ parentOrderId: "previous-order" })])).toBeUndefined();
  });

  it("does not count a human clarification as delegated work", () => {
    expect(projectTaskStatus(parent(), [child({ clarification: { orderId: "clarification", question: "need a choice?" } })])).toBeUndefined();
  });

  it("waits for a report after agent work closes and marks the exact reported Order done", () => {
    const closedChild = child({ status: "done", closedAt: 10 });
    expect(projectTaskStatus(parent(), [closedChild])).toBe("awaiting_report");
    expect(projectTaskStatus(parent({ reportedOrderId: "parent-order" }), [closedChild])).toBe("done");
    expect(projectTaskStatus(parent({ reportedOrderId: "previous-order" }), [closedChild])).toBe("awaiting_report");
  });

  it("uses the direct Order status after an agent-owned child closes", () => {
    const agentParent = parent({ from: { id: "front-door", address: "front-door@solo", host: "solo" }, origin: "agent" });
    expect(projectTaskStatus(agentParent, [child({ status: "done", closedAt: 10 })])).toBe("done");
  });

  it("uses done after an owner-created child closes without requiring a front-door report", () => {
    expect(projectTaskStatus(parent(), [child({ from: { id: "cli:owner", address: "cli@solo", host: "solo" }, origin: "human", status: "done", closedAt: 10 })])).toBe("done");
  });

  it("preserves projected parent state when an event supplies raw metadata for the same Order", () => {
    const previous = parent({ taskStatus: "working", pendingChildren: 1, childrenPartial: false });
    const incoming = parent({ status: "done", taskStatus: undefined, pendingChildren: undefined, childrenPartial: undefined });
    expect(mergeProjectedMeta(previous, incoming)).toMatchObject({ status: "done", taskStatus: "working", pendingChildren: 1, childrenPartial: false });
  });

  it("drops a prior task projection when a new parent Order turn starts", () => {
    const previous = parent({ taskStatus: "awaiting_report", reportedOrderId: "parent-order" });
    const next = parent({ orderId: "next-order", taskStatus: undefined, reportedOrderId: undefined });
    expect(mergeProjectedMeta(previous, next).taskStatus).toBeUndefined();
  });

  it.each([
    ["working", "Delegated work is still running", "info"],
    ["awaiting_report", "Delegated work finished; waiting for the front-door report", "warn"],
    ["unknown", "Task status is incomplete in this view", "warn"],
  ] as const)("shows parent taskStatus %s on a completed Order", (taskStatus, text, tone) => {
    const meta = parent({ taskStatus });
    const labels = dictFor("en");
    expect(bucketOf(meta)).toBe("active");
    expect(outcome(labels, meta, {}, undefined, 10)).toMatchObject({ text, tone });
  });

  it.each(["zh", "en"] as const)("uses task labels from the %s dictionary", (lang) => {
    const labels = dictFor(lang);
    const working = outcome(labels, parent({ taskStatus: "working" }), {}, undefined, 10);
    const waiting = outcome(labels, parent({ taskStatus: "awaiting_report" }), {}, undefined, 10);
    const unknown = outcome(labels, parent({ taskStatus: "unknown" }), {}, undefined, 10);
    if (lang === "zh") {
      expect(working.text).toBe("子任务仍在进行");
      expect(waiting.text).toBe("子任务已完成，等待前门汇报");
      expect(unknown.text).toBe("此视图中的子任务状态不完整");
    } else {
      expect(working.text).toBe("Delegated work is still running");
      expect(waiting.text).toBe("Delegated work finished; waiting for the front-door report");
      expect(unknown.text).toBe("Task status is incomplete in this view");
    }
  });
});
