import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Peer } from "@cafe/protocol/peer";
import { CafeClient } from "@cafe/protocol/client";
import type { Router } from "../packages/daemon/src/router.ts";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// The v4-11 review found four authorization gaps. Each test here fails on the batch as shipped.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function firstMessage(addr: string, method: string, params: unknown): Promise<{ code?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr}/ws`);
    const peer = new Peer(ws);
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("close", () => peer.closed());
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("no answer"));
    }, 3000);
    ws.on("open", () => {
      peer.request(method, params, 2000).then(
        () => {
          clearTimeout(timer);
          ws.terminate();
          resolve({});
        },
        (err) => {
          clearTimeout(timer);
          ws.terminate();
          resolve({ code: (err as { code?: string }).code });
        },
      );
    });
    ws.on("error", reject);
  });
}

describe("handshake gate", () => {
  it("refuses agent RPC before initialize", async () => {
    const d = await startDaemon("gate1");
    cleanup.push(d.stop);

    const created = await firstMessage(d.addr, "order/create", { body: "injected without a token" });
    expect(created.code).toBe("unknown_method");
    const registered = await firstMessage(d.addr, "agent/register", identity("intruder"));
    expect(registered.code).toBe("unknown_method");

    const snap = (await (await fetch(`http://${d.addr}/api/snapshot`)).json()) as { threads: unknown[] };
    expect(snap.threads).toHaveLength(0);
    expect(d.daemon.registry.all().find((r) => r.name === "intruder")).toBeUndefined();
  });
});

describe("team start never learns an executable from the request body", () => {
  it("loads the roster from disk and only accepts member names", async () => {
    const roster = mkdtempSync(join(tmpdir(), "cafe-roster-"));
    writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: repo-dev\n  members:\n    - name: orch\n      duty: orchestrator\n      dir: .\n    - name: dev1\n      dir: .\n");
    cleanup.push(() => rmSync(roster, { recursive: true, force: true }));

    const d = await startDaemon("team1");
    cleanup.push(d.stop);
    const calls: Array<{ dir: string; team: { channel?: string; agent?: string; members: Array<Record<string, unknown>> } }> = [];
    d.daemon.supervisor = {
      list: () => [],
      commitRosterWriteScopes: () => {},
      stopUnsafeTeamWorkers: async () => ({ stopped: [], pending: [] }),
      startTeam: (dir: string, team: (typeof calls)[number]["team"]) => {
        calls.push({ dir, team });
        return [];
      },
      stopTeam: () => 0,
      start: () => [],
      shutdown: async () => {},
    } as unknown as typeof d.daemon.supervisor;

    const post = (team: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = fetch(`http://${d.addr}/api/baristas`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dir: roster, team }),
        });
        req.then(
          async (res) => resolve({ status: res.status, body: await res.text() }),
          reject,
        );
      });

    const ok = await post({ agent: "codex", channel: "hijacked", members: [{ name: "dev1", bin: "/bin/sh", agent: "codex" }] });
    expect(ok.status, ok.body).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.team.channel).toBe("repo-dev");
    expect(calls[0]!.team.agent).toBeUndefined();
    expect(calls[0]!.team.members[0]).toMatchObject({ name: "dev1" });
    expect(calls[0]!.team.members[0]!.bin).toBeUndefined();
    expect(calls[0]!.team.members[0]!.agent).toBeUndefined();

    const bad = await post({ members: [{ name: "not-in-roster" }] });
    expect(bad.status, bad.body).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("publishes the full roster on sync without starting a worker (v4-13)", async () => {
    const roster = mkdtempSync(join(tmpdir(), "cafe-roster-sync-"));
    writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: repo-dev\n  members:\n    - name: orch\n      duty: orchestrator\n      dir: .\n    - name: human\n      dir: .\n      mode: tui\n");
    cleanup.push(() => rmSync(roster, { recursive: true, force: true }));

    const d = await startDaemon("team-sync");
    cleanup.push(d.stop);
    let started = 0;
    d.daemon.supervisor = {
      list: () => [],
      commitRosterWriteScopes: () => {},
      stopUnsafeTeamWorkers: async () => ({ stopped: [], pending: [] }),
      startTeam: () => {
        started++;
        return [];
      },
      stopTeam: () => 0,
      start: () => [],
      shutdown: async () => {},
    } as unknown as typeof d.daemon.supervisor;

    const res = await fetch(`http://${d.addr}/api/baristas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: roster, team: { members: [{ name: "orch" }] }, sync: true }),
    });
    expect(res.status, await res.text()).toBe(200);
    expect(started).toBe(0);
    expect(d.daemon.teams()[0]!.roster.map((m) => m.name)).toEqual(["orch", "human"]);
  });

  it("publishes a TUI-only roster even though no worker starts", async () => {
    const roster = mkdtempSync(join(tmpdir(), "cafe-roster-tui-"));
    writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: repo-dev\n  members:\n    - name: orch\n      duty: orchestrator\n      dir: .\n    - name: human\n      dir: .\n      mode: tui\n");
    cleanup.push(() => rmSync(roster, { recursive: true, force: true }));

    const d = await startDaemon("team2");
    cleanup.push(d.stop);
    const calls: Array<{ team: { members: Array<Record<string, unknown>> } }> = [];
    d.daemon.supervisor = {
      list: () => [],
      commitRosterWriteScopes: () => {},
      stopUnsafeTeamWorkers: async () => ({ stopped: [], pending: [] }),
      startTeam: (_dir: string, team: (typeof calls)[number]["team"]) => {
        calls.push({ team });
        return [];
      },
      stopTeam: () => 0,
      start: () => [],
      shutdown: async () => {},
    } as unknown as typeof d.daemon.supervisor;

    const res = await fetch(`http://${d.addr}/api/baristas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: roster, team: { members: [{ name: "human" }] } }),
    });
    expect(res.status, await res.text()).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.team.members[0]!.mode).toBe("tui");
    expect(d.daemon.teams().map((t) => t.team)).toEqual(["repo"]);
    expect(d.daemon.teams()[0]!.roster.map((m) => m.name)).toEqual(["orch", "human"]);
  });
});

