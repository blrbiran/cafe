import { afterEach, describe, expect, it } from "vitest";
import { LlmRouter, RulesRouter } from "../packages/daemon/src/router.ts";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

// Seen live: loading the LLM router took 26–47 s, and the daemon opened no port until it was done — the
// Web, the Agents and every CLI command were unreachable meanwhile. The ports open first; an Order that
// arrives while the router loads waits for it, so routing decisions are unchanged.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("a slow router load does not hold the daemon closed", () => {
  it("answers health while the router loads, then routes a waiting Order with that router", async () => {
    let loaded = false;
    const t0 = Date.now();
    const d = await startDaemon("slowrouter", {
      mode: "root",
      config: { router: { model: "slow/model" } },
      routerFactory: async () => {
        await new Promise((r) => setTimeout(r, 1500));
        loaded = true;
        return new LlmRouter(async () => JSON.stringify({ targets: [], mode: "broadcast", reason: "slow llm" }), new RulesRouter());
      },
    });
    cleanup.push(d.stop);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(loaded).toBe(false);
    const health = (await (await fetch(`http://${d.addr}/api/health`)).json()) as { router: string; routerLoading?: boolean };
    expect(health.routerLoading).toBe(true);

    const b = await barista(d.addr, identity("helper"));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "who can help?" });
    expect(res.decision.router).toBe("llm");
    expect(loaded).toBe(true);
    await untilClosed(c, res.threadId, res.orderId);
    const after = (await (await fetch(`http://${d.addr}/api/health`)).json()) as { router: string; routerLoading?: boolean };
    expect(after).toMatchObject({ router: "llm" });
    expect(after.routerLoading).toBeUndefined();
  }, 20_000);

  it("a model switched during the startup load wins over the slower startup load", async () => {
    const make = (reason: string) => new LlmRouter(async () => JSON.stringify({ targets: [], mode: "broadcast", reason }), new RulesRouter());
    const d = await startDaemon("switchrouter", {
      mode: "root",
      config: { router: { model: "slow/a" } },
      routerFactory: async (model) => {
        if (model === "slow/a") await new Promise((r) => setTimeout(r, 1200));
        return make(model);
      },
    });
    cleanup.push(d.stop);
    expect(await d.daemon.setRouterModel("fast/b")).toMatchObject({ ok: true, model: "fast/b" });
    await new Promise((r) => setTimeout(r, 1600));
    expect(d.daemon.routerStatus()).toMatchObject({ router: "llm", model: "fast/b" });
    // While loading, doctor says so instead of failing the router check.
  }, 20_000);

  it("doctor reports a loading router as a warning, not a failure", async () => {
    const d = await startDaemon("docrouter", {
      mode: "root",
      config: { router: { model: "slow/c" } },
      routerFactory: async (model) => {
        await new Promise((r) => setTimeout(r, 1500));
        return new LlmRouter(async () => JSON.stringify({ targets: [], mode: "broadcast", reason: model }), new RulesRouter());
      },
    });
    cleanup.push(d.stop);
    const check = d.daemon.doctor().checks.find((c) => c.name === "router");
    expect(check).toMatchObject({ level: "warn" });
    expect(check?.detail).toMatch(/loading/);
  }, 20_000);
});

