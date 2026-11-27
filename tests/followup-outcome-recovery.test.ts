import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import { Store } from "../packages/daemon/src/store.ts";
import { projectFollowupEvent, recoverFollowupBatch, type FollowupProjectionState } from "../packages/daemon/src/followup-outcome.ts";
import { barista, customer, identity, startDaemon, waitFor } from "./helpers.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cafe-followup-isolated-"));
  return { home, store: new Store(home) };
}
function meta(threadId: string, file: string): ThreadMeta {
  return { threadId, orderId: `${threadId}-next`, kind: "order", from: { id: "cli:user", address: "cli@root", host: "root" }, targets: [], status: "failed", summary: "question", summaryTurn: 2, createdAt: 1, file, turns: 2, replies: [], declines: [] };
}

const history = (threadId: string) => [
  { eventId: `${threadId}-created1`, threadId, orderId: `${threadId}-first`, host: "root", at: 1, event: { type: "order.created", order: { orderId: `${threadId}-first`, threadId, kind: "order", from: { id: "cli:user", address: "cli@root", host: "root" }, body: "first", chain: [], depth: 0, createdAt: 1, turn: 1, history: [] } } },
  { eventId: `${threadId}-reply`, threadId, orderId: `${threadId}-first`, host: "root", at: 2, event: { type: "order.replied", agentId: "worker", text: "saved answer", final: true } },
  { eventId: `${threadId}-close1`, threadId, orderId: `${threadId}-first`, host: "root", at: 3, event: { type: "order.closed", status: "done" } },
  { eventId: `${threadId}-created2`, threadId, orderId: `${threadId}-next`, host: "root", at: 4, event: { type: "order.created", order: { orderId: `${threadId}-next`, threadId, kind: "order", from: { id: "cli:user", address: "cli@root", host: "root" }, body: "follow-up", chain: [], depth: 0, createdAt: 4, turn: 2, history: [] } } },
  { eventId: `${threadId}-routed2`, threadId, orderId: `${threadId}-next`, host: "root", at: 5, event: { type: "order.routed", decision: { targets: [], mode: "unicast", reason: "no recipient", router: "explicit", candidates: [] } } },
  { eventId: `${threadId}-close2`, threadId, orderId: `${threadId}-next`, host: "root", at: 6, event: { type: "order.closed", status: "failed" } },
];

