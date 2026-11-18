import { afterEach, describe, expect, it } from "vitest";
import type { AgentRecord, Order, RoutingHint } from "@cafe/protocol";
import { LlmRouter, RulesRouter } from "../packages/daemon/src/router.ts";
import { HINT_HALF_LIFE_MS, MAX_PENALTY, computeHints, historyPenalty, orderKeywords, tokenize } from "../packages/daemon/src/hints.ts";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function rec(name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: `id-${name}`,
    address: `${name}#1@h`,
    host: "h",
    name,
    description: "",
    tags: [],
    scope: [],
    role: "barista",
    concurrency: 1,
    mode: "headless",
    cwd: "/tmp",
    status: "idle",
    ...extra,
  } as AgentRecord;
}

function order(body: string): Order {
  return { orderId: "o1", threadId: "t1", kind: "order", body, from: { address: "cli@h" }, chain: [], depth: 0, createdAt: Date.now(), turn: 1, history: [] } as unknown as Order;
}

function hint(topics: Record<string, number>): RoutingHint {
  return { identity: "x@h", answered: 0, declined: 1, failed: 0, declinedTopics: topics };
}

describe("hints: tokens and decay", () => {
  it("splits CJK text into bigrams and keeps latin words", () => {
    const t = tokenize("React组件的样式错了 css");
    expect(t.has("react")).toBe(true);
    expect(t.has("组件")).toBe(true);
    expect(t.has("样式")).toBe(true);
    expect(t.has("css")).toBe(true);
    expect(orderKeywords("a b c " + "word ".repeat(3) + Array.from({ length: 20 }, (_, i) => `kw${i}`).join(" ")).length).toBeLessThanOrEqual(12);
  });

  it("halves a decline's weight every half-life and ignores answers for topics", () => {
    const now = Date.now();
    const h = computeHints(
      [
        { identity: "a@h", kind: "declined", at: now, tokens: ["css"] },
        { identity: "a@h", kind: "declined", at: now - HINT_HALF_LIFE_MS, tokens: ["css", "layout"] },
        { identity: "a@h", kind: "answered", at: now, tokens: ["sql"] },
        { identity: "a@h", kind: "declined", at: now - 8 * 24 * 3600_000, tokens: ["old"] },
      ],
      now,
    );
    expect(h["a@h"]).toMatchObject({ answered: 1, declined: 2, failed: 0 });
    expect(h["a@h"]!.declinedTopics.css).toBeCloseTo(1.5);
    expect(h["a@h"]!.declinedTopics.layout).toBeCloseTo(0.5);
    expect(h["a@h"]!.declinedTopics.sql).toBeUndefined();
    expect(h["a@h"]!.declinedTopics.old).toBeUndefined();
  });

  it("caps the penalty below one description keyword", () => {
    expect(historyPenalty(hint({ css: 100 }), new Set(["css"]))).toBe(MAX_PENALTY);
    expect(historyPenalty(hint({ css: 100 }), new Set(["sql"]))).toBe(0);
  });
});

describe("rules router with hints", () => {
  const router = new RulesRouter();
  const a = rec("a", { description: "frontend css react" });
  const b = rec("b", { description: "frontend css react" });

  it("demotes a Barista that declined similar orders when descriptions tie", async () => {
    const plain = await router.decide({ order: order("fix the css"), candidates: [a, b] });
    expect(plain.targets).toEqual([a.agentId]);
    const d = await router.decide({ order: order("fix the css"), candidates: [a, b], hints: new Map([[a.agentId, hint({ css: 5 })]]) });
    expect(d.targets).toEqual([b.agentId]);
    expect(d.candidates).toEqual([a.agentId]);
    expect(d.reason).toContain("declined similar orders");
  });

  it("never lets history beat a better description match", async () => {
    const strong = rec("s", { description: "css layout grid" });
    const weak = rec("w", { description: "css" });
    const d = await router.decide({
      order: order("css grid layout broken"),
      candidates: [weak, strong],
      hints: new Map([[strong.agentId, hint({ css: 50, grid: 50, layout: 50 })]]),
    });
    expect(d.targets).toEqual([strong.agentId]);
  });

  it("does not turn a match into a broadcast", async () => {
    const d = await router.decide({ order: order("css please"), candidates: [a], hints: new Map([[a.agentId, hint({ css: 50 })]]) });
    expect(d.mode).toBe("unicast");
    expect(d.targets).toEqual([a.agentId]);
  });

  it("matches CJK tags and descriptions", async () => {
    const db = rec("db", { tags: ["数据库"], description: "负责 SQL 查询" });
    const ui = rec("ui", { tags: ["前端"], description: "页面样式" });
    expect((await router.decide({ order: order("数据库连接超时怎么办"), candidates: [ui, db] })).targets).toEqual([db.agentId]);
    expect((await router.decide({ order: order("这个页面样式错位了"), candidates: [db, ui] })).targets).toEqual([ui.agentId]);
  });
});

