import { afterEach, describe, expect, it } from "vitest";
import { Order, type RoutingDecision } from "@cafe/protocol";
import { RulesRouter } from "../packages/daemon/src/router.ts";
import type { Router } from "@cafe/daemon";
import { agentRecords, evalOrder } from "./routing-fixtures.ts";
import { barista, customer, FAST, identity, startDaemon, untilClosed } from "./helpers.ts";

/**
 * #39 remainder — per-target sub-questions (docs/specs/v4-7-per-target-questions.md).
 * An Order may carry `variants` keyed by agentId; delivery sends each target only its own text,
 * and the shared `body` stays what history, the Web UI and follow-ups see.
 */

const BARISTAS = agentRecords("h");
const nameOf = (agentId: string) => BARISTAS.find((b) => b.agentId === agentId)?.name ?? agentId;

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("Order.variants wire type", () => {
  it("accepts an Order without variants and with a partial map", () => {
    const base = evalOrder("shared question");
    expect(Order.parse(base).variants).toBeUndefined();
    expect(Order.parse({ ...base, variants: { "id-web": "the web half" } }).variants).toEqual({ "id-web": "the web half" });
  });
});

describe("rules router splits only an explicit two-clause question", () => {
  const decide = (q: string) => new RulesRouter().decide({ order: evalOrder(q), candidates: BARISTAS });

  it("gives each separable clause to its own best match, verbatim", async () => {
    const q = "the refund page shows a hydration error, and the invoice total is wrong";
    const d = await decide(q);
    expect(d.mode).toBe("multicast");
    expect(d.variants).toBeDefined();
    const byName = new Map(Object.entries(d.variants!).map(([id, text]) => [nameOf(id), text]));
    expect(byName.get("web")).toMatch(/hydration error/);
    expect(byName.get("billing")).toMatch(/invoice total/);
    // Verbatim clauses: no rewriting of the customer's words.
    for (const text of byName.values()) {
      expect(q).toContain(text.trim());
    }
  });

  it("does not split a single-clause question", async () => {
    const d = await decide("the invoice total is wrong after a refund");
    expect(d.variants).toBeUndefined();
  });

  it("does not split when both clauses point at the same Barista", async () => {
    const d = await decide("the invoice total is wrong, and the refund is missing");
    expect(d.variants).toBeUndefined();
  });
});

describe("delivery uses the per-target text", () => {
  it("sends each target only its own variant and keeps the other half out of its prompt", async () => {
    const shared = "the refund page shows a hydration error, and the invoice total is wrong";
    // The router decision carries the split; the daemon owns delivery, so the injected router
    // returns a variant map keyed by the *registered* agentIds, captured when the Baristas connect.
    const agentIdOf = new Map<string, string>();
    const router: Router = {
      name: "rules",
      decide: async (): Promise<RoutingDecision> => {
        const web = agentIdOf.get("web")!;
        const billing = agentIdOf.get("billing")!;
        return {
          targets: [web, billing],
          mode: "multicast",
          reason: "test split",
          router: "rules",
          candidates: [],
          variants: { [web]: "diagnose hydration on the refund page", [billing]: "the invoice total is wrong" },
        };
      },
    };
    const d = await startDaemon("pv", { mode: "root", router, timing: { ...FAST, graceMs: 80 } });
    cleanup.push(d.stop);
    const seen = new Map<string, string>();
    const web = await barista(d.addr, identity("web", { description: "web frontend" }), async (h) => {
      await h.ack();
      seen.set("web", h.order.body);
      await h.reply("web says fixed");
    });
    const billing = await barista(d.addr, identity("billing", { description: "billing invoices" }), async (h) => {
      await h.ack();
      seen.set("billing", h.order.body);
      await h.reply("billing says fixed");
    });
    agentIdOf.set("web", web.rec.agentId);
    agentIdOf.set("billing", billing.rec.agentId);
    cleanup.push(() => web.client.close(), () => billing.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: shared });
    await untilClosed(c, res.threadId, res.orderId);

    expect(seen.get("web")).toBe("diagnose hydration on the refund page");
    expect(seen.get("billing")).toBe("the invoice total is wrong");
    expect(seen.get("web")).not.toContain("invoice total");
    expect(seen.get("billing")).not.toContain("hydration");

    // The recorded Thread keeps the shared body; variants are delivery-only.
    const thread = await fetch(`http://${d.addr}/api/threads/${res.threadId}`).then((r) => r.json());
    const created = thread.events.find((e: { event: { type: string } }) => e.event.type === "order.created");
    expect(created.event.order.body).toBe(shared);
    expect(created.event.order.variants).toBeUndefined();
    expect(res.decision.variants).toBeUndefined();
    const routed = thread.events.find((e: { event: { type: string } }) => e.event.type === "order.routed");
    expect(routed.event.decision.variants).toBeUndefined();
    expect(JSON.stringify(thread.events)).not.toContain("diagnose hydration on the refund page");
  }, 20_000);

  it("falls back to the shared body for a target missing from the map", async () => {
    const shared = "shared question for everyone";
    let delivered: string | undefined;
    let dbId = "";
    const router: Router = {
      name: "rules",
      decide: async (): Promise<RoutingDecision> => ({
        targets: [dbId],
        mode: "unicast",
        reason: "test",
        router: "rules",
        candidates: [],
        variants: { "someone-else": "not for you" },
      }),
    };
    const d = await startDaemon("pv2", { mode: "root", router });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("db", { description: "database schema" }), async (h) => {
      await h.ack();
      delivered = h.order.body;
      await h.reply("ok");
    });
    dbId = b.rec.agentId;
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: shared });
    await untilClosed(c, res.threadId, res.orderId);
    expect(delivered).toBe(shared);
  }, 20_000);
});