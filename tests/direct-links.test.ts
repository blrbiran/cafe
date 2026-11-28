import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDaemon, type Running } from "@cafe/daemon";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";
import { startEnrolledChild } from "./tls-helpers.ts";

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
  it("replays authenticated owner and recipient events after a TLS Root outage", async () => {
    const homes = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), "cafe-direct-tls-")));
    cleanup.push(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
    const [rootHome, ownerHome, targetHome] = homes as [string, string, string];
    const root = await startDaemon("secure-root", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const owner = await startEnrolledChild(root, "secure-owner", { home: ownerHome });
    cleanup.push(owner.stop);
    const recipient = await startEnrolledChild(root, "secure-target", { home: targetHome });
    cleanup.push(recipient.stop);
    const worker = await barista(recipient.addr, identity("worker"));
    cleanup.push(() => worker.client.close());
    await waitFor(() => owner.daemon.rootOnline && recipient.daemon.rootOnline && !!owner.daemon.registry.get(worker.rec.agentId));
    await waitFor(() => /^wss:/.test(owner.daemon.store.getKv<Record<string, string>>("peerUrls")?.["secure-target"] ?? ""), 5000);
    await root.stop();
    await waitFor(() => !owner.daemon.rootOnline && !recipient.daemon.rootOnline);
    const c = await customer(owner.addr);
    cleanup.push(() => c.close());
    const result = await c.ask({ body: "replay this result", to: "worker" });
    const ownerEvents = await untilClosed(c, result.threadId, result.orderId);
    expect(ownerEvents.find(({ event }) => event.type === "order.final-accepted")).toMatchObject({ eventHostId: owner.daemon.hostId });
    const recipientReplay = recipient.daemon as unknown as { flushBackfill(): Promise<void> };
    const pauseReplay = vi.spyOn(recipientReplay, "flushBackfill").mockResolvedValue(undefined);
    cleanup.push(() => { pauseReplay.mockRestore(); });
    const restored = await startDaemon("secure-root", { home: rootHome, mode: "root", config: { port: root.server.port, security: { mode: "tls", tls: { port: root.server.tlsPort } } } });
    cleanup.push(restored.stop);
    await waitFor(() => restored.daemon.thread(result.threadId)?.meta.status === "done" && recipient.daemon.rootOnline, 5000);
    pauseReplay.mockRestore();
    await recipientReplay.flushBackfill();
    await waitFor(() => restored.daemon.thread(result.threadId)?.meta.replies.some((reply) => reply.agentId === worker.rec.agentId) === true, 5000);
    const thread = restored.daemon.thread(result.threadId)!;
    expect(thread.meta.status).toBe("done");
    expect(thread.events.filter(({ event }) => event.type === "order.replied")).toEqual([
      expect.objectContaining({ eventHostId: recipient.daemon.hostId }),
    ]);
  }, 20_000);

  it("delivers across hosts directly, then backfills the Root when it returns", async () => {
    const { root, a, b, worker } = await network();
    await root.stop();
    await waitFor(() => !a.daemon.rootOnline, 3000);

    const c = await customer(a.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "do the work please" });
    expect(res.decision.targets).toEqual([worker.rec.agentId]);
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: worker.rec.agentId, text: "worker says: do the work please" });
    expect(events.at(-1)?.event).toEqual({ type: "order.closed", status: "done" });
    const sourceCreation = events.find(({ event }) => event.type === "order.created");
    const recipientCreation = b.daemon.thread(res.threadId)?.events.find(({ event }) => event.type === "order.created");
    expect(recipientCreation?.eventId).toBe(sourceCreation?.eventId);
    const sourceAssignment = events.find(({ event }) => event.type === "order.assigned");
    expect(sourceAssignment).toBeDefined();
    const recipientAssignment = b.daemon.thread(res.threadId)?.events.find(({ event }) => event.type === "order.assigned");
    expect(recipientAssignment?.eventId).toBe(sourceAssignment?.eventId);

    await root.start();
    await waitFor(() => a.daemon.rootOnline, 5000);
    await waitFor(() => root.daemon.thread(res.threadId)?.meta.status === "done", 5000);
    const onRoot = root.daemon.thread(res.threadId)!;
    expect(onRoot.meta.replies[0]).toMatchObject({ agentId: worker.rec.agentId });
    // Backfill is idempotent on eventId: no duplicate events on the Root's copy.
    const ids = onRoot.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("backfills only the window the Root missed (#31): a follow-up on an older Thread", async () => {
    const { root, a } = await network();
    const c = await customer(a.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "before the outage", to: "worker" });
    await untilClosed(c, first.threadId, first.orderId);
    await waitFor(() => root.daemon.thread(first.threadId)?.meta.status === "done", 3000);

    await root.stop();
    await waitFor(() => !a.daemon.rootOnline, 3000);
    const outage = Date.now();
    const follow = await c.ask({ body: "during the outage", threadId: first.threadId });
    await untilClosed(c, first.threadId, follow.orderId);
    const since = (a.daemon as any).store.getKv("backfillSince") as Record<string, number>;
    expect(since[first.threadId]).toBeGreaterThanOrEqual(outage - 1000);

    await root.start();
    await waitFor(() => a.daemon.rootOnline, 5000);
    await waitFor(() => root.daemon.thread(first.threadId)?.meta.turns === 2 && root.daemon.thread(first.threadId)?.meta.status === "done", 5000);
    const ids = root.daemon.thread(first.threadId)!.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    await waitFor(() => Object.keys(((a.daemon as any).store.getKv("backfillSince") ?? {}) as object).length === 0, 3000);
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
    await c.cancel(job.threadId, job.orderId);
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
