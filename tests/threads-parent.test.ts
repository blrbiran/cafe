import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMeta } from "@cafe/protocol";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// #112: clarification/assignment sub-Threads are queryable by parent; #114: a Thread written
// before channels existed reads back as `channel: "default"` on every API that returns meta.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("sub-Thread links and legacy channel reads (v4-13)", () => {
  it("lists the sub-Threads of a parent Thread", async () => {
    const d = await startDaemon("parent1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    let childThreadId: string | undefined;
    const tester = await barista(d.addr, identity("tester"));
    cleanup.push(() => tester.client.close());
    const w = await barista(d.addr, identity("worker"), async (h) => {
      if (h.order.body === "parent task") {
        const child = await w.client.ask({ body: "child task", to: "tester", parentOrderId: h.order.orderId, parentThreadId: h.order.threadId });
        childThreadId = child.threadId;
      }
      await h.reply(h.order.body === "parent task" ? "assigned" : "finished");
    });
    cleanup.push(() => w.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const parent = await c.ask({ body: "parent task", to: "worker" });
    await untilClosed(c, parent.threadId);
    await waitFor(() => !!childThreadId && d.daemon.thread(childThreadId)?.meta.status === "done");

    const rows = (await (await fetch(`http://${d.addr}/api/threads?parent=${parent.threadId}`)).json()) as ThreadMeta[];
    expect(rows.map((r) => r.threadId)).toEqual([childThreadId]);
    expect(rows[0]!.parentThreadId).toBe(parent.threadId);

    const detail = (await (await fetch(`http://${d.addr}/api/threads/${childThreadId}`)).json()) as { meta: ThreadMeta };
    expect(detail.meta.parentThreadId).toBe(parent.threadId);
    // The parent page sees no children of its own parent.
    expect(d.daemon.store.listThreadsByParent(childThreadId!)).toEqual([]);
  });

  it("reads a pre-channel Thread as default on /api/threads, /api/snapshot and /api/threads/:id", async () => {
    const d = await startDaemon("legacy1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const old: ThreadMeta = {
      threadId: "old-thread",
      orderId: "old-order",
      kind: "order",
      from: { id: "x", address: "person#1@legacy1", host: "legacy1" },
      targets: [],
      status: "done",
      summary: "before channels",
      summaryTurn: 1,
      createdAt: Date.now() - 1000,
      file: join(d.home, "sessions", "old.jsonl"),
      turns: 1,
      replies: [],
      declines: [],
    };
    // Deliberately no `channel`: this is exactly the shape written by a pre-v4-11 daemon.
    d.daemon.store.putThread(old as ThreadMeta);

    const list = (await (await fetch(`http://${d.addr}/api/threads`)).json()) as ThreadMeta[];
    expect(list.find((t) => t.threadId === "old-thread")?.channel).toBe("default");
    const snap = (await (await fetch(`http://${d.addr}/api/snapshot`)).json()) as { threads: ThreadMeta[] };
    expect(snap.threads.find((t) => t.threadId === "old-thread")?.channel).toBe("default");
    const one = (await (await fetch(`http://${d.addr}/api/threads/old-thread`)).json()) as { meta: ThreadMeta };
    expect(one.meta.channel).toBe("default");
    const filtered = (await (await fetch(`http://${d.addr}/api/threads?channel=default`)).json()) as ThreadMeta[];
    expect(filtered.some((t) => t.threadId === "old-thread")).toBe(true);
  });
});