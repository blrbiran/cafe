import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/daemon/src/store.ts";

// #68: `outcomes()` selected every row of the last 7 days and filtered in JS; the Root runs it every
// 30 s on a table that is never pruned by default (200k rows ≈ 258 ms of blocked event loop).
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("routing hint aggregation (#68)", () => {
  it("aggregates counts and recent decline topics in SQL", () => {
    const d = mkdtempSync(join(tmpdir(), "cafe-hints-"));
    dirs.push(d);
    const s = new Store(d);
    const now = Date.now();
    s.recordAgentEvent("a1", "answered", now - 1000, "t1", { identity: "docs@root", tokens: ["readme"] });
    s.recordAgentEvent("a1", "answered", now - 2000, "t2", { identity: "docs@root", tokens: ["readme"] });
    s.recordAgentEvent("a2", "declined", now - 3000, "t3", { identity: "billing@root", tokens: ["refund", "vat"] });
    s.recordAgentEvent("a2", "failed", now - 4000, "t4", { identity: "billing@root" });
    // Outside the window: must not count.
    s.recordAgentEvent("a1", "answered", now - 9 * 24 * 3600_000, "t5", { identity: "docs@root", tokens: ["old"] });

    const rows = s.outcomeSummary(now - 7 * 24 * 3600_000);
    const docs = rows.find((r) => r.identity === "docs@root")!;
    const billing = rows.find((r) => r.identity === "billing@root")!;
    expect(docs).toMatchObject({ answered: 2, declined: 0, failed: 0 });
    expect(billing).toMatchObject({ answered: 0, declined: 1, failed: 1 });
    expect(billing.declinedTopics).toEqual(expect.arrayContaining(["refund", "vat"]));
    expect(billing.declinedAt).toBe(now - 3000);
  });

  it("returns only the most recent decline topics per identity, bounded", () => {
    const d = mkdtempSync(join(tmpdir(), "cafe-hints-"));
    dirs.push(d);
    const s = new Store(d);
    const now = Date.now();
    for (let i = 0; i < 40; i++) s.recordAgentEvent("a1", "declined", now - i * 1000, `t${i}`, { identity: "x@root", tokens: [`topic${i}`] });
    const [row] = s.outcomeSummary(now - 24 * 3600_000, { declineTopicRows: 5 });
    expect(row!.declinedTopics!.length).toBeLessThanOrEqual(5 * 12);
  });
});