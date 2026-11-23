import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

// #70: every SSE stream adds a "thread" listener to the same Daemon; Node warns past 10 and the
// production wrapper hides the warning, so real concurrency looked like a leak nobody could see.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("daemon listeners and metrics (#70)", () => {
  it("allows many thread listeners without a MaxListeners warning", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    expect(d.daemon.getMaxListeners()).toBe(0);
    for (let i = 0; i < 40; i++) d.daemon.on("thread", () => {});
    expect(d.daemon.listenerCount("thread")).toBe(41); // 40 + the server's own `remember`
  });

  it("reports connection and listener counts in /api/health", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const health = await fetch(`http://${d.addr}/api/health`).then((r) => r.json());
    expect(health.metrics).toMatchObject({ threadListeners: expect.any(Number), sseClients: expect.any(Number), wsClients: expect.any(Number) });
    expect(health.metrics.threadListeners).toBeGreaterThan(0);
  });

  it("counts a live SSE client and drops it when the stream closes", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const c = new AbortController();
    const res = await fetch(`http://${d.addr}/api/events`, { signal: c.signal });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const during = await fetch(`http://${d.addr}/api/health`).then((r) => r.json());
    expect(during.metrics.sseClients).toBeGreaterThan(0);
    c.abort();
    await new Promise((r) => setTimeout(r, 150));
    const after = await fetch(`http://${d.addr}/api/health`).then((r) => r.json());
    expect(after.metrics.sseClients).toBe(0);
  });
});