import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ChannelDigest } from "@cafe/protocol";
import { CafeClient } from "@cafe/protocol/client";
import { runDaemon } from "@cafe/daemon";
import { FAST, barista, customer, identity, startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("observer digests and channel history (v4-11)", () => {
  it("sends one digest per interval and never delivers an Order to the observer", async () => {
    const d = await startDaemon("ob1", { mode: "root", timing: { ...FAST, graceMs: 60, digestIntervalMs: 120 } });
    cleanup.push(d.stop);
    const digests: ChannelDigest[] = [];
    let observerOrders = 0;
    const watch = await barista(d.addr, identity("watch", { observer: true, channels: ["team"] }), async (h) => {
      observerOrders++;
      await h.reply("should not happen");
    });
    watch.client.onDigest((x) => digests.push(x));
    cleanup.push(() => watch.client.close());
    const worker = await barista(d.addr, identity("worker", { channels: ["team"] }));
    cleanup.push(() => worker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const a = await c.ask({ body: "first", to: "worker", channel: "team" });
    const b = await c.ask({ body: "second", to: "worker", channel: "team" });
    await waitFor(() => digests.reduce((n, x) => n + x.threads.length, 0) >= 2, 5000);
    expect(observerOrders).toBe(0);
    expect(digests.every((x) => x.channel === "team")).toBe(true);
    expect(digests.every((x) => x.partial !== true)).toBe(true);
    const ids = digests.flatMap((x) => x.threads.map((t) => t.threadId));
    expect(ids).toContain(a.threadId);
    expect(ids).toContain(b.threadId);
    expect(new Set(digests.map((x) => x.digestId)).size).toBe(digests.length);
  });

  it("includes failed Orders beyond the visible digest cap", async () => {
    const d = await startDaemon("ob-overflow", { mode: "root", timing: { ...FAST, graceMs: 60, digestIntervalMs: 60_000 } });
    cleanup.push(d.stop);
    const digests: ChannelDigest[] = [];
    const watch = await barista(d.addr, identity("watch", { observer: true, channels: ["team"] }));
    watch.client.onDigest((x) => digests.push(x));
    cleanup.push(() => watch.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const failures = await Promise.all(Array.from({ length: 25 }, (_, i) => c.ask({ body: `failure ${i}`, to: "offline-worker", channel: "team" })));
    (d.daemon as any).emitDigests();
    await waitFor(() => digests.some((digest) => digest.omitted === 5), 5000);
    const digest = digests.find((entry) => entry.omitted === 5)!;
    const visible = digest.threads.map((entry) => entry.orderId);
    const overflow = digest.omittedFailures ?? [];

    expect(digest.threads).toHaveLength(20);
    expect(overflow.map((entry) => entry.orderId)).toHaveLength(5);
    expect(new Set([...visible, ...overflow.map((entry) => entry.orderId)])).toEqual(new Set(failures.map((failure) => failure.orderId)));
  });

  it("serves the channel index and an after-cursor page", async () => {
    const d = await startDaemon("ob2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const worker = await barista(d.addr, identity("worker", { channels: ["team"] }));
    cleanup.push(() => worker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const a = await c.ask({ body: "one", to: "worker", channel: "team" });
    await waitFor(() => d.daemon.store.getThread(a.threadId) !== undefined, 5000);

    const channels = (await (await fetch(`http://${d.addr}/api/channels`)).json()) as { name: string; threads: number }[];
    expect(channels.find((x) => x.name === "team")?.threads).toBeGreaterThanOrEqual(1);

    const page = (await (await fetch(`http://${d.addr}/api/channels/team/threads?after=0&limit=10`)).json()) as { threads: { threadId: string }[]; exists: boolean };
    expect(page.exists).toBe(true);
    expect(page.threads.map((t) => t.threadId)).toContain(a.threadId);

    const missing = (await (await fetch(`http://${d.addr}/api/channels/nope/threads`)).json()) as { exists: boolean; threads: unknown[] };
    expect(missing).toMatchObject({ exists: false, threads: [] });
  });

  it("does not replay a channel's activity after a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-digest-restart-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), stringify({ host: "solo", token: "t", port: 0, mode: "root", advertise: "127.0.0.1", security: { mode: "plaintext" } }));
    const timing = { ...FAST, graceMs: 60, digestIntervalMs: 100 };
    const opts = { home, timing, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "none") };
    let d = await runDaemon(opts);
    const addr = `127.0.0.1:${d.server.port}`;

    const first: ChannelDigest[] = [];
    const watch = new CafeClient({ daemon: addr });
    watch.onDigest((x) => first.push(x));
    await watch.connect(identity("watch", { observer: true, channels: ["team"] }));
    const c = await customer(addr);
    await c.ask({ body: "before restart", channel: "team" });
    await waitFor(() => first.length > 0, 5000);
    watch.close();
    c.close();

    const port = d.server.port;
    await d.stop();
    d = await runDaemon({ ...opts, port });
    cleanup.push(() => d.stop());
    const after: ChannelDigest[] = [];
    const watch2 = new CafeClient({ daemon: `127.0.0.1:${d.server.port}` });
    watch2.onDigest((x) => after.push(x));
    await watch2.connect(identity("watch", { observer: true, channels: ["team"] }));
    cleanup.push(() => watch2.close());
    await new Promise((r) => setTimeout(r, 350));
    expect(after).toEqual([]);
  });

  it("marks a child digest partial", async () => {
    const d = await startDaemon("ob3", { mode: "daemon", config: { root: "127.0.0.1:1" }, timing: { ...FAST, graceMs: 60, digestIntervalMs: 120 } });
    cleanup.push(d.stop);
    const digests: ChannelDigest[] = [];
    const watch = await barista(d.addr, identity("watch", { observer: true, channels: ["team"] }));
    watch.client.onDigest((x) => digests.push(x));
    cleanup.push(() => watch.client.close());
    const worker = await barista(d.addr, identity("worker", { channels: ["team"] }));
    cleanup.push(() => worker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await c.ask({ body: "local", to: "worker", channel: "team" });
    await waitFor(() => digests.length > 0, 5000);
    expect(digests[0]!.partial).toBe(true);
  });

  it("publishes once from the Root while online and excludes pre-takeover activity from the child digest (#109)", async () => {
    const root = await startDaemon("obR", { mode: "root", timing: { ...FAST, graceMs: 60, digestIntervalMs: 120 } });
    const child = await startDaemon("obC", { config: { root: root.addr }, timing: { ...FAST, graceMs: 60, digestIntervalMs: 120 } });
    cleanup.push(child.stop);
    cleanup.push(root.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);

    const digests: ChannelDigest[] = [];
    const watch = await barista(child.addr, identity("watch", { observer: true, channels: ["team"] }));
    watch.client.onDigest((x) => digests.push(x));
    cleanup.push(() => watch.client.close());
    const worker = await barista(child.addr, identity("worker", { channels: ["team"] }));
    cleanup.push(() => worker.client.close());
    const throughRoot = await customer(root.addr);
    cleanup.push(() => throughRoot.close());

    // The Root publishes the complete view for an observer on a child; the child stays quiet.
    const rootOrder = await throughRoot.ask({ body: "root view", to: "worker", channel: "team" });
    await waitFor(() => digests.some((x) => x.partial !== true && x.threads.some((t) => t.threadId === rootOrder.threadId)), 5000);
    const beforeTakeoverCustomer = await customer(child.addr);
    cleanup.push(() => beforeTakeoverCustomer.close());
    const beforeTakeoverOrder = await beforeTakeoverCustomer.ask({ body: "child activity before takeover", to: "worker", channel: "team" });
    await waitFor(() => digests.some((x) => x.partial !== true && x.threads.some((t) => t.threadId === beforeTakeoverOrder.threadId)), 5000);

    const full = digests.filter((x) => x.partial !== true);
    expect(full.every((x) => String(x.digestId).startsWith("obR:"))).toBe(true);
    expect(full.some((x) => x.threads.some((t) => t.threadId === rootOrder.threadId))).toBe(true);
    expect(full.some((x) => x.threads.some((t) => t.threadId === beforeTakeoverOrder.threadId))).toBe(true);
    expect(digests.some((x) => x.partial === true)).toBe(false);
    const fullCount = full.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(digests.filter((x) => x.partial !== true)).toHaveLength(fullCount);

    await root.stop();
    await waitFor(() => !child.daemon.rootOnline, 8000);
    const afterTakeoverCustomer = await customer(child.addr);
    cleanup.push(() => afterTakeoverCustomer.close());
    const afterTakeoverOrder = await afterTakeoverCustomer.ask({ body: "child view after takeover", to: "worker", channel: "team" });
    await waitFor(() => digests.some((x) => x.partial === true && String(x.digestId).startsWith("obC:") && x.threads.some((t) => t.threadId === afterTakeoverOrder.threadId)), 8000);
    const takeover = digests.find((x) => x.partial === true && x.threads.some((t) => t.threadId === afterTakeoverOrder.threadId))!;
    const takeoverThreadIds = takeover.threads.map((t) => t.threadId);
    expect(takeoverThreadIds).toContain(afterTakeoverOrder.threadId);
    expect(takeoverThreadIds).not.toContain(beforeTakeoverOrder.threadId);
    expect(takeoverThreadIds).not.toContain(rootOrder.threadId);
  }, 30_000);
});