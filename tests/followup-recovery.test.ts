import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { CafeClient, keepAlive } from "@cafe/protocol/client";
import type { Order, ThreadMeta } from "@cafe/protocol";
import { Store } from "../packages/daemon/src/store.ts";
import { runDaemon } from "@cafe/daemon";
import { barista, customer, FAST, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("follow-ups", () => {
  it("routes a follow-up to whoever answered, with the earlier turns as history", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const seen: Array<{ turn: number; history: unknown[] }> = [];
    const billing = await barista(root.addr, identity("billing", { tags: ["vat"] }), async (h) => {
      seen.push({ turn: h.order.turn, history: h.order.history });
      await h.ack();
      await h.reply(h.order.turn === 1 ? "VAT is 17.5%" : "Rounding is half-even");
    });
    const other = await barista(root.addr, identity("rounding-expert", { tags: ["rounding"] }));
    cleanup.push(() => billing.client.close(), () => other.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const first = await c.ask({ body: "what is the vat rate?" });
    await untilClosed(c, first.threadId, first.orderId);
    // Legacy logs may have hundreds of events between a question and its final answer.
    const metaBefore = root.daemon.thread(first.threadId)!.meta;
    for (let i = 0; i < 220; i++) root.daemon.store.appendEvent(metaBefore.file, {
      eventId: `legacy-heartbeat-${i}`, threadId: first.threadId, orderId: first.orderId,
      host: "root", at: Date.now(), event: { type: "order.heartbeat", agentId: billing.rec.agentId },
    });

    // The follow-up mentions "rounding" but must still go to billing, who answered.
    const follow = await c.ask({ body: "and how is rounding done?", threadId: first.threadId });
    expect(follow.threadId).toBe(first.threadId);
    expect(follow.decision).toMatchObject({ router: "followup", targets: [billing.rec.agentId] });
    const events = await untilClosed(c, first.threadId, follow.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "Rounding is half-even" });

    expect(seen[1]).toMatchObject({
      turn: 2,
      history: [
        { role: "customer", text: "what is the vat rate?" },
        { role: "barista", text: "VAT is 17.5%", from: billing.rec.address },
      ],
    });
    const meta = root.daemon.thread(first.threadId)!.meta;
    expect(meta).toMatchObject({ turns: 2, status: "done", orderId: follow.orderId });
    expect(meta.replies).toEqual([expect.objectContaining({ agentId: billing.rec.agentId, text: "Rounding is half-even" })]);
  });

  it("rejects a follow-up while the previous turn is still open", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const slow = await barista(root.addr, identity("slow"), async (h) => {
      await h.ack();
    });
    cleanup.push(() => slow.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "q", to: "slow" });
    await expect(c.ask({ body: "again?", threadId: first.threadId })).rejects.toMatchObject({ code: "thread_busy" });
  });

  it("records declines on the thread metadata", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("nope"), async (h) => {
      await h.ack();
      await h.decline("not my area");
    });
    cleanup.push(() => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "x", to: "nope" });
    await untilClosed(c, res.threadId, res.orderId);
    expect(root.daemon.thread(res.threadId)!.meta).toMatchObject({ status: "failed", declines: [{ agentId: b.rec.agentId, reason: "not my area" }] });
  });
});

