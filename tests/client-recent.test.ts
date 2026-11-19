import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("client recent events", () => {
  it("can still read a thread that finished before untilClosed subscribed", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "hello" });
    // Let the fast barista reply and close before any listener is attached.
    await new Promise((r) => setTimeout(r, 300));

    const events = await untilClosed(c, res.threadId, 1_000);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "widgets says: hello" });
    expect(events.at(-1)?.event.type).toBe("order.closed");
  });
});