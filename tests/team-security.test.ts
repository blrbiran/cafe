import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Peer } from "@cafe/protocol/peer";
import { CafeClient } from "@cafe/protocol/client";
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