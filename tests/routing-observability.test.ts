import { afterEach, describe, expect, it } from "vitest";
import type { AgentRecord, Order } from "@cafe/protocol";
import { RulesRouter } from "../packages/daemon/src/router.ts";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const order = (body: string): Order => ({
  orderId: "o1",
  threadId: "t1",
  kind: "order",
  from: { id: "you", address: "you@here", host: "here" },
  body,
  chain: [],
  depth: 0,
  createdAt: Date.now(),
  turn: 1,
  history: [],
});

const agent = (agentId: string, name: string, description: string): AgentRecord => ({
  agentId,
  address: `${name}#1@here`,
  host: "here",
  name,
  description,
  tags: [],
  scope: [],
  role: "barista",
  concurrency: 1,
  mode: "headless",
  cwd: "/tmp",
  aliases: [],
  legacyAliases: [],
  status: "idle",
  registeredAt: 1,
  lastSeenAt: 2,
});

describe("routing observability", () => {
  it("explains a unicast decision: confidence, fanout and why the runner-up lost", async () => {
    const decision = await new RulesRouter().decide({
      order: order("how does the billing service compute VAT on invoices"),
      candidates: [agent("a1", "billing", "billing invoices VAT and refunds"), agent("a2", "docs", "billing documentation")],
    });
    expect(decision.mode).toBe("unicast");
    expect(decision.fanout).toBe(1);
    expect(decision.confidence).toBeGreaterThan(0.5);
    expect(decision.whyNot?.[0]?.agentId).toBe("a2");
    expect(decision.whyNot?.[0]?.reason).toMatch(/score/i);
  });

  it("reports recent routing mix, fan-out and reply latency via /api/routing/stats", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("billing", { description: "billing invoices VAT" }));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "how does billing compute VAT", to: "billing" });
    await untilClosed(c, res.threadId, res.orderId);

    const r = await fetch(`http://${d.addr}/api/routing/stats`);
    expect(r.status).toBe(200);
    const stats = (await r.json()) as { threads: number; unicast: number; multicast: number; broadcast: number; avgFanout: number; avgFirstReplyMs?: number };
    expect(stats.threads).toBeGreaterThanOrEqual(1);
    expect(stats.unicast).toBeGreaterThanOrEqual(1);
    expect(stats.avgFanout).toBeGreaterThanOrEqual(1);
    expect(stats.avgFirstReplyMs).toBeGreaterThanOrEqual(0);
  });
});