#!/usr/bin/env node
/**
 * Routing eval. Default is offline (keyword rules, no model, no cost):
 *
 *   npm run routing:eval
 *   npm run routing:eval -- --model magpie/group/smart --repeat 2 --json
 *
 * A `--model` run calls the real model once per case per repeat and costs money;
 * it is never part of `npm test`. Latency is wall-clock per decide() call, and a
 * case that fell back to rules is counted as a fallback (not a silent pass).
 */
import { writeFileSync } from "node:fs";
import { LlmRouter, RulesRouter, TOP_K, piComplete, type Router } from "../packages/daemon/src/router.ts";
import type { RoutingDecision } from "@cafe/protocol";
import { EVAL_CASES, EXTRA_CASES, TEAM_CASES, agentRecords, evalOrder } from "../tests/routing-fixtures.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);

const model = flag("--model");
const repeat = Math.max(1, Number(flag("--repeat") ?? 1));
const json = has("--json");
const outFile = flag("--out");
const timeoutMs = Number(flag("--timeout") ?? 15_000);
const concurrency = Math.max(1, Number(flag("--concurrency") ?? 2));

const baristas = agentRecords("eval");
// Team cases (#71/#72) are recorded but not scored until their decisions land: an old router cannot
// express "ask your leader back" or "wait for everyone", so counting them would only add noise.
const blockedTeamCases = TEAM_CASES.filter((c) => c.blocked);
const cases = [...EVAL_CASES, ...EXTRA_CASES, ...TEAM_CASES.filter((c) => !c.blocked)];

interface Attempt {
  q: string;
  expected: string[];
  mode: string;
  got: string[];
  gotMode: string;
  pass: boolean;
  fallback: boolean;
  ms: number;
  /** How many per-target variants the decision carried (v4-7 #39). */
  variantCount: number;
}

const router: Router = model ? new LlmRouter(await piComplete(model), new RulesRouter(), { timeoutMs, concurrency, cache: false }) : new RulesRouter();

async function once(): Promise<Attempt[]> {
  const out: Attempt[] = [];
  for (const c of cases) {
    const started = performance.now();
    const d: RoutingDecision = await router.decide({ order: evalOrder(c.q), candidates: baristas });
    const ms = performance.now() - started;
    const names = d.targets.map((id) => baristas.find((b) => b.agentId === id && b.name)?.name ?? id.replace(/^id-/, ""));
    const wantMode = c.mode ?? "unicast";
    const pass = c.topK
      ? d.mode === "multicast" && d.targets.length >= 1 && d.targets.length <= TOP_K
      : d.mode === wantMode &&
        (wantMode === "broadcast" ? names.length === baristas.length : wantMode === "unicast" ? names.length === 1 && names[0] === c.expect[0] : c.expect.every((n) => names.includes(n)));
    // A case that expects per-target variants (v4-7 #39) must also carry that many.
    const variantCount = d.variants ? Object.keys(d.variants).length : 0;
    const variantsOk = c.variants === undefined || variantCount === c.variants;
    out.push({ q: c.q, expected: c.expect, mode: wantMode, got: names, gotMode: d.mode, pass: pass && variantsOk, fallback: !!d.llmError, ms, variantCount });
  }
  return out;
}

const runs: Attempt[][] = [];
for (let i = 0; i < repeat; i++) runs.push(await once());
const all = runs.flat();

// Same input, different delivery is a routing bug even when each run "passes":
// report mode/target variance across repeats (#39).
const variants = new Map<string, Set<string>>();
for (const a of all) {
  const key = `${a.gotMode}:${[...a.got].sort().join(",")}`;
  const seen = variants.get(a.q) ?? new Set<string>();
  seen.add(key);
  variants.set(a.q, seen);
}
const unstable = repeat > 1 ? [...variants].filter(([, seen]) => seen.size > 1).map(([q, seen]) => ({ q, runs: [...seen] })) : [];

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const latencies = all.map((a) => a.ms).sort((a, b) => a - b);
const passed = all.filter((a) => a.pass).length;
const fallbacks = all.filter((a) => a.fallback).length;
const report = {
  router: model ? "llm" : "rules",
  model: model ?? null,
  repeat,
  cases: cases.length,
  blocked: blockedTeamCases.map((c) => ({ q: c.q, on: c.blocked })),
  attempts: all.length,
  accuracy: passed / all.length,
  passed,
  fallbacks,
  p50ms: Math.round(pct(latencies, 0.5)),
  p95ms: Math.round(pct(latencies, 0.95)),
  unstable,
  misses: all
    .filter((a) => !a.pass)
    .map((a) => ({ q: a.q, expected: `${a.mode}: ${a.expected.join(", ")}`, got: `${a.gotMode}: ${a.got.join(", ")}` })),
};

if (json) {
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (outFile) writeFileSync(outFile, `${text}\n`);
} else {
  console.log(`routing eval · ${report.router}${model ? ` (${model})` : ""} · ${cases.length} cases × ${repeat}`);
  console.log(`accuracy ${passed}/${all.length} (${(report.accuracy * 100).toFixed(1)}%)${fallbacks ? ` · ${fallbacks} fell back to rules` : ""}`);
  console.log(`latency p50 ${report.p50ms}ms · p95 ${report.p95ms}ms`);
  if (blockedTeamCases.length) console.log(`blocked team cases (not scored): ${blockedTeamCases.length} — see docs/specs/v4-5-agent-teams.md`);
  if (unstable.length) {
    console.log(`unstable across ${repeat} repeats: ${unstable.length} case(s)`);
    for (const u of unstable) console.log(`  varies: "${u.q}" → ${u.runs.join(" / ")}`);
  }
  for (const m of report.misses) console.log(`  miss: "${m.q}" → ${m.got} (expected ${m.expected})`);
  if (outFile) {
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${outFile}`);
  }
  if (!model) console.log("(rules only; add --model <provider/model> for a real model sample — that costs money)");
}

// Optional CI gates: `--min-accuracy 0.9 --max-unstable 0`.
const minAccuracy = flag("--min-accuracy");
const maxUnstable = flag("--max-unstable");
if (minAccuracy !== undefined && report.accuracy < Number(minAccuracy)) {
  console.error(`accuracy ${(report.accuracy * 100).toFixed(1)}% is below --min-accuracy ${minAccuracy}`);
  process.exitCode = 1;
}
if (maxUnstable !== undefined && unstable.length > Number(maxUnstable)) {
  console.error(`${unstable.length} unstable case(s) exceed --max-unstable ${maxUnstable}`);
  process.exitCode = 1;
}