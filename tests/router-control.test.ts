import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, Order, RoutingHint } from "@cafe/protocol";
import { loadConfig } from "@cafe/daemon";
import { LlmRouter, RulesRouter } from "../packages/daemon/src/router.ts";
import { startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const rec = (id: string, name: string): AgentRecord => ({
  name,
  description: `owns ${name}`,
  tags: [name],
  scope: [],
  role: "barista",
  concurrency: 1,
  mode: "headless",
  cwd: "/tmp",
  agentId: id,
  address: `${name}#1@host`,
  host: "host",
  status: "idle",
  registeredAt: 0,
  lastSeenAt: 0,
  aliases: [],
});

const order: Order = {
  orderId: "O1",
  threadId: "T1",
  body: "how do widgets work?",
  kind: "order",
  turn: 1,
  from: { id: "me", address: "me#1@host", host: "host" },
  chain: [],
  depth: 0,
  history: [],
  createdAt: Date.now(),
};

const input = (candidates: AgentRecord[], hints?: Map<string, RoutingHint>) => ({ order, candidates, hints });

describe("LlmRouter", () => {
  it("routes to the only candidate without calling the model", async () => {
    const complete = vi.fn(async () => "{}");
    const d = await new LlmRouter(complete, new RulesRouter()).decide(input([rec("A", "widgets")]));
    expect(complete).not.toHaveBeenCalled();
    expect(d).toMatchObject({ mode: "unicast", targets: ["A"], router: "llm" });
  });

  it("falls back to rules when the model does not answer before the timeout", async () => {
    const complete = (_s: string, _p: string, signal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const d = await new LlmRouter(complete, new RulesRouter(), { timeoutMs: 30 }).decide(input([rec("A", "widgets"), rec("B", "gadgets")]));
    expect(d.router).toBe("rules");
    expect(d.llmError).toMatch(/timeout/i);
  });

  it("limits concurrent model calls", async () => {
    let active = 0;
    let max = 0;
    const complete = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return JSON.stringify({ targets: ["A"], mode: "unicast", reason: "ok" });
    };
    const router = new LlmRouter(complete, new RulesRouter(), { concurrency: 2 });
    const candidates = [rec("A", "widgets"), rec("B", "gadgets"), rec("C", "sprockets")];
    await Promise.all(Array.from({ length: 6 }, () => router.decide(input(candidates))));
    expect(max).toBeLessThanOrEqual(2);
  });
});

describe("initRouter", () => {
  it("switches rules → llm → another llm → rules, and keeps the old router on failure", async () => {
    const root = await startDaemon("root", {
      mode: "root",
      routerFactory: async (model) => {
        if (model === "bad/model") throw new Error(`unknown model ${model}`);
        return new LlmRouter(async () => JSON.stringify({ targets: [], mode: "broadcast", reason: model }), new RulesRouter());
      },
    });
    cleanup.push(root.stop);
    const d = root.daemon;

    d.config.router.model = "good/one";
    expect(await d.initRouter()).toMatchObject({ ok: true, router: "llm", model: "good/one" });
    expect(d.snapshot()).toMatchObject({ router: "llm", routerModel: "good/one" });

    d.config.router.model = "good/two";
    expect(await d.initRouter()).toMatchObject({ ok: true, router: "llm", model: "good/two" });
    expect(d.snapshot()).toMatchObject({ router: "llm", routerModel: "good/two" });

    const failed = await d.initRouter();
    d.config.router.model = "bad/model";
    const bad = await d.initRouter();
    expect(bad).toMatchObject({ ok: false, router: "llm" });
    expect(bad.error).toMatch(/unknown model/);
    expect(failed.ok).toBe(true);
    expect(d.snapshot()).toMatchObject({ router: "llm", routerModel: "good/two", routerError: expect.stringContaining("unknown model") });

    d.config.router.model = undefined;
    expect(await d.initRouter()).toMatchObject({ ok: true, router: "rules" });
    expect(d.snapshot()).toMatchObject({ router: "rules" });
    expect(d.snapshot().routerModel).toBeUndefined();
  });

  it("setRouterModel applies, rolls back a bad model, and clears to rules", async () => {
    const root = await startDaemon("root", {
      mode: "root",
      routerFactory: async (model) => {
        if (model === "bad/model") throw new Error(`unknown model ${model}`);
        return new LlmRouter(async () => JSON.stringify({ targets: [], mode: "broadcast", reason: model }), new RulesRouter());
      },
    });
    cleanup.push(root.stop);
    const d = root.daemon;

    expect(await d.setRouterModel("good/one")).toMatchObject({ ok: true, router: "llm", model: "good/one" });
    expect(loadConfig(root.home).router.model).toBe("good/one");

    const bad = await d.setRouterModel("bad/model");
    expect(bad).toMatchObject({ ok: false, router: "llm", model: "good/one" });
    expect(bad.error).toMatch(/unknown model/);
    // A rejected switch is not written: config and the running router still agree.
    expect(loadConfig(root.home).router.model).toBe("good/one");
    expect(d.routerStatus()).toMatchObject({ router: "llm", model: "good/one" });

    expect(await d.setRouterModel(null)).toMatchObject({ ok: true, router: "rules" });
    expect(loadConfig(root.home).router.model).toBeUndefined();
    expect(d.routerStatus()).toMatchObject({ router: "rules" });
  });
});
