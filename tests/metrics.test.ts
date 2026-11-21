import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

interface Metrics {
  threads: number;
  events: number;
  appendBytes: number;
  metaWrites: number;
  metaBytes: number;
  snapshotMs: number;
  searchMs: number;
  eventLoopLagMs: number;
}

async function health(addr: string): Promise<{ ok: boolean; metrics?: Metrics }> {
  const res = await fetch(`http://${addr}/api/health`);
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; metrics?: Metrics };
}

describe("health metrics", () => {
  it("counts Threads, events and metadata writes after a turn", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("builder", { description: "builds things" }));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "metrics probe", to: "builder" });
    await untilClosed(c, res.threadId, res.orderId);

    const h = await health(d.addr);
    expect(h.metrics).toBeDefined();
    expect(h.metrics!.threads).toBeGreaterThanOrEqual(1);
    expect(h.metrics!.events).toBeGreaterThanOrEqual(3); // created, delivered/acked/replied, closed
    expect(h.metrics!.appendBytes).toBeGreaterThan(0);
    expect(h.metrics!.metaWrites).toBeGreaterThan(0);
    expect(h.metrics!.metaBytes).toBeGreaterThan(0);
    expect(h.metrics!.eventLoopLagMs).toBeGreaterThanOrEqual(0);
  });

  it("reports search scans, elapsed time and truncation via ?stats=1", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("builder"));
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "the needle is here", to: "builder" });
    await untilClosed(c, res.threadId, res.orderId);

    const plain = await fetch(`http://${d.addr}/api/search?q=needle`);
    expect(Array.isArray(await plain.json())).toBe(true);

    const statsRes = await fetch(`http://${d.addr}/api/search?q=needle&stats=1`);
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as { results: unknown[]; scanned: number; elapsedMs: number; truncated: boolean };
    expect(stats.results.length).toBeGreaterThanOrEqual(1);
    expect(stats.scanned).toBeGreaterThanOrEqual(1);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(stats.truncated).toBe(false);
  });
});