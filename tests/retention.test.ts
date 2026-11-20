import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const root = await startDaemon("root", { config: { mode: "root" } });
  cleanup.push(root.stop);
  const b = await barista(root.addr, identity("echo"));
  cleanup.push(() => b.client.close());
  const c = await customer(root.addr);
  cleanup.push(() => c.close());
  return { root, c };
}

describe("search", () => {
  it("finds questions and answers by substring, newest first", async () => {
    const { root, c } = await setup();
    const a = await c.ask({ body: "the Purple Elephant is late" });
    await untilClosed(c, a.threadId, a.orderId);
    const b = await c.ask({ body: "unrelated question" });
    await untilClosed(c, b.threadId, b.orderId);
    const res = await fetch(`http://${root.addr}/api/search?q=purple%20elephant`).then((r) => r.json());
    expect(res.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
    // Both the question and the echoed answer match.
    expect(res[0].hits.length).toBe(2);
  });
});

describe("prune", () => {
  it("only reports by default, deletes finished threads and stats with dryRun=false", async () => {
    const { root, c } = await setup();
    const a = await c.ask({ body: "old question" });
    await untilClosed(c, a.threadId, a.orderId);
    const meta = root.daemon.thread(a.threadId)!.meta;
    // Age the thread and its stats by rewriting timestamps in the test store.
    const old = Date.now() - 40 * 24 * 3600_000;
    root.daemon.store.putThread({ ...meta, createdAt: old, lastActivityAt: old });
    (root.daemon.store as any).db.prepare("UPDATE threads SET created_at = ? WHERE thread_id = ?").run(old, a.threadId);
    (root.daemon.store as any).db.prepare("UPDATE agent_events SET at = ?").run(old);

    const post = (body: unknown) => fetch(`http://${root.addr}/api/prune`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    const dry = await post({ olderThanDays: 30 });
    expect(dry).toMatchObject({ dryRun: true, threads: 1, agentEvents: 1 });
    expect(existsSync(meta.file)).toBe(true);

    const real = await post({ olderThanDays: 30, dryRun: false });
    expect(real).toMatchObject({ dryRun: false, threads: 1, agentEvents: 1 });
    expect(existsSync(meta.file)).toBe(false);
    expect(root.daemon.store.getThread(a.threadId)).toBeUndefined();

    const again = await post({ olderThanDays: 30, dryRun: false });
    expect(again).toMatchObject({ threads: 0, agentEvents: 0 });
  });

  it("rejects a missing or zero age", async () => {
    const { root } = await setup();
    const r = await fetch(`http://${root.addr}/api/prune`, { method: "POST", body: JSON.stringify({ olderThanDays: 0, dryRun: false }) });
    expect(r.status).toBe(400);
  });
});
