import { afterEach, describe, expect, it } from "vitest";
import { summarize } from "../packages/daemon/src/summary.ts";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("summarize", () => {
  it("keeps short text unchanged", () => {
    expect(summarize("how many widgets?")).toBe("how many widgets?");
  });

  it("cuts at a word boundary and marks the cut", () => {
    const body = `${"a".repeat(155)} codex app-server is important`;
    expect(summarize(body)).toBe(`${"a".repeat(155)}…`);
  });
});

describe("thread summary", () => {
  it("is an explicit, faithful truncation of a long question", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const body = `${"z".repeat(210)} codex app-server`;
    const res = await c.ask({ body });
    await untilClosed(c, res.threadId, res.orderId);
    const meta = root.daemon.thread(res.threadId)!.meta;
    expect(meta.summary.endsWith("…")).toBe(true);
    expect(meta.summary.length).toBeLessThan(body.length);
    expect(body.startsWith(meta.summary.slice(0, -1))).toBe(true);
    expect(meta.summary.at(-2)).not.toBe(" ");
  });

  it("keeps the title on the first question across follow-ups", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const first = await c.ask({ body: "the first question" });
    await untilClosed(c, first.threadId, first.orderId);
    const second = await c.ask({ body: "and the second question", threadId: first.threadId });
    await untilClosed(c, second.threadId, second.orderId);
    const meta = root.daemon.thread(first.threadId)!.meta;
    expect(meta.turns).toBe(2);
    expect(meta.summary).toBe("the first question");
    expect(meta.summaryTurn).toBe(1);
  });
});