describe("llm router with hints", () => {
  it("adds a weak-hint line only for Baristas with overlapping declines", async () => {
    let seen = "";
    let system = "";
    const r = new LlmRouter(async (sys, prompt) => {
      system = sys;
      seen = prompt;
      return JSON.stringify({ targets: ["id-b"], mode: "unicast", reason: "r" });
    });
    const a = rec("a");
    const b = rec("b");
    await r.decide({ order: order("css bug"), candidates: [a, b], hints: new Map([[a.agentId, hint({ css: 1, sql: 1 })]]) });
    expect(seen).toContain("history (weak hint): recently declined orders about css");
    expect(seen).not.toContain("sql");
    expect(seen.match(/history/g)?.length).toBe(1);
    expect(system).toContain("weak hint");
  });
});

describe("hints end to end", () => {
  it("records declines, reroutes the next similar order, and replicates hints to a child", async () => {
    const timing = { ...FAST, hintsIntervalMs: 50 };
    const root = await startDaemon("root", { config: { mode: "root" }, timing });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr }, timing });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);

    const desc = { description: "frontend css react" };
    const picky = await barista(root.addr, identity("picky", desc), async (h) => {
      await h.ack();
      await h.decline("css is not mine");
    });
    const helper = await barista(root.addr, identity("helper", desc));
    cleanup.push(() => picky.client.close(), () => helper.client.close());
    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    await waitFor(() => child.daemon.registry.all().length === 2);

    const first = await c.ask({ body: "the css of the header is broken" });
    expect(first.decision.targets).toEqual([picky.rec.agentId]);
    const events = await untilClosed(c, first.threadId);
    expect(events.some((e) => e.event.type === "order.replied" && e.event.agentId === helper.rec.agentId)).toBe(true);

    // Root computed the hint and pushed it to the child, which routes the next order itself.
    await waitFor(() => (child.daemon.routingHints()["picky@root"]?.declinedTopics.css ?? 0) > 0, 3000);
    const second = await c.ask({ body: "css footer looks wrong" });
    expect(second.decision.targets).toEqual([helper.rec.agentId]);
    expect(second.decision.reason).toContain("declined similar orders");
    await untilClosed(c, second.threadId);

    const res = await fetch(`http://${root.addr}/api/routing/hints`).then((r) => r.json());
    expect(res.learn).toBe(true);
    expect(res.hints["helper@root"].answered).toBeGreaterThanOrEqual(2);
  });

  it("ignores operational declines for topics and respects router.learn=false", async () => {
    const root = await startDaemon("root", { config: { mode: "root", router: { learn: false } } });
    cleanup.push(root.stop);
    const desc = { description: "frontend css react" };
    const busy = await barista(root.addr, identity("busy", desc), async (h) => {
      await h.ack();
      await h.decline("not picked up in time", { unavailable: true });
    });
    const other = await barista(root.addr, identity("other", desc));
    cleanup.push(() => busy.client.close(), () => other.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const r = await c.ask({ body: "css question" });
    await untilClosed(c, r.threadId);
    const h = root.daemon.routingHints()["busy@root"];
    expect(h?.declined).toBe(1);
    expect(h?.declinedTopics).toEqual({});
  });
});
