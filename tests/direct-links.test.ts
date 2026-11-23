import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runDaemon, type Running } from "@cafe/daemon";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const timing = { ...FAST, linkConnectTimeoutMs: 300, linkIdleMs: 60_000 };

/** A Root that can be stopped and started again on the same home and port. */
async function restartableRoot() {
  const home = mkdtempSync(join(tmpdir(), "cafe-root-"));
  writeFileSync(join(home, "config.yml"), stringify({ host: "root", token: "t0k", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "plaintext" } }));
  const opts = { home, timing, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "none") };
  let r: Running | undefined = await runDaemon(opts);
  const port = r.server.port;
  const root = {
    addr: `127.0.0.1:${port}`,
    get daemon() {
      return r!.daemon;
    },
    async stop() {
      await r?.stop();
      r = undefined;
    },
    async start() {
      r = await runDaemon({ ...opts, port });
    },
  };
  cleanup.push(async () => {
    await root.stop();
    rmSync(home, { recursive: true, force: true });
  });
  return root;
}

async function network() {
  const root = await restartableRoot();
  const a = await startDaemon("pc1", { config: { root: root.addr }, timing });
  cleanup.push(a.stop);
  const b = await startDaemon("pc2", { config: { root: root.addr }, timing });
  cleanup.push(b.stop);
  await waitFor(() => a.daemon.rootOnline && b.daemon.rootOnline);
  const worker = await barista(b.addr, identity("worker", { description: "does the work" }));
  cleanup.push(() => worker.client.close());
  await waitFor(() => a.daemon.registry.all().some((r) => r.name === "worker"));
  // The Root's host name is remembered for display before the next connection.
  expect(a.daemon.store.getKv("rootHost")).toBe("root");
  // pc1 learns pc2's address from the Root.
  await waitFor(() => a.daemon.daemons().length > 0 && (a.daemon as any).peerUrls.has("pc2"));
  return { root, a, b, worker };
}

describe("direct links while the Root is offline (ADR-0004)", () => {
  it("delivers across hosts directly, then backfills the Root when it returns", async () => {
    const { root, a, worker } = await network();
    await root.stop();
    await waitFor(() => !a.daemon.rootOnline, 3000);

    const c = await customer(a.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "do the work please" });
    expect(res.decision.targets).toEqual([worker.rec.agentId]);
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: worker.rec.agentId, text: "worker says: do the work please" });
    expect(events.at(-1)?.event).toEqual({ type: "order.closed", status: "done" });

    await root.start();
    await waitFor(() => a.daemon.rootOnline, 5000);
    await waitFor(() => root.daemon.thread(res.threadId)?.meta.status === "done", 5000);
    const onRoot = root.daemon.thread(res.threadId)!;
    expect(onRoot.meta.replies[0]).toMatchObject({ agentId: worker.rec.agentId });
    // Backfill is idempotent on eventId: no duplicate events on the Root's copy.
    const ids = onRoot.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("supports a follow-up and a cancel over the direct link", async () => {
    const { root, a, b } = await network();
    let release!: () => void;
    const slow = await barista(b.addr, identity("slow", { description: "slow jobs" }), async (h) => {
      await h.ack();
      await new Promise<void>((r) => (release = r));
    });
    cleanup.push(() => slow.client.close());
    await waitFor(() => a.daemon.registry.all().some((r) => r.name === "slow"));
    await root.stop();
    await waitFor(() => !a.daemon.rootOnline, 3000);

    const c = await customer(a.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "first question", to: "worker" });
    await untilClosed(c, first.threadId, first.orderId);
    const follow = await c.ask({ body: "and a follow-up", threadId: first.threadId });
    expect(follow.decision.router).toBe("followup");
    const evs = await untilClosed(c, first.threadId, follow.orderId);
    expect(evs.some((e) => e.event.type === "order.replied")).toBe(true);

    let cancelled = false;
    slow.client.onCancel(() => (cancelled = true));
    const job = await c.ask({ body: "long job", to: "slow" });
    await waitFor(() => a.daemon.thread(job.threadId)?.meta.status === "working", 3000);
    await fetch(`http://${a.addr}/api/threads/${job.threadId}/cancel`, { method: "POST" });
    await waitFor(() => cancelled, 3000);
    release();
  });

  it("fails with root_unreachable when the other Daemon cannot be reached either", async () => {
    const { root, a, b } = await network();
    await root.stop();
    await b.stop();
    await waitFor(() => !a.daemon.rootOnline, 3000);
    const c = await customer(a.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "anyone?", to: "worker" });
    const events = await untilClosed(c, res.threadId, res.orderId, 5000);
    expect(events.some((e) => e.event.type === "order.failed" && e.event.reason === "root_unreachable")).toBe(true);
    expect(events.at(-1)?.event).toEqual({ type: "order.closed", status: "failed" });
  });
});
