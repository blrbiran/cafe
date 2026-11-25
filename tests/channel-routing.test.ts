import { afterEach, describe, expect, it } from "vitest";
import { FAST, barista, customer, identity, startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("channel routing (v4-11)", () => {
  it("keeps default and team broadcast pools apart", async () => {
    const d = await startDaemon("ch1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const def = await barista(d.addr, identity("def"));
    cleanup.push(() => def.client.close());
    const teamA = await barista(d.addr, identity("teamA", { channels: ["team"] }));
    cleanup.push(() => teamA.client.close());
    const teamB = await barista(d.addr, identity("teamB", { channels: ["team"] }));
    cleanup.push(() => teamB.client.close());
    const watch = await barista(d.addr, identity("watch", { channels: ["default"], observer: true }));
    cleanup.push(() => watch.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const defBroadcast = await c.ask({ body: "hello all", broadcast: true });
    expect(defBroadcast.decision.targets).toEqual([def.rec.agentId]);

    const teamBroadcast = await teamA.client.ask({ body: "team hello", broadcast: true });
    expect(teamBroadcast.decision.targets).toEqual([teamB.rec.agentId]);

    const explicit = await c.ask({ body: "direct", to: "teamA" });
    expect(explicit.decision.targets).toEqual([teamA.rec.agentId]);
  });

  it("defaults a registered Agent's fresh Order to its home channel", async () => {
    const d = await startDaemon("ch2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const teamA = await barista(d.addr, identity("teamA", { channels: ["team", "default"] }));
    cleanup.push(() => teamA.client.close());
    const teamB = await barista(d.addr, identity("teamB", { channels: ["team"] }));
    cleanup.push(() => teamB.client.close());

    const res = await teamA.client.ask({ body: "question", to: "teamB" });
    await waitFor(() => d.daemon.thread(res.threadId) !== undefined, 5000);
    expect(d.daemon.thread(res.threadId)!.meta.channel).toBe("team");
  });

  it("rejects a follow-up that names another channel", async () => {
    const d = await startDaemon("ch3", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const teamA = await barista(d.addr, identity("teamA", { channels: ["team"] }));
    cleanup.push(() => teamA.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "in team", to: "teamA", channel: "team" });
    await expect(c.ask({ body: "wrong channel", threadId: first.threadId, channel: "default" })).rejects.toMatchObject({ code: "channel_mismatch" });
  });

  it("names an empty channel instead of a generic no-barista failure", async () => {
    const d = await startDaemon("ch4", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const def = await barista(d.addr, identity("def"));
    cleanup.push(() => def.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "anyone here?", channel: "empty" });
    expect(res.decision).toMatchObject({ targets: [], failure: "no_channel_members" });
  });
});