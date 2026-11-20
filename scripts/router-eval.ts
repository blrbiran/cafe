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
import { LlmRouter, RulesRouter, piComplete, type Router } from "../packages/daemon/src/router.ts";
import type { RoutingDecision } from "@cafe/protocol";
import { EVAL_CASES, EXTRA_CASES, agentRecords, evalOrder } from "../tests/routing-fixtures.ts";

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
const cases = [...EVAL_CASES, ...EXTRA_CASES];

interface Attempt {
  q: string;
  expected: string[];
  mode: string;
  got: string[];
  gotMode: string;
  pass: boolean;
  fallback: boolean;
  ms: number;
}

const router: Router = model ? new LlmRouter(await piComplete(model), new RulesRouter(), { timeoutMs, concurrency }) : new RulesRouter();

async function once(): Promise<Attempt[]> {
  const out: Attempt[] = [];
  for (const c of cases) {
    const started = performance.now();
    const d: RoutingDecision = await router.decide({ order: evalOrder(c.q), candidates: baristas });
    const ms = performance.now() - started;
    const names = d.targets.map((id) => baristas.find((b) => b.agentId === id && b.name)?.name ?? id.replace(/^id-/, ""));
    const wantMode = c.mode ?? "unicast";
    const pass =
      d.mode === wantMode &&
      (wantMode === "broadcast" ? names.length === baristas.length : wantMode === "unicast" ? names.length === 1 && names[0] === c.expect[0] : c.expect.every((n) => names.includes(n)));
    out.push({ q: c.q, expected: c.expect, mode: wantMode, got: names, gotMode: d.mode, pass, fallback: !!d.llmError, ms });
  }
  return out;
}

const runs: Attempt[][] = [];
for (let i = 0; i < repeat; i++) runs.push(await once());
const all = runs.flat();

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const latencies = all.map((a) => a.ms).sort((a, b) => a - b);
const passed = all.filter((a) => a.pass).length;
const fallbacks = all.filter((a) => a.fallback).length;
const report = {
  router: model ? "llm" : "rules",
  model: model ?? null,
  repeat,
  cases: cases.length,
  attempts: all.length,
  accuracy: passed / all.length,
  passed,
  fallbacks,
  p50ms: Math.round(pct(latencies, 0.5)),
  p95ms: Math.round(pct(latencies, 0.95)),
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
  for (const m of report.misses) console.log(`  miss: "${m.q}" → ${m.got} (expected ${m.expected})`);
  if (outFile) {
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${outFile}`);
  }
  if (!model) console.log("(rules only; add --model <provider/model> for a real model sample — that costs money)");
}