describe("follow-up projection recovery", () => {
  it("exposes the historical answer through the HTTP list after an unroutable follow-up", async () => {
    const root = await startDaemon("followup-outcome", { mode: "root" });
    try {
      const worker = await barista(root.addr, identity("worker"), async (handle) => {
        await handle.ack();
        await handle.reply("saved answer");
      });
      const caller = await customer(root.addr);
      try {
        const first = await caller.ask({ to: "worker", body: "first question" });
        await waitFor(() => root.daemon.thread(first.threadId)?.meta.status === "done");
        worker.client.close();
        await waitFor(() => {
          const agent = root.daemon.registry.get(worker.rec.agentId);
          return !agent || agent.status === "offline";
        });
        const next = await caller.ask({ threadId: first.threadId, body: "follow-up" });
        expect(next.decision.targets).toEqual([]);
        const response = await fetch(`http://${root.addr}/api/threads`);
        expect(response.ok).toBe(true);
        const threads = await response.json() as ThreadMeta[];
        expect(threads.find((thread) => thread.threadId === first.threadId)).toMatchObject({
          orderId: next.orderId,
          status: "failed",
          replies: [],
          followupOutcome: { orderId: next.orderId, answer: { orderId: first.orderId, text: "saved answer" } },
        });
      } finally {
        caller.close();
        worker.client.close();
      }
    } finally {
      await root.stop();
    }
  });
  it("projects a new failed follow-up on its close event without waiting for a sweep", () => {
    const { store } = fixture();
    const file = join(store.home, "sessions", "live.jsonl");
    let current: ThreadMeta = { ...meta("live", file), orderId: "live-first", status: "routing", summaryTurn: 1, turns: 1 };
    store.putThread(current);
    for (const raw of history("live")) {
      const env = raw as unknown as ThreadEnvelope;
      if (env.event.type === "order.created") {
        current = { ...current, orderId: env.event.order.orderId, status: "routing", turns: env.event.order.turn, summaryTurn: env.event.order.turn, replies: [] };
      } else if (env.event.type === "order.routed") current = { ...current, status: "delivering" };
      else if (env.event.type === "order.closed" && "status" in env.event) current = { ...current, status: env.event.status };
      const before = store.journalSize(file);
      const written = store.appendEvent(file, env as never);
      projectFollowupEvent(store, current, env as never, before, written, () => "worker@root");
    }
    expect(store.getThread("live")).toMatchObject({ orderId: "live-next", status: "failed", replies: [], followupOutcome: { orderId: "live-next", answer: { orderId: "live-first", turn: 1, address: "worker@root", text: "saved answer" } } });
    store.close();
  });

  it("resumes a journal append after restart without rereading committed bytes", () => {
    const { store } = fixture();
    const file = join(store.home, "sessions", "resume.jsonl");
    store.putThread(meta("resume", file));
    for (const env of history("resume").slice(0, 3)) store.appendEvent(file, env as never);
    expect(recoverFollowupBatch(store, { limit: 1 }).processed).toBe(1);
    const progress = store.getFollowupProgress<FollowupProjectionState>("resume");
    expect(progress?.state.lastAnswer).toMatchObject({ orderId: "resume-first", text: "saved answer" });
    for (const env of history("resume").slice(3)) store.appendEvent(file, env as never);
    store.close();
    const restarted = new Store(store.home);
    expect(recoverFollowupBatch(restarted, { limit: 1 }).processed).toBe(1);
    expect(restarted.getThread("resume")?.followupOutcome).toMatchObject({ orderId: "resume-next", answer: { orderId: "resume-first", text: "saved answer" } });
    expect(recoverFollowupBatch(restarted, { limit: 1 }).updated).toEqual([]);
    restarted.close();
  });

  it("resumes an unfinished bounded scan after restarting the Store", () => {
    const { store } = fixture();
    const file = join(store.home, "sessions", "bounded-restart.jsonl");
    store.putThread(meta("bounded-restart", file));
    for (const env of history("bounded-restart")) store.appendEvent(file, env as never);
    expect(recoverFollowupBatch(store, { limit: 1, maxEventsPerThread: 2 }).processed).toBe(1);
    expect(store.getFollowupProgress("bounded-restart")?.complete).toBe(false);
    store.close();
    const restarted = new Store(store.home);
    recoverFollowupBatch(restarted, { limit: 1, maxEventsPerThread: 2 });
    recoverFollowupBatch(restarted, { limit: 1, maxEventsPerThread: 2 });
    expect(restarted.getThread("bounded-restart")?.followupOutcome?.orderId).toBe("bounded-restart-next");
    restarted.close();
  });

  it("skips an unavailable journal and still recovers the next thread", () => {
    const { store } = fixture();
    store.putThread(meta("missing", join(store.home, "sessions", "missing.jsonl")));
    const file = join(store.home, "sessions", "available.jsonl");
    store.putThread(meta("available", file));
    for (const env of history("available")) store.appendEvent(file, env as never);
    const batch = recoverFollowupBatch(store, { limit: 2 });
    expect(batch.processed).toBe(1);
    expect(batch.unavailable).toEqual(["missing"]);
    expect(store.getThread("available")?.followupOutcome?.orderId).toBe("available-next");
    const missingFile = join(store.home, "sessions", "missing.jsonl");
    for (const env of history("missing")) store.appendEvent(missingFile, env as never);
    expect(recoverFollowupBatch(store, { limit: 2 }).unavailable).toEqual([]);
    expect(store.getThread("missing")?.followupOutcome?.orderId).toBe("missing-next");
    store.close();
  });

  it("bounds journal reads by both bytes and records", () => {
    const { store } = fixture();
    const file = join(store.home, "sessions", "bounded.jsonl");
    for (const env of history("bounded")) store.appendEvent(file, env as never);
    const byteBound = store.readEventsFromOffset(file, 0, 1, 500);
    expect(byteBound.events).toHaveLength(1);
    expect(byteBound.offset).toBeLessThan(byteBound.fileSize);
    const recordBound = store.readEventsFromOffset(file, 0, Number.MAX_SAFE_INTEGER, 2);
    expect(recordBound.events).toHaveLength(2);
    expect(recordBound.offset).toBeLessThan(recordBound.fileSize);
    store.close();
  });

  it("removes projection progress when a Thread is pruned", () => {
    const { store } = fixture();
    const thread = meta("pruned", join(store.home, "sessions", "pruned.jsonl"));
    store.putThread(thread);
    store.saveFollowupProgress(thread.threadId, { offset: 10, complete: false, state: { lastAnswer: { orderId: "old", turn: 1, agentId: "worker", text: "answer", truncated: false } } });
    store.deleteThreads([thread]);
    expect(store.getFollowupProgress(thread.threadId)).toBeUndefined();
    store.close();
  });

  it("bounds each recovery pass and retains progress with projected metadata", () => {
    const { store } = fixture();
    for (const id of ["one", "two", "three"]) {
      const file = join(store.home, "sessions", `${id}.jsonl`);
      store.putThread(meta(id, file));
      for (const env of history(id)) store.appendEvent(file, env as never);
    }
    expect(recoverFollowupBatch(store, { limit: 2 }).processed).toBe(2);
    expect(["one", "two", "three"].filter((id) => store.getFollowupProgress(id) === undefined)).toHaveLength(1);
    store.close();
  });
});
