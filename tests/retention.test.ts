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

  it("uses the FTS index for queries of 3+ chars and still matches mid-word", async () => {
    const { root, c } = await setup();
    const a = await c.ask({ body: "deploying the billing pipeline" });
    await untilClosed(c, a.threadId, a.orderId);
    expect(root.daemon.store.countIndexed()).toBeGreaterThan(0);
    // A substring in the middle of a word (trigram, not word, matching).
    const mid = await fetch(`http://${root.addr}/api/search?q=illin`).then((r) => r.json());
    expect(mid.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
    // Case-insensitive.
    const upper = await fetch(`http://${root.addr}/api/search?q=BILLING`).then((r) => r.json());
    expect(upper.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
    // Two chars is below the trigram minimum: the JSONL scan answers it.
    const short = await fetch(`http://${root.addr}/api/search?q=de`).then((r) => r.json());
    expect(short.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
  });

  it("backfills reports from Threads that already have ordinary search rows", async () => {
    const { root, c } = await setup();
    const a = await c.ask({ body: "already indexed original request" });
    await untilClosed(c, a.threadId, a.orderId);
    const meta = root.daemon.thread(a.threadId)!.meta;
    root.daemon.store.appendEvent(meta.file, {
      eventId: "report-backfill-test",
      threadId: a.threadId,
      orderId: a.orderId,
      host: "root",
      at: Date.now(),
      event: { type: "order.reported", agentId: "echo", text: "amber compass recovered" },
    });

    root.daemon.backfillSearchIndex();

    const fts = await fetch(`http://${root.addr}/api/search?q=compass%20recover`).then((r) => r.json());
    expect(fts.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
  });

  it("backfill candidates let older Threads progress ahead of newer indexed Threads", async () => {
    const { root, c } = await setup();
    const older = await c.ask({ body: "older indexed request" });
    await untilClosed(c, older.threadId, older.orderId);
    const newer = await c.ask({ body: "newer indexed request" });
    await untilClosed(c, newer.threadId, newer.orderId);
    (root.daemon.store as any).db.prepare("UPDATE threads SET created_at = 1 WHERE thread_id = ?").run(older.threadId);
    (root.daemon.store as any).db.prepare("UPDATE threads SET created_at = 2 WHERE thread_id = ?").run(newer.threadId);

    expect(root.daemon.store.threadsNeedingIndex(1).map((meta) => meta.threadId)).toEqual([older.threadId]);
  });

  it("finds result reports through FTS and short-query fallback", async () => {
    const { root, c } = await setup();
    const a = await c.ask({ body: "unrelated original request" });
    await untilClosed(c, a.threadId, a.orderId);
    const meta = root.daemon.thread(a.threadId)!.meta;
    root.daemon.recordEvent({
      eventId: "report-search-test",
      threadId: a.threadId,
      orderId: a.orderId,
      host: "root",
      at: Date.now(),
      event: { type: "order.reported", agentId: "echo", text: "cobalt ledger reconciled" },
    });

    const fts = await fetch(`http://${root.addr}/api/search?q=ledger%20recon`).then((r) => r.json());
    expect(fts.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
    expect(fts[0].hits).toEqual([expect.objectContaining({ orderId: a.orderId, who: "echo", text: expect.stringContaining("ledger recon") })]);

    const short = await fetch(`http://${root.addr}/api/search?q=co`).then((r) => r.json());
    expect(short.map((x: any) => x.meta.threadId)).toEqual([a.threadId]);
    expect(short[0].hits).toEqual([expect.objectContaining({ orderId: a.orderId, who: "echo", text: expect.stringContaining("cobalt") })]);
  });

  it("a pruned Thread leaves the search index", async () => {
    const { root, c } = await setup();
    const a = await c.ask({ body: "vanishing zebra question" });
    await untilClosed(c, a.threadId, a.orderId);
    const meta = root.daemon.thread(a.threadId)!.meta;
    const old = Date.now() - 40 * 24 * 3600_000;
    root.daemon.store.putThread({ ...meta, createdAt: old, lastActivityAt: old });
    (root.daemon.store as any).db.prepare("UPDATE threads SET created_at = ? WHERE thread_id = ?").run(old, a.threadId);
    const post = (body: unknown) => fetch(`http://${root.addr}/api/prune`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    await post({ olderThanDays: 30, dryRun: false });
    const after = await fetch(`http://${root.addr}/api/search?q=zebra`).then((r) => r.json());
    expect(after).toEqual([]);
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
