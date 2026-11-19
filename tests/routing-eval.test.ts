import { describe, expect, it } from "vitest";
import type { AgentRecord, Order, RoutingHint } from "@cafe/protocol";
import { RulesRouter } from "../packages/daemon/src/router.ts";
import { computeHints, identityOf, orderKeywords, type OutcomeRow } from "../packages/daemon/src/hints.ts";

/**
 * Routing eval: a fixed set of Baristas and Orders with the expected receiver.
 * Compares the rules router without and with routing hints built from a replayed
 * decline history. Rules only: no model calls.
 */

function rec(name: string, tags: string[], description: string): AgentRecord {
  return { agentId: `id-${name}`, address: `${name}#1@h`, host: "h", name, tags, description, scope: [], role: "barista", concurrency: 1, mode: "headless", cwd: "/tmp", status: "idle", registeredAt: 0, lastSeenAt: 0, aliases: [] };
}

const BARISTAS = [
  rec("mobile", ["ios", "android"], "mobile app, react native screens and hooks"),
  rec("web", ["frontend"], "web frontend: react hooks, css, pages"),
  rec("billing", ["invoice", "payment"], "billing service: invoices, refunds, payment gateway"),
  rec("search", ["elasticsearch"], "search indexing and ranking"),
  rec("db", ["数据库", "sql"], "数据库 schema、迁移和 postgres 查询"),
  rec("infra", ["deploy", "k8s"], "deployment, kubernetes, ci pipelines, docker"),
];

/** [order, expected receiver, clear?] — "clear" cases are decided by the description alone. */
const CASES: [string, string, boolean][] = [
  ["the invoice total is wrong after a refund", "billing", true],
  ["payment gateway returns 502", "billing", true],
  ["elasticsearch ranking looks off", "search", true],
  ["reindex the elasticsearch cluster", "search", true],
  ["这个 sql 查询太慢了", "db", true],
  ["数据库迁移失败了", "db", true],
  ["postgres schema change for users", "db", true],
  ["deploy to staging is stuck", "infra", true],
  ["k8s pod keeps restarting", "infra", true],
  ["docker build fails in ci", "infra", true],
  ["ios build crashes on launch", "mobile", true],
  ["android screens render blank", "mobile", true],
  ["frontend css of the pricing pages", "web", true],
  ["css grid on the landing pages", "web", true],
  ["refunds are not showing on invoices", "billing", true],
  // Ambiguous: web and mobile both describe "react hooks". History says mobile keeps declining these.
  ["react hooks rerender loop", "web", false],
  ["custom react hooks for forms", "web", false],
  ["which react hooks should we use for data fetching", "web", false],
];

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

function order(body: string): Order {
  return { orderId: "o", threadId: "t", kind: "order", body, from: { address: "eval@h" }, chain: [], depth: 0, createdAt: 0, turn: 1, history: [] } as unknown as Order;
}

async function run(hints?: Map<string, RoutingHint>) {
  const router = new RulesRouter();
  const out: { body: string; expected: string; got: string; clear: boolean }[] = [];
  for (const [body, expected, clear] of CASES) {
    const d = await router.decide({ order: order(body), candidates: BARISTAS, hints });
    const got = d.mode === "unicast" ? BARISTAS.find((b) => b.agentId === d.targets[0])!.name : d.mode;
    out.push({ body, expected, got, clear });
  }
  return out;
}

describe("routing eval (rules)", () => {
  it("hints never hurt and fix ambiguous cases", async () => {
    const now = Date.now();
    const byIdentity = computeHints(history(now), now);
    const hints = new Map(BARISTAS.filter((b) => byIdentity[identityOf(b)]).map((b) => [b.agentId, byIdentity[identityOf(b)]!]));

    const before = await run();
    const after = await run(hints);
    const acc = (rs: typeof before) => rs.filter((r) => r.got === r.expected).length;
    console.log(`routing eval: ${acc(before)}/${CASES.length} without hints → ${acc(after)}/${CASES.length} with hints`);
    for (const r of after) if (r.got !== r.expected) console.log(`  miss: "${r.body}" → ${r.got} (expected ${r.expected})`);

    // Every clear case is right either way, and history does not change it.
    for (let i = 0; i < CASES.length; i++) {
      if (!before[i]!.clear) continue;
      expect(before[i]!.got, before[i]!.body).toBe(before[i]!.expected);
      expect(after[i]!.got, after[i]!.body).toBe(before[i]!.got);
    }
    expect(acc(after)).toBeGreaterThanOrEqual(acc(before));
    expect(after.filter((r) => !r.clear).every((r) => r.got === r.expected)).toBe(true);
  });
});