describe("escalation authorization is per Order, not per Thread", () => {
  it("refuses an agent that was only targeted on an earlier turn", async () => {
    const d = await startDaemon("esc-auth", { mode: "root" });
    cleanup.push(d.stop);

    const alpha = await barista(d.addr, identity("alpha"));
    cleanup.push(() => alpha.client.close());
    const seen: string[] = [];
    const beta = await barista(d.addr, identity("beta"), async (h) => {
      seen.push(h.order.body);
      await h.ack();
      // Hold the Order open: alpha's escalation must be judged while turn 2 is live.
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      await h.reply("beta done");
    });
    cleanup.push(() => beta.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const first = await c.ask({ body: "turn one", to: "alpha" });
    await untilClosed(c, first.threadId, first.orderId);
    const second = await c.ask({ body: "turn two", to: "beta", threadId: first.threadId });
    await waitFor(() => seen.includes("turn two"), 4000);

    const err = await alpha.client
      .ask({ body: "sneak", escalate: true, parentOrderId: second.orderId, parentThreadId: first.threadId })
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe("not_a_target");
  });
});

describe("explicit addressing", () => {
  it("prefers the sender's own Host for a bare name shared by two Hosts", async () => {
    const root = await startDaemon("hub9", { mode: "root" });
    cleanup.push(root.stop);
    const leaf = await startDaemon("leaf9", { config: { root: root.addr } });
    cleanup.push(leaf.stop);

    let localSeen = 0;
    let remoteSeen = 0;
    const local = await barista(root.addr, identity("dev1"), async (h) => {
      localSeen++;
      await h.reply("local");
    });
    cleanup.push(() => local.client.close());
    const remote = await barista(leaf.addr, identity("dev1"), async (h) => {
      remoteSeen++;
      await h.reply("remote");
    });
    cleanup.push(() => remote.client.close());
    await waitFor(() => root.daemon.registry.all().filter((r) => r.name === "dev1").length === 2, 5000);

    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    await c.ask({ body: "hi", to: "dev1" });
    await waitFor(() => localSeen === 1, 4000);
    await new Promise((r) => setTimeout(r, 150));
    expect(remoteSeen).toBe(0);

    await c.ask({ body: "explicit", to: "dev1@leaf9" });
    await waitFor(() => remoteSeen === 1, 4000);
  });
});

describe("observer membership", () => {
  it("keeps an observer out of a team fallback built from registrations", async () => {
    const d = await startDaemon("obs1", { mode: "root" });
    cleanup.push(d.stop);

    let seen = 0;
    const watcher = new CafeClient({ daemon: d.addr });
    watcher.onOrder((h) => {
      seen++;
      void h.decline("observer");
    });
    await watcher.connect(identity("watcher", { observer: true, team: "t1", teamChannel: "chan1", member: "watcher", channels: ["chan1"] }));
    cleanup.push(() => watcher.close());

    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hello team", to: "t1" });
    // v4-13: a team with no orchestrator has no front door; the observer is never a fallback.
    expect(res.decision.failure).toBe("no_orchestrator");
    expect(seen).toBe(0);
  });
});

describe("protocol Order event authorization", () => {
  it("rejects a registered non-target reply without changing the target Order", async () => {
    const d = await startDaemon("event-auth", { mode: "root" });
    cleanup.push(d.stop);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const target = await barista(d.addr, identity("target"), async (h) => {
      await h.ack();
      await held;
      await h.reply("real target answer");
    });
    cleanup.push(() => { release(); target.client.close(); });
    const attacker = await barista(d.addr, identity("attacker"));
    cleanup.push(() => attacker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const order = await c.ask({ body: "original question", to: "target" });
    await waitFor(() => d.daemon.thread(order.threadId)?.meta.status === "working");
    const targetPeer = (target.client as any).peer as Peer;
    const wrongThread = await targetPeer.request("order/reply", { orderId: order.orderId, threadId: "wrong-thread", text: "wrong association", final: true }).catch((e: { code?: string }) => e);
    expect((wrongThread as { code?: string }).code).toBe("not_found");
    const peer = (attacker.client as any).peer as Peer;
    const forgedEvents: Array<[string, Record<string, unknown>]> = [
      ["order/ack", { orderId: order.orderId, threadId: order.threadId }],
      ["order/heartbeat", { orderId: order.orderId, threadId: order.threadId }],
      ["order/decline", { orderId: order.orderId, threadId: order.threadId, reason: "forged" }],
      ["order/reply", { orderId: order.orderId, threadId: order.threadId, text: "forged answer", final: true }],
    ];
    for (const [method, params] of forgedEvents) {
      const error = await peer.request(method, params).catch((e: { code?: string }) => e);
      expect((error as { code?: string }).code).toBe("not_a_target");
    }

    expect(d.daemon.thread(order.threadId)?.meta).toMatchObject({ status: "working", replies: [], declines: [] });
    release();
    await untilClosed(c, order.threadId, order.orderId);
    expect(d.daemon.thread(order.threadId)?.meta.replies[0]?.text).toBe("real target answer");
  });
});

describe("late delivered replies", () => {
  it("does not let a failed remote target's late decline dispatch another fallback", async () => {
    const alpha = identity("alpha");
    const beta = identity("beta");
    const charlie = identity("charlie");
    const router: Router = {
      name: "rules",
      decide: async ({ candidates }) => {
        const byName = new Map(candidates.map((candidate) => [candidate.name, candidate.agentId]));
        return { targets: [byName.get("alpha")!], mode: "unicast" as const, reason: "primary with fallbacks", router: "rules" as const, candidates: [byName.get("beta")!, byName.get("charlie")!] };
      },
    };
    const d = await startDaemon("late-decline", { mode: "root", router, timing: { ...(await import("./helpers.ts")).FAST, unicastDeadlineMs: 5000 } });
    cleanup.push(d.stop);
    const a = new CafeClient({ daemon: d.addr });
    const alphaRecord = await a.connect(alpha);
    cleanup.push(() => a.close());
    let releaseBeta!: () => void;
    const betaHeld = new Promise<void>((resolve) => { releaseBeta = resolve; });
    const b = await barista(d.addr, beta, async (handle) => { await handle.ack(); await betaHeld; await handle.reply("beta answered"); });
    cleanup.push(() => { releaseBeta(); b.client.close(); });
    let charlieSeen = 0;
    const cAgent = await barista(d.addr, charlie, async (handle) => { charlieSeen++; await handle.reply("unexpected third attempt"); });
    cleanup.push(() => cAgent.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const order = await c.ask({ body: "fallback question" });
    expect(order.decision.targets).toEqual([alphaRecord!.agentId]);
    await waitFor(() => Boolean(d.daemon.thread(order.threadId)?.meta.targetStates?.some((state) => state.agentId === alphaRecord!.agentId && state.state === "failed")));
    await waitFor(() => Boolean(d.daemon.thread(order.threadId)?.meta.targetStates?.some((state) => state.agentId === b.rec.agentId && state.state === "acked")));
    d.daemon.recordEvent({ eventId: "late-remote-decline", threadId: order.threadId, orderId: order.orderId, host: "alpha-remote", at: Date.now(), event: { type: "order.declined", agentId: alphaRecord!.agentId, reason: "late decline" } } as import("@cafe/protocol").ThreadEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(charlieSeen).toBe(0);
    expect(d.daemon.thread(order.threadId)?.meta.targetStates?.find((state) => state.agentId === alphaRecord!.agentId)?.state).toBe("failed");
    releaseBeta();
    await untilClosed(c, order.threadId, order.orderId);
    expect(d.daemon.thread(order.threadId)?.meta.replies[0]?.text).toBe("beta answered");
  });

  it("recovers a failed target while another collect-all target keeps the Order open", async () => {
    const d = await startDaemon("late-reply", { mode: "root", timing: { ...(await import("./helpers.ts")).FAST, broadcastDeadlineMs: 5000 } });
    cleanup.push(d.stop);
    const late = new CafeClient({ daemon: d.addr });
    let lateHandle: any;
    late.onOrder((handle) => {
      lateHandle = handle;
      void handle.ack();
    });
    const lateAgent = await late.connect(identity("late"));
    cleanup.push(() => late.close());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = await barista(d.addr, identity("slow"), async (handle) => {
      await handle.ack();
      await held;
      await handle.reply("slow target result");
    });
    cleanup.push(() => { release(); slow.client.close(); });
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const order = await c.ask({ body: "collect both", broadcast: true, collect: "all", deadlineMs: 5000 });
    await waitFor(() => Boolean(lateHandle && d.daemon.thread(order.threadId)?.meta.targetStates?.some((state) => state.agentId === lateAgent!.agentId && state.state === "failed")));
    expect(d.daemon.thread(order.threadId)?.meta.status).toBe("working");
    await lateHandle.reply("late target result");
    expect(d.daemon.thread(order.threadId)?.meta.status).toBe("working");
    release();
    await untilClosed(c, order.threadId, order.orderId);
    expect(d.daemon.thread(order.threadId)?.meta.replies.map((reply) => reply.text).sort()).toEqual(["late target result", "slow target result"]);
  });
});

describe("exact HTTP cancellation", () => {
  it("requires the original owner key and cannot cancel a later turn with the prior ID", async () => {
    const d = await startDaemon("cancel-http", { mode: "root" });
    cleanup.push(d.stop);
    const worker = await barista(d.addr, identity("worker"), async (handle) => { await handle.ack(); });
    cleanup.push(() => worker.client.close());
    const owner = "a".repeat(64);
    const ask = async (body: string, threadId?: string) => {
      const response = await fetch(`http://${d.addr}/api/orders`, {
        method: "POST", headers: { "content-type": "application/json", "x-cafe-order-owner": owner },
        body: JSON.stringify({ body, to: "worker", threadId }),
      });
      expect(response.status).toBe(200);
      return await response.json() as { threadId: string; orderId: string };
    };
    const cancel = async (order: { threadId: string; orderId: string }, key: string) => {
      const response = await fetch(`http://${d.addr}/api/threads/${order.threadId}/orders/${order.orderId}/cancel`, {
        method: "POST", headers: { "x-cafe-order-owner": key },
      });
      return { status: response.status, ...(await response.json() as { error?: string }) };
    };
    const first = await ask("first turn");
    expect(await cancel(first, "b".repeat(64))).toMatchObject({ error: "not_order_owner" });
    expect(await cancel(first, owner)).toEqual({ status: 200 });
    const second = await ask("second turn", first.threadId);
    expect(await cancel(first, owner)).toMatchObject({ error: "stale_order" });
    expect(await cancel(second, owner)).toEqual({ status: 200 });
  });
});

describe("active Order identity", () => {
  it("keeps the old Order open if the replacement cannot be committed", async () => {
    const d = await startDaemon("atomic-replace", { mode: "root", timing: { ackTimeoutMs: 6000 } });
    cleanup.push(d.stop);
    const worker = await barista(d.addr, identity("worker"), async (handle) => { await handle.ack(); });
    cleanup.push(() => worker.client.close());
    const caller = await customer(d.addr);
    cleanup.push(() => caller.close());
    const first = await caller.ask({ body: "old task", to: "worker" });
    const request = { body: "new task", to: "worker", threadId: first.threadId, replaceOrderId: first.orderId };
    const append = d.daemon.store.appendEvent.bind(d.daemon.store);
    const failure = vi.spyOn(d.daemon.store, "appendEvent").mockImplementation((file, env) => {
      if (env.event.type === "order.replaced" || (env.event.type === "order.created" && env.event.order.body === "new task")) {
        throw new Error("replacement write failed");
      }
      return append(file, env);
    });
    try {
      await expect(caller.ask(request)).rejects.toThrow("replacement write failed");
    } finally {
      failure.mockRestore();
    }
    expect(d.daemon.thread(first.threadId)?.meta.orderId).toBe(first.orderId);
    expect(d.daemon.closingEvent(first.threadId, first.orderId)).toBeUndefined();

    const next = await caller.ask(request);
    const events = d.daemon.thread(first.threadId)!.events;
    expect(events.filter(({ event }) => event.type === "order.replaced")).toMatchObject([
      { orderId: next.orderId, event: { previousOrderId: first.orderId, order: { body: "new task" } } },
    ]);
    expect(events.filter(({ orderId, event }) => orderId === first.orderId && event.type === "order.closed")).toHaveLength(0);
    expect(d.daemon.closingEvent(first.threadId, first.orderId)?.event).toMatchObject({ type: "order.closed", status: "cancelled" });
    expect(d.daemon.thread(first.threadId)?.meta.orderId).toBe(next.orderId);
  });

  it("keeps a late reply from clearing the same Thread's newer Order", async () => {
    const d = await startDaemon("active-order", { mode: "root", timing: { ...(await import("./helpers.ts")).FAST, ackTimeoutMs: 1000, heartbeatIntervalMs: 1000 } });
    cleanup.push(d.stop);
    const handles = new Map<string, any>();
    const worker = new CafeClient({ daemon: d.addr });
    worker.onOrder((handle) => {
      handles.set(handle.order.orderId, handle);
      void handle.ack().catch(() => {});
    });
    const record = await worker.connect(identity("worker"));
    cleanup.push(() => worker.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const first = await c.ask({ body: "first turn", to: "worker" });
    await waitFor(() => handles.has(first.orderId));
    await expect(worker.cancel(first.threadId, first.orderId)).rejects.toMatchObject({ code: "not_order_owner" });
    await c.cancel(first.threadId, first.orderId);
    await waitFor(() => d.daemon.thread(first.threadId)?.meta.status === "cancelled");
    const beforeLateNoise = d.daemon.thread(first.threadId)!.events.length;
    d.daemon.recordEvent({ eventId: "late-relayed-heartbeat", threadId: first.threadId, orderId: first.orderId, host: "remote", at: Date.now() + 1, event: { type: "order.heartbeat", agentId: record!.agentId } } as any);
    expect(d.daemon.thread(first.threadId)!.events).toHaveLength(beforeLateNoise);
    await handles.get(first.orderId).ack();
    await handles.get(first.orderId).heartbeat();
    await handles.get(first.orderId).decline("late decline");
    expect(d.daemon.thread(first.threadId)!.events.slice(beforeLateNoise)).toEqual([]);
    const second = await c.ask({ body: "second turn", to: "worker", threadId: first.threadId, replace: true });
    await waitFor(() => handles.has(second.orderId));
    await expect(c.cancel(first.threadId, first.orderId)).rejects.toMatchObject({ code: "stale_order" });
    expect((d.daemon.registry.get(record!.agentId) as any)?.activeOrderId).toBe(second.orderId);

    await handles.get(first.orderId).reply("late first result");
    expect(d.daemon.thread(first.threadId)?.meta.status).toBe("working");
    expect((d.daemon.registry.get(record!.agentId) as any)?.activeOrderId).toBe(second.orderId);
    const firstTurnEvents = d.daemon.thread(first.threadId)!.events.filter((env) => env.orderId === first.orderId);
    expect(firstTurnEvents.find((env) => env.event.type === "order.closed")?.event).toMatchObject({ status: "cancelled" });
    expect(firstTurnEvents.some((env) => env.event.type === "order.replied" && env.event.text === "late first result")).toBe(true);
    await handles.get(second.orderId).reply("second result");
    await untilClosed(c, first.threadId, second.orderId);
    expect((d.daemon.registry.get(record!.agentId) as any)?.activeOrderId).toBeUndefined();
  });
});
describe("linked parent authorization", () => {
  it("validates parent IDs for linked work but preserves a valid order-only provenance field", async () => {
    const d = await startDaemon("linked-ids", { mode: "root" });
    cleanup.push(d.stop);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lead = await barista(d.addr, identity("lead"), async (h) => {
      await h.ack();
      await held;
      await h.reply("parent complete");
    });
    cleanup.push(() => { release(); lead.client.close(); });
    const worker = await barista(d.addr, identity("worker"));
    cleanup.push(() => worker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const parent = await c.ask({ body: "root task", to: "lead" });
    await waitFor(() => d.daemon.thread(parent.threadId)?.meta.status === "working");

    const missing = await lead.client.ask({ body: "missing", to: "worker", parentOrderId: "not-an-order", parentThreadId: parent.threadId }).catch((e: { code?: string }) => e);
    expect((missing as { code?: string }).code).toBe("unknown_parent");
    const mismatch = await lead.client.ask({ body: "mismatch", to: "worker", parentOrderId: parent.orderId, parentThreadId: "other-thread" }).catch((e: { code?: string }) => e);
    expect((mismatch as { code?: string }).code).toBe("unknown_parent");
    const threadOnly = await lead.client.ask({ body: "thread only", to: "worker", parentThreadId: parent.threadId }).catch((e: { code?: string }) => e);
    expect((threadOnly as { code?: string }).code).toBe("bad_request");

    const provenance = await lead.client.ask({ body: "legacy provenance", to: "worker", parentOrderId: parent.orderId });
    expect(d.daemon.thread(provenance.threadId)?.meta).toMatchObject({ parentOrderId: parent.orderId });
    expect(d.daemon.thread(provenance.threadId)?.meta.parentThreadId).toBeUndefined();
    release();
  });

  it("does not cancel an open linked child before rejecting an unauthorized replacement", async () => {
    const d = await startDaemon("linked-replace", { mode: "root" });
    cleanup.push(d.stop);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const worker = await barista(d.addr, identity("worker"), async (h) => {
      await h.ack();
      await held;
      await h.reply("worker finished");
    });
    cleanup.push(() => { release(); worker.client.close(); });
    let childThreadId: string | undefined;
    const lead = await barista(d.addr, identity("lead"), async (h) => {
      const child = await lead.client.ask({ body: "run tests", to: "worker", parentOrderId: h.order.orderId, parentThreadId: h.order.threadId });
      childThreadId = child.threadId;
      await waitFor(() => d.daemon.thread(child.threadId)?.meta.status === "working");
      await h.reply("tests delegated");
    });
    cleanup.push(() => lead.client.close());
    const attacker = await barista(d.addr, identity("attacker"));
    cleanup.push(() => attacker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const parent = await c.ask({ body: "check release", to: "lead" });
    await untilClosed(c, parent.threadId, parent.orderId);
    await waitFor(() => !!childThreadId && d.daemon.thread(childThreadId)?.meta.status === "working");
    const rejected = await attacker.client.ask({ body: "replace work", threadId: childThreadId!, replace: true }).catch((e: { code?: string }) => e);
    expect((rejected as { code?: string }).code).toBe("not_a_target");
    expect(d.daemon.thread(childThreadId!)?.meta.status).toBe("working");
    release();
    await waitFor(() => d.daemon.thread(childThreadId!)?.meta.status === "done");
  });

  it("allows a delivered parent recipient to create linked work but rejects an unrelated agent", async () => {
    const d = await startDaemon("linked-auth", { mode: "root" });
    cleanup.push(d.stop);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lead = await barista(d.addr, identity("lead"), async (h) => {
      await h.ack();
      await held;
      await h.reply("front door replied");
    });
    cleanup.push(() => { release(); lead.client.close(); });
    const worker = await barista(d.addr, identity("worker"));
    cleanup.push(() => worker.client.close());
    const attacker = await barista(d.addr, identity("attacker"));
    cleanup.push(() => attacker.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const parent = await c.ask({ body: "check the release", to: "lead" });
    await waitFor(() => d.daemon.thread(parent.threadId)?.meta.status === "working");
    const forged = await attacker.client.ask({ body: "unrelated work", to: "worker", parentOrderId: parent.orderId, parentThreadId: parent.threadId }).catch((e: { code?: string }) => e);
    expect((forged as { code?: string }).code).toBe("not_a_target");

    const linked = await lead.client.ask({ body: "check parser tests", to: "worker", parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    expect(d.daemon.thread(linked.threadId)?.meta).toMatchObject({ parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    await waitFor(() => d.daemon.thread(linked.threadId)?.meta.status === "done");
    const unauthorizedFollow = await attacker.client.ask({ body: "reopen someone else's task", threadId: linked.threadId }).catch((e: { code?: string }) => e);
    expect((unauthorizedFollow as { code?: string }).code).toBe("not_a_target");
    const authorizedFollow = await lead.client.ask({ body: "verify one more case", threadId: linked.threadId });
    expect(d.daemon.thread(authorizedFollow.threadId)?.meta).toMatchObject({ parentOrderId: parent.orderId, parentThreadId: parent.threadId });
    release();
    await untilClosed(c, parent.threadId, parent.orderId);
  });
});