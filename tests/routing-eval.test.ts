import { describe, expect, it } from "vitest";
import type { RoutingHint } from "@cafe/protocol";
import { RulesRouter } from "../packages/daemon/src/router.ts";
import { computeHints, identityOf, orderKeywords, type OutcomeRow } from "../packages/daemon/src/hints.ts";
import { EVAL_CASES, agentRecords, evalOrder } from "./routing-fixtures.ts";

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
  const out: { body: string; expected: string[]; mode: string; got: string; clear: boolean }[] = [];
  for (const c of EVAL_CASES) {
    const d = await router.decide({ order: evalOrder(c.q), candidates: BARISTAS, hints });
    const got = d.mode === "unicast" ? BARISTAS.find((b) => b.agentId === d.targets[0])!.name : d.mode;
    out.push({ body: c.q, expected: c.expect, mode: c.mode ?? "unicast", got, clear: !!c.clear });
  }
  return out;
}

const acc = (rs: Awaited<ReturnType<typeof run>>) => rs.filter((r) => (r.mode === "broadcast" ? r.got === "broadcast" : r.got === r.expected[0])).length;

describe("routing eval (rules)", () => {
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
    expect(after.filter((r) => !r.clear).every((r) => (r.mode === "broadcast" ? r.got === "broadcast" : r.got === r.expected[0]))).toBe(true);
  });
});