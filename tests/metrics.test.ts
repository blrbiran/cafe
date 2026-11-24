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
// #86: one flat object mixed "since this start" counters, database totals and last-operation
// timings, so a restarted daemon showed "49 threads, 0 events". Each scope now has its own name.
describe("health metrics name their scope (#86)", () => {
  it("separates since-start counters, totals and last timings, and says when the daemon started", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "cafe-m86-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));

    const before = Date.now();
    const d = await startDaemon("pc1", { mode: "root", home });
    const b = await barista(d.addr, identity("builder", { description: "builds things" }));
    const c = await customer(d.addr);
    const res = await c.ask({ body: "metrics scope probe", to: "builder" });
    await untilClosed(c, res.threadId, res.orderId);
    const first = (await fetch(`http://${d.addr}/api/health`).then((r) => r.json())) as any;
    expect(first.startedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(first.metrics.eventsSinceStart).toBeGreaterThanOrEqual(3);
    expect(first.metrics.eventsSinceStart).toBe(first.metrics.events); // old name kept for one release
    expect(first.metrics.appendBytesSinceStart).toBeGreaterThan(0);
    expect(first.metrics.metaWritesSinceStart).toBeGreaterThan(0);
    expect(first.metrics.threadsTotal).toBe(1);
    expect(first.metrics).toHaveProperty("indexedEventsTotal");
    expect(first.metrics).toHaveProperty("lastSnapshotMs");
    expect(first.metrics).toHaveProperty("lastSearchMs");
    c.close();
    b.client.close();
    await d.stop();

    const again = await startDaemon("pc1", { mode: "root", home });
    cleanup.push(again.stop);
    const second = (await fetch(`http://${again.addr}/api/health`).then((r) => r.json())) as any;
    expect(second.metrics.eventsSinceStart).toBe(0);
    expect(second.metrics.threadsTotal).toBe(1);
  });
});

// #31 criterion 2: a burst of 100 events/s on one Thread coalesces metadata writes (150 ms per Thread)
// and keeps each write bounded (replies/declines capped), so write volume tracks the payload.
describe("metadata writes under an event burst (#31)", () => {
  it("writes a Thread's metadata at most ~7 times a second at 100 events/s", async () => {
    const d = await startDaemon("pc1", { mode: "root" });
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("chatty"), async (h) => {
      await h.ack();
      for (let i = 0; i < 150; i++) {
        await h.reply(`interim ${i} `.repeat(20), false);
        await new Promise((r) => setTimeout(r, 10));
      }
      await h.reply("done");
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const m0 = (await (await fetch(`http://${d.addr}/api/health`)).json()).metrics;
    const t0 = Date.now();
    const res = await c.ask({ body: "burst", to: "chatty" });
    await untilClosed(c, res.threadId, res.orderId);
    const seconds = (Date.now() - t0) / 1000;
    const m1 = (await (await fetch(`http://${d.addr}/api/health`)).json()).metrics;
    const writes = m1.metaWritesSinceStart - m0.metaWritesSinceStart;
    const events = m1.eventsSinceStart - m0.eventsSinceStart;
    expect(events).toBeGreaterThanOrEqual(150);
    // created/closed write immediately; everything else is coalesced per 150 ms.
    expect(writes).toBeLessThanOrEqual(Math.ceil(seconds / 0.15) + 4);
    expect(writes / seconds).toBeLessThanOrEqual(10);
    // Bounded metadata: the average write stays far below the sum of the replies it summarizes.
    expect((m1.metaBytesSinceStart - m0.metaBytesSinceStart) / writes).toBeLessThan(64 * 1024);
  }, 20_000);
});
