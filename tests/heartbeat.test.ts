import { describe, expect, it } from "vitest";
import { CafeClient, keepAlive } from "@cafe/protocol/client";
import { customer, identity, startDaemon, untilClosed } from "./helpers.ts";

/**
 * #6 regression: a Barista that acks and then works longer than the daemon's
 * lease must survive on the default heartbeat path. The test daemon's lease is
 * FAST.heartbeatIntervalMs × HEARTBEAT_MISSES = 600 ms; without the test hook
 * (`CAFE_HEARTBEAT_INTERVAL_MS`, set in vitest.config.ts) `keepAlive()` used the
 * production 30 s interval and the Order was failed as "lost (missed heartbeats)".
 */
describe("heartbeat lease", () => {
  it("keeps an acked Order alive when the Bridge uses the default interval", async () => {
    const root = await startDaemon("root", { mode: "root" });
    const barista = new CafeClient({ daemon: root.addr });
    barista.onOrder((h) => {
      // Mirrors bridge/barista.ts: no explicit interval, so the default applies.
      const stop = keepAlive(h);
      void (async () => {
        await h.ack();
        await new Promise((r) => setTimeout(r, 900));
        await h.reply("late answer");
      })()
        .catch(() => {})
        .finally(stop);
    });
    await barista.connect(identity("slow"));

    const asker = await customer(root.addr);
    const res = await asker.ask({ body: "are you still there?", to: "slow" });
    const events = await untilClosed(asker, res.threadId, res.orderId);
    const types = events.map((e) => e.event.type);

    expect(types).toContain("order.replied");
    expect(types).not.toContain("order.failed");

    barista.close();
    await asker.close();
    await root.stop();
  }, 20_000);
});