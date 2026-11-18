import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";
import type { Router } from "@cafe/daemon";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function rootAndChild(opts: { router?: Router } = {}) {
  const root = await startDaemon("root", { mode: "root", router: opts.router });
  cleanup.push(root.stop);
  const child = await startDaemon("pc1", { config: { root: root.addr }, router: opts.router });
  cleanup.push(child.stop);
  await waitFor(() => child.daemon.rootOnline);
  return { root, child };
}

describe("single root", () => {
  it("routes a unicast order by keyword and returns the reply", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const a = await barista(root.addr, identity("billing", { tags: ["invoice"] }));
    const b = await barista(root.addr, identity("search", { tags: ["index"] }));
    cleanup.push(() => a.client.close(), () => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "why is the invoice total wrong?" });
    expect(res.decision.mode).toBe("unicast");
    expect(res.decision.targets).toEqual([a.rec.agentId]);
    const events = await untilClosed(c, res.threadId);
    const reply = events.find((e) => e.event.type === "order.replied");
    expect(reply?.event).toMatchObject({ agentId: a.rec.agentId, text: "billing says: why is the invoice total wrong?" });
    expect(events.at(-1)?.event).toEqual({ type: "thread.closed", status: "done" });
    expect(root.daemon.thread(res.threadId)?.meta.status).toBe("done");
  });

  it("broadcasts when nobody matches and collects every reply", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const a = await barista(root.addr, identity("alpha"));
    const b = await barista(root.addr, identity("beta"), async (h) => {
      await h.ack();
      await h.decline("not mine");
    });
    cleanup.push(() => a.client.close(), () => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "anyone know zzz?" });
    expect(res.decision.mode).toBe("broadcast");
    const events = await untilClosed(c, res.threadId);
    const types = events.map((e) => e.event.type);
    expect(types).toContain("order.replied");
    expect(types).toContain("order.declined");
    expect(events.at(-1)?.event).toEqual({ type: "thread.closed", status: "done" });
  });

  it("falls back to the next candidate when the target never acks", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const mute = await barista(root.addr, identity("db", { tags: ["postgres"], description: "postgres schema" }), async () => {});
    const ok = await barista(root.addr, identity("ops", { description: "postgres backups" }));
    cleanup.push(() => mute.client.close(), () => ok.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "postgres question" });
    expect(res.decision.targets).toEqual([mute.rec.agentId]);
    expect(res.decision.candidates).toContain(ok.rec.agentId);
    const events = await untilClosed(c, res.threadId);
    expect(events.find((e) => e.event.type === "order.failed")?.event).toMatchObject({ agentId: mute.rec.agentId, reason: "no ack" });
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: ok.rec.agentId });
  });

  it("explicit address skips routing; acked orders survive past the ack timeout via heartbeats", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const slow = await barista(root.addr, identity("slow"), async (h) => {
      await h.ack();
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 150));
        await h.heartbeat(`step ${i}`);
      }
      await h.reply("finally");
    });
    cleanup.push(() => slow.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "take your time", to: "slow@root" });
    expect(res.decision.router).toBe("explicit");
    const events = await untilClosed(c, res.threadId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "finally" });
  });

  it("uses an injected LLM router", async () => {
    const llm: Router = {
      name: "llm",
      decide: async ({ candidates }) => ({ targets: [candidates.find((c) => c.name === "beta")!.agentId], mode: "unicast", reason: "fake llm", router: "llm", candidates: [] }),
    };
    const root = await startDaemon("root", { mode: "root", router: llm });
    cleanup.push(root.stop);
    const a = await barista(root.addr, identity("alpha"));
    const b = await barista(root.addr, identity("beta"));
    cleanup.push(() => a.client.close(), () => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "alpha alpha" });
    expect(res.decision).toMatchObject({ router: "llm", targets: [b.rec.agentId], reason: "fake llm" });
  });

  it("assigns instance numbers per name and host", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const a = await barista(root.addr, identity("dup"));
    const b = await barista(root.addr, identity("dup"));
    cleanup.push(() => a.client.close(), () => b.client.close());
    expect([a.rec.address, b.rec.address]).toEqual(["dup#1@root", "dup#2@root"]);
  });
});

describe("root + child daemon", () => {
  it("replicates the registry and relays cross-host orders through the root", async () => {
    const { root, child } = await rootAndChild();
    const b = await barista(child.addr, identity("pc1-worker", { tags: ["frontend"] }));
    cleanup.push(() => b.client.close());
    await waitFor(() => root.daemon.registry.get(b.rec.agentId) !== undefined);

    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "frontend bug" });
    const events = await untilClosed(c, res.threadId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: b.rec.agentId });
    // Both daemons persisted the thread.
    await waitFor(() => child.daemon.thread(res.threadId)?.meta.status === "done");
    expect(root.daemon.thread(res.threadId)?.events.length).toBeGreaterThan(3);
  });

  it("same-host orders on a child still pass through the root when it is online", async () => {
    const { root, child } = await rootAndChild();
    const b = await barista(child.addr, identity("local-one", { tags: ["x1"] }));
    cleanup.push(() => b.client.close());
    await waitFor(() => child.daemon.registry.get(b.rec.agentId) !== undefined);
    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "x1 please" });
    await untilClosed(c, res.threadId);
    await waitFor(() => root.daemon.thread(res.threadId)?.meta.status === "done");
  });

  it("delivers locally while the root is down and reconnects afterwards", async () => {
    const root = await startDaemon("root", { mode: "root" });
    const port = root.server.port;
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    const b = await barista(child.addr, identity("solo", { tags: ["offline"] }));
    cleanup.push(() => b.client.close());
    await root.stop();
    await waitFor(() => !child.daemon.rootOnline);

    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "offline question" });
    const events = await untilClosed(c, res.threadId);
    expect(events.find((e) => e.event.type === "order.replied")).toBeTruthy();

    // Root comes back on the same port: the child reconnects and re-syncs its agents.
    const root2 = await startDaemon("root", { mode: "root", port });
    cleanup.push(root2.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);
    await waitFor(() => root2.daemon.registry.get(b.rec.agentId) !== undefined);
  });

  it("`root set` repoints a child at a moved root", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: "127.0.0.1:1" } });
    cleanup.push(child.stop);
    expect(child.daemon.rootOnline).toBe(false);
    const res = await fetch(`http://${child.addr}/api/root`, { method: "POST", body: JSON.stringify({ root: root.addr }) });
    expect(res.status).toBe(200);
    await waitFor(() => child.daemon.rootOnline);
  });
});
