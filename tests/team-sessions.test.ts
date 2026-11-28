import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamSpec } from "@cafe/protocol";
import { CafeClient } from "@cafe/protocol/client";
import { managedAgentResumeStore } from "@cafe/protocol/cafe-file";
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
    d.daemon.publishRoster(d.home, spec);
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const dev1 = await connect(d.addr, "dev1", "developer", "shop");
    const dev2 = await connect(d.addr, "dev2", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const front = await c.ask({ body: "plan the work", to: "shop" });
    expect(front.decision).toMatchObject({ targets: [orch.rec.agentId], mode: "unicast" });
    expect(d.daemon.thread(front.threadId)?.meta.channel).toBe("shop");
    const self = await orch.client.ask({ body: "new task" });
    expect(self.decision.targets).toEqual([]);
    expect(self.decision.reason).toMatch(/address a member/i);
    const explicitSelf = await orch.client.ask({ body: "new task", to: "shop" });
    expect(explicitSelf.decision.targets).toEqual([]);
    const direct = await c.ask({ body: "write the parser", to: "dev1" });
    await untilClosed(c, direct.threadId);
    expect(d.daemon.thread(direct.threadId)?.meta.channel).toBe("shop");
    expect((await c.ask({ body: "add a test", threadId: direct.threadId })).decision.targets).toEqual([dev1.rec.agentId]);
    const fresh = await c.ask({ body: "fresh channel message", channel: "shop" });
    expect(fresh.decision).toMatchObject({ targets: [orch.rec.agentId], mode: "unicast" });
    // The whole team is woken only when the sender says so.
    const all = await c.ask({ body: "stand up", channel: "shop", broadcast: true });
    expect(new Set(all.decision.targets)).toEqual(new Set([orch.rec.agentId, dev1.rec.agentId, dev2.rec.agentId]));
    await untilClosed(c, all.threadId);
    const followUp = await c.ask({ body: "can you clarify?", threadId: all.threadId });
    expect(followUp.decision).toMatchObject({ targets: [], failure: "ambiguous_address" });
    expect((await c.ask({ body: "can you clarify?", threadId: all.threadId, to: "orch" })).decision.targets).toEqual([orch.rec.agentId]);
  });

  it("resolves to: <duty> to the unique online member and names an ambiguous duty", async () => {
    const d = await startDaemon("ts2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "t1", duty: "tester" }, { name: "dev1", duty: "developer" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const absent = await c.ask({ body: "check the parser", to: "tester", channel: "shop" });
    expect(absent.decision.failure).toBe("no_online_barista");
    const named = await c.ask({ body: "check the parser", to: "t1", channel: "shop" });
    expect(named.decision.failure).toBe("no_online_barista");
    const tester = await connect(d.addr, "t1", "tester", "shop");
    await connect(d.addr, "dev1", "developer", "shop");

    const ask = await c.ask({ body: "verify the parser", to: "tester", channel: "shop" });
    expect(ask.decision).toMatchObject({ targets: [tester.rec.agentId], mode: "unicast" });

    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "t1", duty: "tester" }, { name: "t2", duty: "tester" }, { name: "dev1", duty: "developer" }]));
    await connect(d.addr, "t2", "tester", "shop");
    const ambiguous = await c.ask({ body: "verify it", to: "tester", channel: "shop" });
    expect(ambiguous.decision).toMatchObject({ targets: [], failure: "ambiguous_duty" });
  });

  it("keeps natural language at the front door and exposes job phrases for explicit delegation", async () => {
    const d = await startDaemon("ts-phrases", { mode: "root" });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, TeamSpec.parse({ name: "shop", channel: "shop", members: [
      { name: "orch", duty: "orchestrator" },
      { name: "dev", duty: "developer", dutyAliases: ["实现解析器"] },
      { name: "qa", duty: "tester", dutyAliases: ["补单元测试"] },
    ] }));
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const dev = await connect(d.addr, "dev", "developer", "shop");
    const qa = await connect(d.addr, "qa", "tester", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    for (const [body, duty, member] of [["实现解析器", "developer", dev], ["补单元测试", "tester", qa]] as const) {
      const intake = await c.ask({ body, to: "shop" });
      expect(intake.decision.targets).toEqual([orch.rec.agentId]);
      expect(orch.client.teamContext?.playbook).toContain(`${duty}: ${body}`);
      const assigned = await orch.client.ask({ body, to: duty, parentOrderId: intake.orderId, parentThreadId: intake.threadId });
      expect(assigned.decision.targets).toEqual([member.rec.agentId]);
    }
  });

  it("never sends a follow-up to the rules router when the responders are offline", async () => {
    const d = await startDaemon("ts3", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]));
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
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }]));
    const orch = await connect(d.addr, "orch", "orchestrator", "shop");
    const dev1 = await connect(d.addr, "dev1", "developer", "shop");

    expect(orch.client.teamContext).toMatchObject({ team: "shop", channel: "shop", orchestrator: "orch" });
    expect(dev1.client.teamContext?.playbook).toMatch(/member/i);
    const updates: Array<{ team: string; change: { added: string[] } }> = [];
    orch.client.onRoster((u) => updates.push(u as unknown as { team: string; change: { added: string[] } }));
    const ordersBefore = orch.client.recentEvents().length;

    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]));
    await waitFor(() => updates.some((u) => u.change.added.includes("dev2")), 5000);
    // A roster note is not an Order and does not create Thread events.
    expect(orch.client.recentEvents().length).toBe(ordersBefore);
  });

  it("does not send new direct Orders to removed roster members that are still online", async () => {
    const d = await startDaemon("ts-removed", { mode: "root" });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev", duty: "developer" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    const dev = await connect(d.addr, "dev", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }]));
    const direct = await c.ask({ body: "new assignment", to: dev.rec.address });
    expect(direct.decision.targets).toEqual([]);
  });

  it("tombstones a removed team and ignores a stale roster update", async () => {
    const d = await startDaemon("ts5", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    const before = d.daemon.teams();
    const old = (d.daemon as unknown as { teamRecords: Map<string, { revision?: number }> }).teamRecords.values().next().value as { revision?: number };
    expect(d.daemon.removeTeam("shop")).toBe(1);
    expect(d.daemon.teams()).toHaveLength(0);
    // A delayed update from before the deletion must not resurrect the team.
    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam({ ...before[0], revision: (old.revision ?? 0) - 1 });
    expect(d.daemon.teams()).toHaveLength(0);
  });

  it("scopes duty and broadcasts in a shared channel to the sender's team", async () => {
    const d = await startDaemon("ts6", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, TeamSpec.parse({ name: "a", channel: "shared", members: [{ name: "ao", duty: "orchestrator", channels: ["shared"] }, { name: "a1", duty: "developer", channels: ["shared"] }] }));
    d.daemon.publishRoster(d.home, TeamSpec.parse({ name: "b", channel: "shared", members: [{ name: "bo", duty: "orchestrator", channels: ["shared"] }] }));
    const ao = await connect(d.addr, "ao", "orchestrator", "shared", "a");
    const bo = await connect(d.addr, "bo", "orchestrator", "shared", "b");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const front = await c.ask({ body: "hello?", channel: "shared" });
    expect(front.decision).toMatchObject({ targets: [], failure: "ambiguous_channel" });
    const a1 = await connect(d.addr, "a1", "developer", "shared", "a");
    const inner = await bo.client.ask({ body: "implement it", to: "developer" });
    expect(inner.decision.targets).toEqual([]);
    const scoped = await ao.client.ask({ body: "everyone in A", broadcast: true });
    expect(scoped.decision.targets).toEqual([a1.rec.agentId]);
    const all = await c.ask({ body: "everyone", channel: "shared", broadcast: true });
    expect(all.decision).toMatchObject({ targets: [], failure: "ambiguous_channel" });
    const channels = (await (await fetch(`http://${d.addr}/api/channels`)).json()) as Array<{ name: string; conflict?: boolean }>;
    expect(channels.find((c2) => c2.name === "shared")?.conflict).toBe(true);
  });

  it("does not treat a loose sender as belonging to another team on a shared channel", async () => {
    const d = await startDaemon("ts-loose", { mode: "root" });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev", duty: "developer" }]));
    await connect(d.addr, "orch", "orchestrator", "shop");
    await connect(d.addr, "dev", "developer", "shop");
    const loose = await connect(d.addr, "loose-orch", "orchestrator", "shop", "loose");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    expect((await c.ask({ body: "hello", to: "loose" })).decision.failure).toBe("no_orchestrator");
    expect((await loose.client.ask({ body: "roll call", broadcast: true })).decision.targets).toEqual([]);
    expect((await loose.client.ask({ body: "check the parser", to: "developer" })).decision.targets).toEqual([]);
    expect((await c.ask({ body: "roll call", channel: "shop", broadcast: true })).decision.failure).toBe("ambiguous_channel");
  });

  it("allows a normal channel broadcast when its only roster is loose", async () => {
    const d = await startDaemon("ts-loose-channel", { mode: "root" });
    cleanup.push(d.stop);
    const loose = await connect(d.addr, "loose-orch", "orchestrator", "shop", "loose");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    expect((await c.ask({ body: "roll call", channel: "shop", broadcast: true })).decision.targets).toEqual([loose.rec.agentId]);
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
    d.daemon.publishRoster(d.home, TeamSpec.parse({ name: "dup", channel: "alpha", members: [{ name: "ao", duty: "orchestrator", channels: ["alpha"] }, { name: "a1", duty: "developer", channels: ["alpha"] }] }));
    d.daemon.publishRoster(d.home, TeamSpec.parse({ name: "dup", channel: "beta", members: [{ name: "bo", duty: "orchestrator", channels: ["beta"] }] }));
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
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }]));
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

  it("records a late front-door report on the original human Order exactly once", async () => {
    const d = await startDaemon("report", { mode: "root" });
    cleanup.push(d.stop);
    const lead = await barista(d.addr, identity("lead"));
    cleanup.push(() => lead.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "review release", to: "lead" });
    await untilClosed(c, first.threadId, first.orderId);
    const report = { orderId: first.orderId, threadId: first.threadId, text: "all regressions covered" };
    await lead.client.report(report);
    await lead.client.report(report);
    await waitFor(() => c.recentEvents(first.threadId).some((e) => e.event.type === "order.reported"));
    const result = d.daemon.thread(first.threadId)!;
    expect(result.meta).toMatchObject({ status: "done", turns: 1 });
    expect(result.events.filter((e) => e.event.type === "order.reported")).toEqual([
      expect.objectContaining({ orderId: first.orderId, event: { type: "order.reported", agentId: lead.rec.agentId, text: report.text } }),
    ]);
  });

  it("resumes a Barista and reports on its original Order from a fresh client", async () => {
    const d = await startDaemon("report-resume", { mode: "root" });
    cleanup.push(d.stop);
    const stateFile = join(d.home, "agent-identities", "lead.json");
    const resume = managedAgentResumeStore(stateFile)!;
    const lead = new CafeClient({ daemon: d.addr, resumeStore: resume });
    cleanup.push(() => lead.close());
    lead.onOrder((h) => { void h.ack().then(() => h.reply("assigned")).catch(() => {}); });
    const first = await lead.connect(identity("lead"));
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const order = await c.ask({ body: "review release", to: "lead" });
    await untilClosed(c, order.threadId, order.orderId);
    const delivered = d.daemon.thread(order.threadId)?.events.find(({ event }) => event.type === "order.delivered")?.event;
    expect(delivered?.type).toBe("order.delivered");
    if (delivered?.type !== "order.delivered" || !delivered.assignmentId) throw new Error("missing durable assignment");
    expect(d.daemon.store.getRecipientAssignmentReceipt(delivered.assignmentId)?.agentId).toBe(first!.agentId);
    lead.close();
    await waitFor(() => (d.daemon.registry.get(first!.agentId)?.status ?? "offline") === "offline");
    const restored = new CafeClient({ daemon: d.addr, resumeStore: managedAgentResumeStore(stateFile) });
    cleanup.push(() => restored.close());
    expect((await restored.connect(identity("lead")))?.agentId).toBe(first!.agentId);
    await restored.report({ ...order, text: "finished after resume" });
    expect(d.daemon.thread(order.threadId)?.events.some(({ event }) => event.type === "order.reported")).toBe(true);
  });

  it.each(["receipt lost", "before acknowledgement"] as const)("resumes a queued assignment after interruption (%s)", async (interruption) => {
    const d = await startDaemon("receipt-resume", { mode: "root", timing: { ...FAST, ackTimeoutMs: 3000 } });
    cleanup.push(d.stop);
    const file = join(d.home, "agent-identities", "worker.json");
    const resume = managedAgentResumeStore(file)!;
    const first = new CafeClient({ daemon: d.addr, resumeStore: resume });
    cleanup.push(() => first.close());
    let injected = 0;
    first.onOrder(() => {
      if (interruption === "before acknowledgement") first.close();
      else injected++;
    });
    const agent = await first.connect(identity("worker"));
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const target = d.daemon as unknown as { acceptRecipientAssignment: (...args: unknown[]) => Promise<{ active: boolean }> };
    const accept = target.acceptRecipientAssignment.bind(target);
    if (interruption === "receipt lost") {
      const drop = vi.spyOn(target, "acceptRecipientAssignment").mockImplementationOnce(async (...args) => {
        await accept(...args);
        first.close();
        throw new Error("simulated dropped receipt response");
      });
      cleanup.push(() => { drop.mockRestore(); });
    }
    const created = await c.ask({ body: "run the assigned task", to: "worker" });
    await waitFor(() => (d.daemon.registry.get(agent!.agentId)?.status ?? "offline") === "offline");
    expect(resume.queue!.list()).toHaveLength(1);
    expect(injected).toBe(0);
    const restarted = new CafeClient({ daemon: d.addr, resumeStore: managedAgentResumeStore(file) });
    cleanup.push(() => restarted.close());
    restarted.onOrder((h) => {
      injected++;
      void h.ack().then(() => h.reply("done after receipt retry")).catch(() => {});
    });
    expect((await restarted.connect(identity("worker")))?.agentId).toBe(agent!.agentId);
    const events = await untilClosed(c, created.threadId, created.orderId);
    expect(events.filter(({ event }) => event.type === "order.delivered")).toHaveLength(1);
    expect(events.filter(({ event }) => event.type === "order.replied")).toHaveLength(1);
    expect(injected).toBe(1);
  });

  it("recovers a late result report after the reporting and requester Hosts reconnect", async () => {
    const root = await startDaemon("report-root", { mode: "root" });
    cleanup.push(root.stop);
    const origin = await startDaemon("report-origin", { config: { root: root.addr } });
    cleanup.push(origin.stop);
    const remote = await startDaemon("report-remote", { config: { root: root.addr } });
    cleanup.push(remote.stop);
    const agent = await barista(remote.addr, identity("lead"));
    cleanup.push(() => agent.client.close());
    const c = await customer(origin.addr);
    cleanup.push(() => c.close());
    await waitFor(() => !!origin.daemon.registry.get(agent.rec.agentId));
    const parent = await c.ask({ body: "review the release", to: "lead" });
    await untilClosed(c, parent.threadId, parent.orderId);
    await waitFor(() => remote.daemon.thread(parent.threadId)?.meta.status === "done");
    origin.daemon.setRoot("127.0.0.1:1");
    remote.daemon.setRoot("127.0.0.1:1");
    await waitFor(() => !origin.daemon.rootOnline && !remote.daemon.rootOnline);
    const report = { threadId: parent.threadId, orderId: parent.orderId, text: "final release review" };
    await expect(agent.client.report(report)).rejects.toMatchObject({ code: "report_pending" });
    remote.daemon.setRoot(root.addr);
    const hasReport = (events: import("@cafe/protocol").ThreadEnvelope[]) => events.filter((env) => env.event.type === "order.reported");
    await waitFor(() => hasReport(root.daemon.thread(parent.threadId)?.events ?? []).length === 1);
    origin.daemon.setRoot(root.addr);
    await waitFor(() => origin.daemon.rootOnline);
    const url = `http://${origin.addr}/api/threads/${parent.threadId}`;
    await waitFor(async () => {
      const result = await (await fetch(`${url}/result?orderId=${parent.orderId}`)).json();
      return result.reports?.some((entry: { text: string }) => entry.text === report.text) === true;
    });
    const detail = await (await fetch(url)).json();
    expect(hasReport(detail.events)).toEqual([expect.objectContaining({ orderId: parent.orderId, event: { type: "order.reported", agentId: agent.rec.agentId, text: report.text } })]);
    expect(detail.meta.status).toBe("done");
  });

  it.each([false, true])("projects child work to the customer Host (disconnect before closure: %s)", async (disconnect) => {
    const root = await startDaemon("project-root", { mode: "root" });
    cleanup.push(root.stop);
    const origin = await startDaemon("project-origin", { config: { root: root.addr } });
    cleanup.push(origin.stop);
    const leadHost = await startDaemon("project-lead", { config: { root: root.addr } });
    cleanup.push(leadHost.stop);
    root.daemon.publishRoster(root.home, team("reporting", [{ name: "lead", duty: "orchestrator" }]));
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    cleanup.push(finish);
    const dev = await barista(root.addr, identity("dev"), async (h) => {
      await h.ack();
      await barrier;
      await h.reply("parser regression covered");
    });
    cleanup.push(() => dev.client.close());
    const lead = await barista(leadHost.addr, identity("lead"), async (h) => {
      await h.ack();
      await lead.client.ask({ body: "check parsing", channel: "reporting", to: "dev", parentThreadId: h.order.threadId, parentOrderId: h.order.orderId });
      await h.reply("tester is working on parsing", false);
      await h.reply("delegated");
    });
    cleanup.push(() => lead.client.close());
    await waitFor(() => origin.daemon.registry.get(lead.rec.agentId) !== undefined && leadHost.daemon.registry.get(dev.rec.agentId) !== undefined);
    const c = await customer(origin.addr);
    cleanup.push(() => c.close());
    const parent = await c.ask({ body: "verify the release", to: "lead" });
    await untilClosed(c, parent.threadId, parent.orderId);
    const childUrl = `http://${origin.addr}/api/threads?parent=${parent.threadId}`;
    const children = async () => (await fetch(childUrl)).json() as Promise<import("@cafe/protocol").ThreadMeta[]>;
    await waitFor(async () => (await children())[0]?.status === "working", 1500);
    const [child] = await children();
    expect(child).toMatchObject({ parentOrderId: parent.orderId });
    expect(origin.daemon.thread(parent.threadId)?.meta.status).toBe("done");
    const parentDetail = await (await fetch(`http://${origin.addr}/api/threads/${parent.threadId}`)).json();
    expect(parentDetail.meta).toMatchObject({ status: "done", taskStatus: "working" });
    const threadList = await (await fetch(`http://${origin.addr}/api/threads`)).json() as import("@cafe/protocol").ThreadMeta[];
    expect(threadList.find((meta) => meta.threadId === parent.threadId)?.taskStatus).toBe("working");
    const rootThreadList = await (await fetch(`http://${root.addr}/api/threads`)).json() as import("@cafe/protocol").ThreadMeta[];
    expect(rootThreadList.find((meta) => meta.threadId === parent.threadId)?.taskStatus).toBe("working");
    const snapshot = await (await fetch(`http://${origin.addr}/api/snapshot`)).json() as { threads: import("@cafe/protocol").ThreadMeta[] };
    expect(snapshot.threads.find((meta) => meta.threadId === parent.threadId)?.taskStatus).toBe("working");
    const search = await (await fetch(`http://${origin.addr}/api/search?q=verify`)).json() as Array<{ meta: import("@cafe/protocol").ThreadMeta }>;
    expect(search.find((result) => result.meta.threadId === parent.threadId)?.meta.taskStatus).toBe("working");
    const teams = await (await fetch(`http://${root.addr}/api/teams`)).json() as Array<{ channel: string; openThreads: number }>;
    expect(teams.find((t) => t.channel === "reporting")?.openThreads).toBeGreaterThanOrEqual(1);
    if (disconnect) {
      origin.daemon.setRoot("127.0.0.1:1");
      await waitFor(() => !origin.daemon.rootOnline);
      const partial = await (await fetch(`http://${origin.addr}/api/threads/${parent.threadId}`)).json();
      expect(partial.meta).toMatchObject({ taskStatus: "working" });
    }
    finish();
    await waitFor(() => root.daemon.thread(child!.threadId)?.meta.status === "done");
    if (disconnect) {
      expect(origin.daemon.thread(child!.threadId)?.meta.status).toBe("working");
      origin.daemon.setRoot(root.addr);
      await waitFor(() => origin.daemon.rootOnline);
    } else {
      await waitFor(() => c.recentEvents(child!.threadId).some((e) => e.event.type === "order.closed"), 1500);
    }
    await waitFor(async () => (await children())[0]?.replies[0]?.text === "parser regression covered", 1500);
    const detailUrl = `http://${origin.addr}/api/threads/${child!.threadId}`;
    await waitFor(async () => {
      const detail = await (await fetch(detailUrl)).json() as { meta?: { status: string; parentOrderId?: string }; events?: import("@cafe/protocol").ThreadEnvelope[] };
      return detail.meta?.status === "done" && detail.meta.parentOrderId === parent.orderId &&
        detail.events?.some((env) => env.event.type === "order.closed" && env.event.status === "done") === true;
    });
    const parentStatus = async () => (await (await fetch(`http://${origin.addr}/api/threads/${parent.threadId}`)).json() as { meta: { taskStatus?: string } }).meta.taskStatus;
    // Both Hosts index the child under the exact parent Order, independent of display paging.
    expect(origin.daemon.store.listThreadsByParentOrder(parent.threadId, parent.orderId).map((row) => row.threadId)).toEqual([child!.threadId]);
    expect(root.daemon.store.listThreadsByParentOrder(parent.threadId, parent.orderId).map((row) => row.threadId)).toEqual([child!.threadId]);
    await waitFor(async () => await parentStatus() === "awaiting_report");
    await lead.client.report({ threadId: parent.threadId, orderId: parent.orderId, text: "parser regression reviewed" });
    await waitFor(async () => await parentStatus() === "done");
    const snapshotTaskStatus = async () => {
      const snapshot = await (await fetch(`http://${origin.addr}/api/snapshot`)).json() as { threads: import("@cafe/protocol").ThreadMeta[] };
      return snapshot.threads.find((meta) => meta.threadId === parent.threadId)?.taskStatus;
    };
    await waitFor(async () => await snapshotTaskStatus() === "done");
  });

  it("keeps taskStatus unknown when the display child page omits an older open child", async () => {
    const d = await startDaemon("child-cap", { mode: "root" });
    cleanup.push(d.stop);
    const lead = await barista(d.addr, identity("lead"));
    cleanup.push(() => lead.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const parent = await c.ask({ body: "large task", to: "lead" });
    await untilClosed(c, parent.threadId, parent.orderId);
    const parentMeta = d.daemon.thread(parent.threadId)!.meta;
    const baseAt = Date.now() - 1000;
    for (let i = 0; i < 201; i++) {
      const id = String(i).padStart(3, "0");
      const threadId = `child-cap-${id}`;
      const createdAt = baseAt + i;
      d.daemon.store.putThread({
        threadId,
        orderId: `child-order-${id}`,
        kind: "order",
        channel: parentMeta.channel ?? "default",
        parentThreadId: parent.threadId,
        parentOrderId: parent.orderId,
        parentOwnerVerified: true,
        from: { id: `cli:child-${id}`, address: `cli@child-cap`, host: "child-cap" },
        origin: "human",
        targets: [],
        status: i === 0 ? "working" : "done",
        summary: `child ${id}`,
        summaryTurn: 1,
        createdAt,
        file: d.daemon.store.threadFile(threadId, createdAt),
        turns: 1,
        replies: [],
        declines: [],
      });
    }

    const detail = await (await fetch(`http://${d.addr}/api/threads/${parent.threadId}`)).json();
    // Status uses every child of the exact parent Order; the display page being capped only marks the list partial.
    expect(detail.meta).toMatchObject({ taskStatus: "working", childrenPartial: true });
  });

  it("keeps locally known linked work active when Root has not indexed the child yet", async () => {
    const root = await startDaemon("unsynced-root", { mode: "root" });
    cleanup.push(root.stop);
    const origin = await startDaemon("unsynced-origin", { config: { root: root.addr } });
    cleanup.push(origin.stop);
    const lead = await barista(root.addr, identity("lead"));
    cleanup.push(() => lead.client.close());
    const c = await customer(origin.addr);
    cleanup.push(() => c.close());
    await waitFor(() => !!origin.daemon.registry.get(lead.rec.agentId));
    const parent = await c.ask({ body: "review on origin", to: "lead@unsynced-root" });
    await untilClosed(c, parent.threadId, parent.orderId);
    await waitFor(() => root.daemon.thread(parent.threadId)?.meta.status === "done");

    origin.daemon.setRoot("127.0.0.1:1");
    await waitFor(() => !origin.daemon.rootOnline);
    const parentMeta = origin.daemon.thread(parent.threadId)!.meta;
    const childThreadId = "unsynced-child";
    const createdAt = Date.now();
    const file = origin.daemon.store.threadFile(childThreadId, createdAt);
    origin.daemon.store.putThread({
      threadId: childThreadId,
      orderId: "unsynced-child-order",
      kind: "order",
      channel: parentMeta.channel ?? "default",
      parentThreadId: parent.threadId,
      parentOrderId: parent.orderId,
      parentOwnerVerified: true,
      from: { id: "cli:linked-owner", address: "cli@unsynced-origin", host: "unsynced-origin" },
      origin: "human",
      targets: ["local-worker"],
      status: "working",
      summary: "work created during disconnect",
      summaryTurn: 1,
      createdAt,
      file,
      turns: 1,
      replies: [],
      declines: [],
    });

    origin.daemon.setRoot(root.addr);
    await waitFor(() => origin.daemon.rootOnline);
    const list = await (await fetch(`http://${origin.addr}/api/threads`)).json() as import("@cafe/protocol").ThreadMeta[];
    expect(list.find((meta) => meta.threadId === parent.threadId)?.taskStatus).toBe("working");
  });

  it("projects nested delegated work on a child Thread that is itself linked", async () => {
    const root = await startDaemon("nested-task", { mode: "root" });
    cleanup.push(root.stop);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    cleanup.push(release);
    const tester = await barista(root.addr, identity("tester"), async (h) => { await h.ack(); await held; await h.reply("nested work done"); });
    cleanup.push(() => tester.client.close());
    let nestedThreadId: string | undefined;
    const dev = await barista(root.addr, identity("dev"), async (h) => {
      const nested = await dev.client.ask({ body: "review parser tests", to: "tester", parentOrderId: h.order.orderId, parentThreadId: h.order.threadId });
      nestedThreadId = nested.threadId;
      await h.reply("review delegated");
    });
    cleanup.push(() => dev.client.close());
    let childThreadId: string | undefined;
    const lead = await barista(root.addr, identity("lead"), async (h) => {
      const child = await lead.client.ask({ body: "implement parser", to: "dev", parentOrderId: h.order.orderId, parentThreadId: h.order.threadId });
      childThreadId = child.threadId;
      await h.reply("implementation delegated");
    });
    cleanup.push(() => lead.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const parent = await c.ask({ body: "improve parser", to: "lead" });
    await untilClosed(c, parent.threadId, parent.orderId);
    await waitFor(() => !!childThreadId && !!nestedThreadId && root.daemon.thread(nestedThreadId)?.meta.status === "working");
    const nestedParent = await (await fetch(`http://${root.addr}/api/threads/${childThreadId}`)).json();
    expect(nestedParent.meta).toMatchObject({ parentThreadId: parent.threadId, taskStatus: "working" });
    release();
    await waitFor(() => root.daemon.thread(nestedThreadId!)?.meta.status === "done");
  });

  it("carries parent context when the dispatched member delegates from another Host", async () => {
    const root = await startDaemon("ctx-root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("ctx-child", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    let excerpt: string | undefined;
    const tester = await barista(root.addr, identity("tester"), async (h) => {
      excerpt = h.order.parentContext;
      await h.reply("finished");
    });
    cleanup.push(() => tester.client.close());
    const lead = await barista(child.addr, identity("lead"), async (h) => {
      await lead.client.ask({ body: "check the parser", to: "tester@ctx-root", parentOrderId: h.order.orderId, parentThreadId: h.order.threadId });
      await h.reply("delegated");
    });
    cleanup.push(() => lead.client.close());
    await waitFor(() => root.daemon.registry.get(lead.rec.agentId) !== undefined);
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const parent = await c.ask({ body: "verify the release", to: "lead@ctx-child" });
    await untilClosed(c, parent.threadId);
    await waitFor(() => excerpt === "verify the release");
  });

  it("delivers a team follow-up without other members' answers in its prompt history", async () => {
    const d = await startDaemon("ts-history", { mode: "root" });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev", duty: "developer" }]));
    let history: string[] | undefined;
    const orch = await barista(d.addr, member("orch", "orchestrator", "shop"), async (h) => {
      if (h.order.turn === 2) history = h.order.history.map((entry) => entry.text);
      await h.reply("orchestrator answer");
    });
    cleanup.push(() => orch.client.close());
    await connect(d.addr, "dev", "developer", "shop");
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const first = await c.ask({ body: "initial question", channel: "shop", broadcast: true, collect: "all" });
    await untilClosed(c, first.threadId);
    const follow = await c.ask({ body: "please clarify", threadId: first.threadId, to: "orch" });
    await untilClosed(c, follow.threadId, follow.orderId);
    expect(history).toEqual(["initial question", "orchestrator answer"]);
  });

  it("lets an explicit broadcast override a follow-up's responder set", async () => {
    const d = await startDaemon("ts10", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    d.daemon.publishRoster(d.home, team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }, { name: "dev2", duty: "developer" }]));
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

  it("propagates a child-owned roster to Root and routes a remote request to its orchestrator", async () => {
    const root = await startDaemon("ts11-root", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(root.stop);
    const child = await startDaemon("ts11-child", { config: { root: root.addr }, timing: { ...FAST, graceMs: 60 } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);

    const initial = team("shop", [{ name: "orch", duty: "orchestrator" }, { name: "dev1", duty: "developer" }]);
    child.daemon.publishRoster(child.home, initial);
    const orch = await connect(child.addr, "orch", "orchestrator", "shop");
    await waitFor(() => child.daemon.registry.get(orch.rec.agentId) !== undefined, 5000);
    await waitFor(() => root.daemon.teams().some((t) => t.host === child.daemon.host && t.team === "shop" && t.total === 2), 5000);
    const initialRevision = root.daemon.teams().find((t) => t.host === child.daemon.host && t.team === "shop")!.revision ?? 0;
    expect(initialRevision).toBeGreaterThan(0);

    const updates: Array<{ team: string; channel: string; revision: number; change: { added: string[] } }> = [];
    orch.client.onRoster((u) => updates.push(u as unknown as (typeof updates)[number]));
    const eventsBefore = orch.client.recentEvents().length;
    const expanded = team("shop", [
      { name: "orch", duty: "orchestrator" },
      { name: "dev1", duty: "developer" },
      { name: "dev2", duty: "tester" },
    ]);
    child.daemon.publishRoster(child.home, expanded);

    await waitFor(() => updates.length > 0, 5000);
    await waitFor(() => root.daemon.teams().some((t) => t.host === child.daemon.host && t.team === "shop" && t.total === 3), 5000);
    const synced = root.daemon.teams().find((t) => t.host === child.daemon.host && t.team === "shop")!;
    expect(synced.revision).toBeGreaterThan(initialRevision);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ team: "shop", channel: "shop", revision: synced.revision, change: { added: ["dev2"] } });
    expect(orch.client.recentEvents()).toHaveLength(eventsBefore);

    // Re-publishing identical content leaves the revision and roster-note count unchanged.
    child.daemon.publishRoster(child.home, expanded);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(root.daemon.teams().find((t) => t.host === child.daemon.host && t.team === "shop")?.revision).toBe(synced.revision);
    expect(updates).toHaveLength(1);

    const remote = await customer(root.addr);
    cleanup.push(() => remote.close());
    const order = await remote.ask({ body: "route through the Root", to: "shop" });
    expect(order.decision).toMatchObject({ mode: "unicast", targets: [orch.rec.agentId] });
    await untilClosed(remote, order.threadId, order.orderId);
    expect(updates).toHaveLength(1);
  });
});
