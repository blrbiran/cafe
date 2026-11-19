import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("order provenance", () => {
  it("marks a registered Agent's Order as relayed", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const a = await barista(root.addr, identity("asker", { description: "asks questions" }));
    cleanup.push(() => a.client.close());

    const res = await a.client.ask({ body: "please check the deploy", to: b.rec.address });
    await untilClosed(a.client, res.threadId);
    const meta = root.daemon.thread(res.threadId)!.meta;
    expect(meta.origin).toBe("agent");
    expect(meta.via?.address).toBe(a.rec.address);
    expect(meta.from.address).toBe(a.rec.address);
  });

  it("keeps an explicit origin and via from the caller", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "relayed with a name", origin: "agent", via: { address: "claude#1@mac" } });
    await untilClosed(c, res.threadId);
    const meta = root.daemon.thread(res.threadId)!.meta;
    expect(meta.origin).toBe("agent");
    expect(meta.via).toEqual({ address: "claude#1@mac" });
  });

  it("defaults a web Order to human with no via", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const res = await root.daemon.createOrder({ body: "asked from the web", kind: "order", as: "web", origin: "human" });
    const meta = root.daemon.thread(res.threadId)!.meta;
    expect(meta.origin).toBe("human");
    expect(meta.via).toBeUndefined();
  });
});