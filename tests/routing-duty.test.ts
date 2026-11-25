import { afterEach, describe, expect, it } from "vitest";
import { FAST, barista, customer, identity, startDaemon } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("duty as a routing signal (v4-11)", () => {
  it("routes to the duty that names the work, above a shared description token", async () => {
    const d = await startDaemon("duty1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const docs = await barista(d.addr, identity("d1", { duty: "docs", description: "writes documentation" }));
    cleanup.push(() => docs.client.close());
    const billing = await barista(d.addr, identity("d2", { duty: "billing", description: "docs tooling maintainer" }));
    cleanup.push(() => billing.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const r1 = await c.ask({ body: "docs are out of date" });
    expect(r1.decision.targets).toEqual([docs.rec.agentId]);

    const r2 = await c.ask({ body: "billing is wrong" });
    expect(r2.decision.targets).toEqual([billing.rec.agentId]);
  });
});