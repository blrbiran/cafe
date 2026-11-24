import { afterEach, describe, expect, it } from "vitest";
import { CafeClient } from "../packages/protocol/src/client.ts";
import { startDaemon, waitFor } from "./helpers.ts";

// #85: a closed peer left one empty Set per thread it had subscribed to, forever, and no metric
// showed it (threadListeners counts EventEmitter listeners, not this map).
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const metrics = (addr: string) => fetch(`http://${addr}/api/health`).then((r) => r.json()).then((h) => h.metrics);

describe("thread subscriptions are released with their peer (#85)", () => {
  it("drops every subscription key once the subscribing peer closes", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const c = new CafeClient({ daemon: d.addr });
    await c.connect();
    for (let i = 0; i < 50; i++) await (c as any).peer.request("thread/subscribe", { threadId: `t-${i}` });
    expect((await metrics(d.addr)).subscribedThreads).toBe(50);
    c.close();
    await waitFor(async () => (await metrics(d.addr)).subscribedThreads === 0);
  });

  it("keeps a thread's key while another peer still subscribes to it", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const a = new CafeClient({ daemon: d.addr });
    const b = new CafeClient({ daemon: d.addr });
    await a.connect();
    await b.connect();
    cleanup.push(() => b.close());
    await (a as any).peer.request("thread/subscribe", { threadId: "shared" });
    await (b as any).peer.request("thread/subscribe", { threadId: "shared" });
    a.close();
    await new Promise((r) => setTimeout(r, 150));
    expect((await metrics(d.addr)).subscribedThreads).toBe(1);
  });
});
