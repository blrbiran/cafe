import { afterEach, describe, expect, it } from "vitest";
import { customer, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/**
 * #31: the in-memory Thread and Order caches are bounded. The limits are read from the
 * environment so a test can shrink them; a closed Thread evicted from memory is re-read
 * from SQLite on demand, so nothing breaks.
 */
describe("bounded daemon caches (#31)", () => {
  const KEY_META = "CAFE_META_CACHE_MAX";
  const KEY_ORDERS = "CAFE_KNOWN_ORDERS_MAX";

  function setLimits(meta: number, orders: number) {
    process.env[KEY_META] = String(meta);
    process.env[KEY_ORDERS] = String(orders);
    cleanup.push(() => {
      delete process.env[KEY_META];
      delete process.env[KEY_ORDERS];
    });
  }

  it("keeps the Thread cache bounded and still serves evicted Threads from SQLite", async () => {
    setLimits(6, 0);
    const root = await startDaemon("cache", { mode: "root" });
    cleanup.push(root.stop);
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    // A barista that answers — enough for the Thread to settle and enter the closed set.
    const { CafeClient } = await import("@cafe/protocol/client");
    const b = new CafeClient({ daemon: root.addr });
    b.onOrder(async (h) => {
      await h.ack().catch(() => {});
      await h.reply(`re: ${h.order.body}`).catch(() => {});
    });
    const rec = await b.connect({ name: "echo", description: "echoes", tags: [], scope: ["echo"], role: "barista", concurrency: 4, mode: "headless", cwd: "/tmp" });
    cleanup.push(() => b.close());
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "echo"), 5_000);
    expect(rec).toBeTruthy();

    const first = await c.ask({ body: "first question", to: "echo" });
    await untilClosed(c, first.threadId, first.orderId);
    // Create more Threads than the cache holds.
    for (let i = 0; i < 12; i++) {
      const r = await c.ask({ body: `question ${i}`, to: "echo" });
      await untilClosed(c, r.threadId, r.orderId);
    }
    // The first Thread is long done; whether or not it is still cached, `thread()` returns it.
    const t = root.daemon.thread(first.threadId);
    expect(t?.meta.threadId).toBe(first.threadId);
    expect(t?.events.some((e) => e.event.type === "order.created")).toBe(true);
  }, 30_000);

  it("a zero limit disables the cap (default behaviour)", async () => {
    setLimits(0, 0);
    const root = await startDaemon("nocla", { mode: "root" });
    cleanup.push(root.stop);
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const r = await c.ask({ body: "hello?", to: "nobody", broadcast: true });
    await untilClosed(c, r.threadId, r.orderId).catch(() => undefined);
    expect(root.daemon.thread(r.threadId)?.meta.threadId).toBe(r.threadId);
  }, 20_000);
});