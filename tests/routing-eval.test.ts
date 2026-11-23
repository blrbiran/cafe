import { describe, expect, it } from "vitest";
import type { RoutingHint } from "@cafe/protocol";
import { RulesRouter, TOP_K, splitClauses } from "../packages/daemon/src/router.ts";
import { computeHints, identityOf, orderKeywords, type OutcomeRow } from "../packages/daemon/src/hints.ts";
import { EVAL_CASES, EXTRA_CASES, TEAM_CASES, agentRecords, evalOrder } from "./routing-fixtures.ts";

/**
 * Routing eval: a fixed set of Baristas and Orders with the expected receiver.
 * Compares the rules router without and with routing hints built from a replayed
 * decline history. Rules only: no model calls. The same fixtures feed
 * `npm run routing:eval` (scripts/router-eval.ts), which can call a real model.
 */

const BARISTAS = agentRecords("h");

/** Mobile declined web-style react hooks questions recently; web answered them. */
function history(now: number): OutcomeRow[] {
  const mobile = identityOf(BARISTAS[0]!);
  const web = identityOf(BARISTAS[1]!);
  const asked = ["react hooks state bug in the dashboard", "react hooks memo question", "useEffect react hooks cleanup"];
  return asked.flatMap((q, i) => [
    { identity: mobile, kind: "declined" as const, at: now - (i + 1) * 3600_000, tokens: orderKeywords(q) },
    { identity: web, kind: "answered" as const, at: now - (i + 1) * 3600_000 + 60_000, tokens: orderKeywords(q) },
  ]);
}

async function run(hints?: Map<string, RoutingHint>) {
  const router = new RulesRouter();
  const out: { body: string; expected: string[]; mode: string; got: string; count: number; clear: boolean; topK: boolean }[] = [];
  for (const c of EVAL_CASES) {
    const d = await router.decide({ order: evalOrder(c.q), candidates: BARISTAS, hints });
    const got = d.mode === "unicast" ? BARISTAS.find((b) => b.agentId === d.targets[0])!.name : d.mode;
    out.push({ body: c.q, expected: c.expect, mode: c.mode ?? "unicast", got, count: d.targets.length, clear: !!c.clear, topK: !!c.topK });
  }
  return out;
}

const pass = (r: { mode: string; got: string; expected: string[]; count: number; topK: boolean }) =>
  r.topK ? r.got === "multicast" && r.count >= 1 && r.count <= TOP_K : r.mode === "broadcast" ? r.got === "broadcast" : r.got === r.expected[0];
const acc = (rs: Awaited<ReturnType<typeof run>>) => rs.filter(pass).length;

describe("routing eval (rules)", () => {
  it("keeps the #39 overlap/morphology/multicast cases available to the eval script", () => {
    expect(EXTRA_CASES.length).toBeGreaterThanOrEqual(9);
    expect(EXTRA_CASES.some((c) => c.mode === "multicast")).toBe(true);
    expect(EXTRA_CASES.some((c) => c.topK)).toBe(true);
    expect(EXTRA_CASES.some((c) => /README/.test(c.q))).toBe(true);
  });

  it("decides every clear case from the description", async () => {
    const rows = await run();
    for (const r of rows) {
      if (!r.clear) continue;
      expect(r.got, r.body).toBe(r.expected[0]);
    }
  });

  it("hints never hurt and fix ambiguous cases", async () => {
    const now = Date.now();
    const byIdentity = computeHints(history(now), now);
    const hints = new Map(BARISTAS.filter((b) => byIdentity[identityOf(b)]).map((b) => [b.agentId, byIdentity[identityOf(b)]!]));

    const before = await run();
    const after = await run(hints);
    console.log(`routing eval: ${acc(before)}/${EVAL_CASES.length} without hints → ${acc(after)}/${EVAL_CASES.length} with hints`);
    for (const r of after) if (r.got !== r.expected[0] && r.mode !== "broadcast") console.log(`  miss: "${r.body}" → ${r.got} (expected ${r.expected[0]})`);

    for (let i = 0; i < EVAL_CASES.length; i++) {
      if (!before[i]!.clear) continue;
      expect(after[i]!.got, after[i]!.body).toBe(before[i]!.got);
    }
    expect(acc(after)).toBeGreaterThanOrEqual(acc(before));
    expect(after.filter((r) => !r.clear).every(pass)).toBe(true);
  });
});
describe("per-target sub-questions in the eval (v4-7 #39)", () => {
  it("splits exactly the explicit two-clause structures, verbatim", () => {
    expect(splitClauses("the refund page is broken, and the invoice total is wrong")).toEqual(["the refund page is broken", "the invoice total is wrong"]);
    expect(splitClauses("页面崩了；发票也不对")).toEqual(["页面崩了", "发票也不对"]);
    expect(splitClauses("页面崩了以及发票也不对")).toEqual(["页面崩了", "发票也不对"]);
    // A bare "and", or a conjunction inside one clause, is not a split.
    expect(splitClauses("the refund page is broken and the invoice total is wrong")).toBeUndefined();
    expect(splitClauses("the refund page is broken")).toBeUndefined();
  });

  it("records a two-clause case that expects variants, and one that must not split", () => {
    expect(EXTRA_CASES.some((c) => c.variants === 2)).toBe(true);
    expect(EXTRA_CASES.some((c) => c.mode === "multicast" && c.variants === undefined)).toBe(true);
  });
});

describe("team cases (#71/#72) are recorded without changing routing", () => {
  it("keeps every team case labelled, and marks the ones waiting on a decision", () => {
    const blocked = TEAM_CASES.filter((c) => c.blocked).map((c) => c.blocked);
    expect(blocked).toEqual(expect.arrayContaining(["D1-escalate", "D2-parallel", "D3-collect-all"]));
    // The two shapes the router can already answer must not be marked blocked.
    expect(TEAM_CASES.filter((c) => !c.blocked).length).toBeGreaterThanOrEqual(2);
    for (const c of TEAM_CASES) if (!c.blocked) expect(c.mode).toBe("multicast");
  });
});
