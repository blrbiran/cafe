import { afterEach, describe, expect, it } from "vitest";
import type { ChannelDigest } from "@cafe/protocol";
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
});