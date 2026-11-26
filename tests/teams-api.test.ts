import { afterEach, describe, expect, it } from "vitest";
import { FAST, barista, customer, identity, startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const member = (name: string, duty: string, extra = {}) =>
  identity(name, { team: "myteam", teamChannel: "myteam", member: name, duty, channels: ["myteam"], ...extra });

describe("team records and team addressing (v4-11)", () => {
  it("lists the roster with online members and routes to the orchestrator", async () => {
    const d = await startDaemon("tm1", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const orch = await barista(d.addr, member("orch", "orchestrator"));
    cleanup.push(() => orch.client.close());
    const dev = await barista(d.addr, member("dev", "developer"));
    cleanup.push(() => dev.client.close());
    const watch = await barista(d.addr, member("watch", "monitor", { observer: true }));
    cleanup.push(() => watch.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    await waitFor(() => d.daemon.teams().length === 1 && d.daemon.teams()[0]!.roster.length === 3, 5000);
    const teams = (await (await fetch(`http://${d.addr}/api/teams`)).json()) as { team: string; channel: string; online: number; total: number; roster: { name: string; status?: string }[] }[];
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ team: "myteam", channel: "myteam", online: 3, total: 3 });
    expect(teams[0]!.roster.map((m) => m.name).sort()).toEqual(["dev", "orch", "watch"]);

    const routed = await c.ask({ body: "plan the work", to: "myteam" });
    expect(routed.decision).toMatchObject({ targets: [orch.rec.agentId], mode: "unicast" });

    const qualified = await c.ask({ body: "plan again", to: "myteam@tm1" });
    expect(qualified.decision.targets).toEqual([orch.rec.agentId]);
  });

  it("fails honestly when the orchestrator is offline (never multicasts the team)", async () => {
    const d = await startDaemon("tm2", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const orch = await barista(d.addr, member("orch", "orchestrator"));
    const dev = await barista(d.addr, member("dev", "developer"));
    cleanup.push(() => dev.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    await waitFor(() => d.daemon.teams().length === 1, 5000);
    orch.client.close();
    await waitFor(() => d.daemon.registry.get(orch.rec.agentId) === undefined, 5000);

    const routed = await c.ask({ body: "who is left?", to: "myteam" });
    expect(routed.decision).toMatchObject({ targets: [], failure: "team_offline" });
  });

  it("names an unknown team instead of a generic no-barista failure", async () => {
    const d = await startDaemon("tm3", { mode: "root", timing: { ...FAST, graceMs: 60 } });
    cleanup.push(d.stop);
    const c = await customer(d.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hello?", to: "nope" });
    expect(res.decision).toMatchObject({ targets: [], failure: "unknown_team" });
  });
});