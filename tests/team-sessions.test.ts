import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamSpec } from "@cafe/protocol";
import type { CafeClient } from "@cafe/protocol/client";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// v4-13: a team has one front door. `to: <team>` and a fresh message in the team channel reach
// the orchestrator, never everyone; `broadcast` is the only way to wake the whole team; a
// follow-up never falls back to the router; a roster change reaches online members without an
// Order. These tests use the public daemon surface (`publishRoster`, the HTTP API, CafeClient).
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const team = (channel: string, members: Array<{ name: string; duty?: string; observer?: boolean }>) =>
  TeamSpec.parse({
    name: "shop",
    channel,
    members: members.map((m) => ({ name: m.name, ...(m.duty ? { duty: m.duty } : {}), ...(m.observer ? { observer: true } : {}), channels: [channel] })),
  });

const member = (name: string, duty: string | undefined, channel: string, teamName = "shop") =>
  identity(name, { team: teamName, teamChannel: channel, member: name, ...(duty ? { duty } : {}), channels: [channel] });

async function connect(addr: string, name: string, duty: string | undefined, channel: string, teamName = "shop") {
  const b = await barista(addr, member(name, duty, channel, teamName));
  cleanup.push(() => b.client.close());
  return b;
}

describe("team sessions (v4-13)", () => {
  it("routes to: <team> and a fresh team-channel message to the orchestrator only", async () => {
    const d = await startDaemon("ts1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const spec = team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]);
    d.daemon.publishRoster("/tmp/shop", spec);
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const dev1 = await connect(d.addr, "dev1", "developer", "shop");
    const dev2 = await connect(d.addr, "dev2", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const front = await c.ask({ body: "plan the work", to: "shop" });
    expect(front.decision).toMatchObject({ targets: [orch.rec.agentId], mode: "unicast" });
    const fresh = await c.ask({ body: "fresh channel message", channel: "shop" });
    expect(fresh.decision).toMatchObject({ targets: [orch.rec.agentId], mode: "unicast" });
    // The whole team is woken only when the sender says so.
    const all = await c.ask({ body: "stand up", channel: "shop", broadcast: true });
    expect(new Set(all.decision.targets)).toEqual(new Set([orch.rec.agentId, dev1.rec.agentId, dev2.rec.agentId]));
  });

  it("resolves to: <duty> to the unique online member and names an ambiguous duty", async () => {
    const d = await startDaemon("ts2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "t1", duty: "tester" }, { name: "dev1", duty: "developer" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    const tester = await connect(d.addr, "t1", "tester", "shop");
    await connect(d.addr, "dev1", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const ask = await c.ask({ body: "verify the parser", to: "tester", channel: "shop" });
    expect(ask.decision).toMatchObject({ targets: [tester.rec.agentId], mode: "unicast" });

    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "t1", duty: "tester" }, { name: "t2", duty: "tester" }, { name: "dev1", duty: "developer" }]));
    await connect(d.addr, "t2", "tester", "shop");
    const ambiguous = await c.ask({ body: "verify it", to: "tester", channel: "shop" });
    expect(ambiguous.decision).toMatchObject({ targets: [], failure: "ambiguous_duty" });
  });

  it("never sends a follow-up to the rules router when the responders are offline", async () => {
    const d = await startDaemon("ts3", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    const dev1 = await connect(d.addr, "dev1", "developer", "shop");
    const dev2 = await connect(d.addr, "dev2", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const first = await c.ask({ body: "write the parser", to: "dev1", channel: "shop" });
    await untilClosed(c, first.threadId);
    dev1.client.close();
    await waitFor(() => d.daemon.registry.get(dev1.rec.agentId) === undefined, 5000);

    const again = await c.ask({ body: "and the tests?", threadId: first.threadId });
    expect(again.decision).toMatchObject({ targets: [], failure: "responders_offline", router: "followup" });
    // dev2 was never asked and is not woken by the clarification.
    expect(again.decision.targets).not.toContain(dev2.rec.agentId);
  });

  it("delivers the playbook in the registration result and pushes roster changes without an Order", async () => {
    const d = await startDaemon("ts4", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }]));
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const dev1 = await connect(d.addr, "dev1", "developer", "shop");

    expect(orch.client.teamContext).toMatchObject({ team: "shop", channel: "shop", orchestrator: "orch" });
    expect(dev1.client.teamContext?.playbook).toMatch(/member/i);
    const updates: Array<{ team: string; change: { added: string[] } }> = [];
    orch.client.onRoster((u) => updates.push(u as unknown as { team: string; change: { added: string[] } }));
    const ordersBefore = orch.client.recentEvents().length;

    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]));
    await waitFor(() => updates.some((u) => u.change.added.includes("dev2")), 5000);
    // A roster note is not an Order and does not create Thread events.
    expect(orch.client.recentEvents().length).toBe(ordersBefore);
  });

  it("tombstones a removed team and ignores a stale roster update", async () => {
    const d = await startDaemon("ts5", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    const before = d.daemon.teams();
    const old = (d.daemon as unknown as { teamRecords: Map<string, { revision?: number }> }).teamRecords.values().next().value as { revision?: number };
    expect(d.daemon.removeTeam("shop")).toBe(1);
    expect(d.daemon.teams()).toHaveLength(0);
    // A delayed update from before the deletion must not resurrect the team.
    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam({ ...before[0], revision: (old.revision ?? 0) - 1 });
    expect(d.daemon.teams()).toHaveLength(0);
  });

  it("refuses a team channel owned by two teams (ambiguous_channel) but still honours broadcast", async () => {
    const d = await startDaemon("ts6", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/a", TeamSpec.parse({ name: "a", channel: "shared", members: [{ name: "ao", duty: "orchestrator", channels: ["shared"] }] }));
    d.daemon.publishRoster("/tmp/b", TeamSpec.parse({ name: "b", channel: "shared", members: [{ name: "bo", duty: "orchestrator", channels: ["shared"] }] }));
    const ao = await connect(d.addr, "ao", "orchestrator", "shared", "a");
    const bo = await connect(d.addr, "bo", "orchestrator", "shared", "b");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const front = await c.ask({ body: "hello?", channel: "shared" });
    expect(front.decision).toMatchObject({ targets: [], failure: "ambiguous_channel" });
    const all = await c.ask({ body: "everyone", channel: "shared", broadcast: true });
    expect(new Set(all.decision.targets)).toEqual(new Set([ao.rec.agentId, bo.rec.agentId]));
    const channels = (await (await fetch(`http://${d.addr}/api/channels`)).json()) as Array<{ name: string; conflict?: boolean }>;
    expect(channels.find((c2) => c2.name === "shared")?.conflict).toBe(true);
  });

  it("reports no_orchestrator for a loose team with no front door", async () => {
    const d = await startDaemon("ts7", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    // An ad-hoc registration (no authoritative .cafe roster) still appears, but has no front door.
    const dev = await barista(d.addr, identity("dev1", { team: "loose", teamChannel: "loose", member: "dev1", duty: "developer", channels: ["loose"] }));
    cleanup.push(() => dev.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await waitFor(() => d.daemon.teams().some((t) => t.team === "loose"), 5000);
    const res = await c.ask({ body: "anyone?", to: "loose" });
    expect(res.decision).toMatchObject({ targets: [], failure: "no_orchestrator" });
  });

  it("keeps two same-name teams with different channels apart (#108)", async () => {
    const d = await startDaemon("ts8", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/a", TeamSpec.parse({ name: "dup", channel: "alpha", members: [{ name: "ao", duty: "orchestrator", channels: ["alpha"] }, { name: "a1", duty: "developer", channels: ["alpha"] }] }));
    d.daemon.publishRoster("/tmp/b", TeamSpec.parse({ name: "dup", channel: "beta", members: [{ name: "bo", duty: "orchestrator", channels: ["beta"] }] }));
    const ao = await connect(d.addr, "ao", "orchestrator", "alpha", "dup");
    const a1 = await connect(d.addr, "a1", "developer", "alpha", "dup");
    const bo = await connect(d.addr, "bo", "orchestrator", "beta", "dup");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const teams = d.daemon.teams().filter((t) => t.team === "dup");
    expect(teams.map((t) => t.channel).sort()).toEqual(["alpha", "beta"]);
    expect(teams.find((t) => t.channel === "alpha")!.roster.map((m) => m.name)).toEqual(["ao", "a1"]);

    // A sender with no team channel cannot pick between them.
    const neutral = await c.ask({ body: "who?", to: "dup" });
    expect(neutral.decision).toMatchObject({ targets: [], failure: "ambiguous_team" });
    // A member of alpha resolves to alpha's front door, not beta's.
    const fromAlpha = await a1.client.ask({ body: "who?", to: "dup" });
    expect(fromAlpha.decision).toMatchObject({ targets: [ao.rec.agentId], mode: "unicast" });
    expect(fromAlpha.decision.targets).not.toContain(bo.rec.agentId);
  });

  it("removes a roster through the API only after its members stop (#113)", async () => {
    const d = await startDaemon("ts9", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }]));
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const host = d.daemon.host;
    const del = (h = host) => fetch(`http://${d.addr}/api/teams?team=shop&host=${encodeURIComponent(h)}`, { method: "DELETE" });

    const refused = await del();
    expect(refused.status).toBe(409);
    expect(d.daemon.teams()).toHaveLength(1);

    orch.client.close();
    await waitFor(() => d.daemon.registry.get(orch.rec.agentId) === undefined, 5000);
    const ok = await del();
    expect(ok.status, await ok.text()).toBe(200);
    expect(d.daemon.teams()).toHaveLength(0);
    const saved = JSON.parse(readFileSync(join(d.home, "teams.json"), "utf8")) as Array<{ team: string; removed?: boolean }>;
    expect(saved.some((t) => t.team === "shop" && !t.removed)).toBe(false);
  });

  it("lets an explicit broadcast override a follow-up's responder set", async () => {
    const d = await startDaemon("ts10", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster("/tmp/shop", team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]));
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const dev1 = await connect(d.addr, "dev1", "developer", "shop");
    const dev2 = await connect(d.addr, "dev2", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const first = await c.ask({ body: "one", to: "dev1", channel: "shop" });
    await untilClosed(c, first.threadId);
    const all = await c.ask({ body: "everyone", threadId: first.threadId, broadcast: true });
    expect(new Set(all.decision.targets)).toEqual(new Set([orch.rec.agentId, dev1.rec.agentId, dev2.rec.agentId]));
  });
});