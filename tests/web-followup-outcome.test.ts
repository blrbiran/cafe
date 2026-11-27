import { describe, expect, it } from "vitest";
import type { ThreadMeta } from "@cafe/protocol";
import { dictFor } from "../packages/web/src/i18n.ts";
import { bucketOf, followupAnswer, followupPreviewText, followupSearchPreview, outcome, whoAddress } from "../packages/web/src/outcome.ts";

const meta = (overrides: Partial<ThreadMeta> = {}): ThreadMeta => ({
  threadId: "thread", orderId: "follow", kind: "order", from: { id: "web:owner", address: "web@root", host: "root" },
  targets: [], status: "failed", summary: "question", summaryTurn: 2, createdAt: 1, file: "/sessions/thread.jsonl", turns: 2,
  replies: [], declines: [], followupOutcome: { orderId: "follow", answer: { orderId: "first", turn: 1, agentId: "operator-id", address: "operator@root", source: "operator", text: "earlier answer", truncated: true } },
  ...overrides,
});

describe("follow-up Feed and search interpretation", () => {
  it("includes an exact failed follow-up with a historical answer in Answered", () => {
    expect(bucketOf(meta())).toBe("answered");
    expect(followupAnswer(meta())).toMatchObject({ orderId: "first", source: "operator", truncated: true });
  });

  it.each([
    ["zh", "已回答 · 追问未送达"],
    ["en", "Answered · Follow-up not delivered"],
  ] as const)("shows the follow-up outcome label in %s", (lang, label) => {
    expect(outcome(dictFor(lang), meta(), {}, undefined, 10)).toMatchObject({ text: label, tone: "warn" });
  });

  it("keeps active task status ahead of the historical answer", () => {
    const current = meta({ taskStatus: "working" });
    expect(bucketOf(current)).toBe("active");
    expect(outcome(dictFor("en"), current, {}, undefined, 10).text).toBe("Delegated work is still running");
  });

  it("ignores stale follow-up projections after the current Order changes", () => {
    const stale = meta({ orderId: "new-order" });
    expect(followupAnswer(stale)).toBeUndefined();
    expect(bucketOf(stale)).toBe("unanswered");
  });

  it("keeps the operator identity and appends a view ellipsis for truncated previews", () => {
    const answer = followupAnswer(meta())!;
    expect(answer.source).toBe("operator");
    expect(answer.address).toBe("operator@root");
    expect(whoAddress(answer.agentId, {}, meta())).toBe("operator@root");
    expect(followupPreviewText(answer)).toBe("earlier answer…");
  });

  it("shows historical search preview for a question hit, but avoids a duplicate answer hit", () => {
    expect(followupSearchPreview(meta(), [{ orderId: "follow", text: "question", at: 4, who: "you" }])).toBe(true);
    expect(followupSearchPreview(meta(), [{ orderId: "first", text: "earlier answer", at: 2, who: "operator@root" }])).toBe(false);
  });
});
