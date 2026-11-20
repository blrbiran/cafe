import { describe, expect, it } from "vitest";
import { RulesRouter, TOP_K } from "../packages/daemon/src/router.ts";
import { tokenize } from "../packages/daemon/src/hints.ts";
import { agentRecords, evalOrder } from "./routing-fixtures.ts";

const BARISTAS = agentRecords("h");
const decide = (q: string, broadcast = false) => new RulesRouter().decide({ order: evalOrder(q), candidates: BARISTAS, broadcast });

describe("rules tokenizer (#39)", () => {
  it("stems English plurals so a singular tag matches a plural question", () => {
    expect(tokenize("ledgers")).toContain("ledger");
    expect(tokenize("invoices")).toContain("invoice");
    expect(tokenize("policies")).toContain("policy");
    expect(tokenize("boxes")).toContain("box");
  });

  it("does not over-stem words that end in s for another reason", () => {
    expect(tokenize("status")).toContain("status");
    expect(tokenize("class")).toContain("class");
    expect(tokenize("analysis")).toContain("analysis");
    expect(tokenize("aws")).toContain("aws");
  });
});

describe("rules routing decisions (#39)", () => {
  it("lets the action word beat a domain word", async () => {
    const d = await decide("Please update the README for the billing service");
    expect(d.mode).toBe("unicast");
    expect(BARISTAS.find((b) => b.agentId === d.targets[0])?.name).toBe("docs");
  });

  it("matches a plural in the question to a singular tag", async () => {
    const d = await decide("invoices are out of sync with payments");
    expect(d.mode).toBe("unicast");
    expect(BARISTAS.find((b) => b.agentId === d.targets[0])?.name).toBe("billing");
  });

  it("fans out to at most TOP_K when nobody matches, never to everyone", async () => {
    const d = await decide("what is the meaning of life");
    expect(d.mode).toBe("multicast");
    expect(d.targets.length).toBe(TOP_K);
  });

  it("broadcasts only when the customer asks everyone", async () => {
    const d = await decide("hello", true);
    expect(d.mode).toBe("broadcast");
    expect(d.targets).toHaveLength(BARISTAS.length);
  });

  it("multicasts a question with two separable owners", async () => {
    const d = await decide("the refund page shows a hydration error and the invoice total is wrong");
    expect(d.mode).toBe("multicast");
    const names = d.targets.map((id) => BARISTAS.find((b) => b.agentId === id)?.name);
    expect(names).toEqual(expect.arrayContaining(["web", "billing"]));
  });
});