describe("restart & reconnect", () => {
  it("keeps the agentId and address when a barista reconnects", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const c = new CafeClient({ daemon: root.addr });
    const first = await c.connect(identity("sticky"));
    c.close();
    await waitFor(() => !root.daemon.registry.get(first!.agentId));
    const again = await c.connect({ ...identity("sticky"), resumeAgentId: first!.agentId });
    cleanup.push(() => c.close());
    expect(again).toMatchObject({ agentId: first!.agentId, address: first!.address });
  });

  it("recovers an in-flight order after the daemon restarts", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-restart-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), stringify({ host: "solo", token: "t", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "plaintext" } }));
    const timing = { ...FAST, heartbeatIntervalMs: 1000 };
    const opts = { home, timing, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "none") };
    let d = await runDaemon(opts);
    const port = d.server.port;
    const addr = `127.0.0.1:${port}`;

    // Barista acks, keeps heartbeating, and replies only after the restart.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const b = new CafeClient({ daemon: addr, reconnect: true });
    b.onOrder((h) =>
      void (async () => {
        await h.ack();
        const stop = keepAlive(h, 150);
        await released;
        await waitFor(() => b.connected, 5000);
        await h.reply("answered after restart");
        stop();
      })().catch(() => {}),
    );
    const rec = await b.connect(identity("worker"));
    cleanup.push(() => b.close());

    const res = await fetch(`http://${addr}/api/orders`, { method: "POST", body: JSON.stringify({ body: "long job", to: "worker" }) }).then((r) => r.json());
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "working");

    await d.stop();
    d = await runDaemon({ ...opts, port });
    cleanup.push(() => d.stop());
    await waitFor(() => d.daemon.registry.get(rec!.agentId) !== undefined, 5000);
    release();
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "done", 5000);
    expect(d.daemon.thread(res.threadId)!.meta.replies[0]).toMatchObject({ agentId: rec!.agentId, text: "answered after restart" });
  });

  it("re-arms a recovered unicast collect:all deadline", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-restart-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), stringify({ host: "solo", token: "t", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "plaintext" } }));
    const timing = { ...FAST, heartbeatIntervalMs: 800 };
    const opts = { home, timing, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "none") };
    let d = await runDaemon(opts);
    const port = d.server.port;
    const addr = `127.0.0.1:${port}`;

    // Acked, heartbeating, never answering: without a recovered deadline it would stay open.
    const b = new CafeClient({ daemon: addr, reconnect: true });
    b.onOrder((h) =>
      void (async () => {
        await h.ack();
        const stop = keepAlive(h, 300);
        await new Promise((r) => setTimeout(r, 5000));
        stop();
      })().catch(() => {}),
    );
    await b.connect(identity("slow"));
    cleanup.push(() => b.close());

    const res = await fetch(`http://${addr}/api/orders`, {
      method: "POST",
      body: JSON.stringify({ body: "slow job", to: "slow", collect: "all", deadlineMs: 2000 }),
    }).then((r) => r.json());
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "working", 5000);

    await d.stop();
    d = await runDaemon({ ...opts, port });
    cleanup.push(() => d.stop());
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status !== "working", 6000);
    // The deadline, not a lost heartbeat: a silent collect:all target is recorded as skipped.
    const events = d.daemon.thread(res.threadId)!.events;
    expect(events.some((e) => e.event.type === "order.declined" && e.event.skipped)).toBe(true);
  });

  it("fails a recovered order whose barista never comes back", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-restart-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), stringify({ host: "solo", token: "t", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "plaintext" } }));
    const opts = { home, timing: FAST, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "none") };
    let d = await runDaemon(opts);
    const addr = `127.0.0.1:${d.server.port}`;
    const b = new CafeClient({ daemon: addr });
    b.onOrder((h) => void h.ack().catch(() => {}));
    await b.connect(identity("ghost"));
    const res = await fetch(`http://${addr}/api/orders`, { method: "POST", body: JSON.stringify({ body: "job", to: "ghost" }) }).then((r) => r.json());
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "working");
    b.close();
    await d.stop();
    d = await runDaemon(opts);
    cleanup.push(() => d.stop());
    await waitFor(() => d.daemon.thread(res.threadId)?.meta.status === "failed", 5000);
  });

  it("recovers an open Order older than the first 1,000 Threads", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-recover-many-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), stringify({ host: "solo", token: "t", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "plaintext" } }));
    const d = await runDaemon({ home, timing: { ...FAST, ackTimeoutMs: 60_000, heartbeatIntervalMs: 10_000, unicastDeadlineMs: 120_000 }, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "none") });
    cleanup.push(() => d.stop());
    const b = new CafeClient({ daemon: `127.0.0.1:${d.server.port}` });
    const registered = await b.connect(identity("worker"));
    cleanup.push(() => b.close());

    const store = d.daemon.store;
    const from = { id: "cli:seed", address: "cli@solo", host: "solo" };
    const baseAt = Date.now() - 2000;
    for (let i = 0; i < 1005; i++) {
      const suffix = String(i).padStart(4, "0");
      const threadId = `thread-${suffix}`;
      const orderId = `order-${suffix}`;
      const createdAt = baseAt + i;
      const file = store.threadFile(threadId, createdAt);
      const order: Order = {
        orderId, threadId, kind: "order", channel: "default", from,
        body: `recover ${suffix}`, chain: [], depth: 0, createdAt, turn: 1, history: [],
      };
      const meta: ThreadMeta = {
        threadId, orderId, kind: "order", channel: "default", from,
        targets: [registered!.agentId], mode: "unicast", status: "working", summary: order.body,
        summaryTurn: 1, createdAt, file, turns: 1, replies: [], declines: [],
        targetStates: [{ agentId: registered!.agentId, state: "pending" }],
      };
      store.putThread(meta);
      store.appendEvent(file, { eventId: `created-${suffix}`, threadId, orderId, host: "solo", at: createdAt, event: { type: "order.created", order } });
      store.appendEvent(file, {
        eventId: `routed-${suffix}`, threadId, orderId, host: "solo", at: createdAt + 1,
        event: { type: "order.routed", decision: { targets: [registered!.agentId], mode: "unicast", reason: "explicit", router: "explicit", candidates: [] } },
      });
    }

    expect(d.daemon.recover()).toBe(1005);
    d.daemon.replyAs("thread-0000", { orderId: "order-0000", agent: registered!.address, text: "recovered oldest Order" });
    const result = d.daemon.thread("thread-0000")!;
    expect(result.meta.status).toBe("done");
    expect(result.events.find((env) => env.event.type === "order.replied")?.orderId).toBe("order-0000");
  });
});
