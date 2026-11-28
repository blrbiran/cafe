import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CafeClient } from "@cafe/protocol/client";
import { memberLaunchHash, readCafeFile } from "@cafe/protocol/cafe-file";
import { FAST, barista, identity, startDaemon, waitFor } from "./helpers.ts";
import { CafeConfig, Daemon } from "@cafe/daemon";

// v4-11 review: a roster read from an authoritative `.cafe` must replace membership (removing a
// member has to take effect), a forgotten Host must not keep its teams, and a roster must not be
// resurrected by a stale revision.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const roster = (members: string[]) =>
  ["name: repo", "team:", "  channel: repo-dev", "  members:", "    - name: orch", "      duty: orchestrator", "      dir: ."]
    .concat(members.flatMap((name) => [`    - name: ${name}`, "      dir: ."]))
    .join("\n") + "\n";

const member = (name: string, teamDir: string) =>
  identity(name, { team: "repo", teamChannel: "repo-dev", member: name, teamDir, channels: ["repo-dev"] });

describe("team roster updates", () => {
  it("migrates a saved nested TUI roster at boot and can sync and start a selected worker", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tui-migration-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, "repo");
    const dev = join(dir, "worktrees/dev");
    mkdirSync(dev, { recursive: true });
    const file = join(dir, ".cafe");
    const source = `name: repo
team:
  channel: repo-dev
  members:
    - { name: orch, duty: orchestrator, mode: tui, dir: ., access: read-only }
    - { name: dev, mode: tui, dir: worktrees/dev }
    - { name: mon, agent: codex, observer: true, access: read-only }
`;
    writeFileSync(file, source);
    const spec = readCafeFile(file).team!;
    // Simulate a roster saved before the supervisor persisted reservations.
    const old = await startDaemon("tui-migration", { home, mode: "root" });
    cleanup.push(old.stop);
    old.daemon.publishRoster(dir, spec);
    await old.stop();
    expect(existsSync(join(home, "team-write-scopes.json"))).toBe(false);

    vi.stubEnv("CAFE_CODEX_BIN", fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)));
    cleanup.push(() => { vi.unstubAllEnvs(); });
    const d = await startDaemon("tui-migration", { home, mode: "root", noSupervisor: false });
    cleanup.push(d.stop);
    expect(d.daemon.supervisor).toBeDefined();
    const post = (sync: boolean) => fetch(`http://${d.addr}/api/baristas`, {
      method: "POST",
      headers: { authorization: "Bearer t0k", "content-type": "application/json" },
      body: JSON.stringify({ dir, team: { members: [{ name: "mon" }] }, sync }),
    });
    const sync = await post(true);
    expect(await sync.json()).toMatchObject({ published: true, team: "repo" });
    expect(sync.status).toBe(200);
    for (const [name, cwd] of [["orch", dir], ["dev", dev]] as const) {
      const c = new CafeClient({ daemon: d.addr, token: "t0k" });
      cleanup.push(() => c.close());
      const hash = memberLaunchHash(dir, spec, spec.members.find((m) => m.name === name)!);
      expect(await c.connect({ ...member(name, dir), mode: "tui", cwd, memberLaunchHash: hash })).toMatchObject({ member: name, status: "idle" });
    }
    const start = await post(false);
    expect(await start.json()).toMatchObject([{ member: "mon" }]);
    expect(start.status).toBe(200);
    await waitFor(() => d.daemon.registry.all().some((agent) => agent.team === "repo" && agent.member === "mon" && agent.status === "idle"), 5000);
    expect(d.daemon.teams()[0]!.roster.find((m) => m.name === "orch")).not.toHaveProperty("access");
    expect(readFileSync(file, "utf8")).toBe(source);
  });

  it("binds TUI registration to the committed launch configuration and cwd", async () => {
    const d = await startDaemon("tui-roster", { mode: "root" });
    cleanup.push(d.stop);
    const first = join(d.home, "first");
    const second = join(d.home, "second");
    mkdirSync(first);
    mkdirSync(second);
    const write = (dir: string, description: string, access = "") => writeFileSync(join(d.home, ".cafe"), `name: repo\nteam:\n  channel: repo-dev\n  members:\n    - { name: orch, duty: orchestrator, mode: tui, dir: ${dir}, description: ${description}${access} }\n`);
    const publish = () => d.daemon.publishRoster(d.home, readCafeFile(join(d.home, ".cafe")).team!);
    const launch = (registeredCwd: string) => {
      const spec = readCafeFile(join(d.home, ".cafe")).team!;
      return { ...member("orch", d.home), mode: "tui" as const, cwd: registeredCwd, memberLaunchHash: memberLaunchHash(d.home, spec, spec.members[0]!) };
    };
    const make = () => {
      const c = new CafeClient({ daemon: d.addr });
      cleanup.push(() => c.close());
      return c;
    };
    write("first", "initial");
    const old = launch(first);
    await expect(make().connect(old)).rejects.toMatchObject({ code: "team_not_published" });
    publish();
    await expect(make().connect(launch(second))).rejects.toMatchObject({ code: "team_launch_mismatch" });
    const worker = make();
    await worker.connect(old);
    write("first", "updated", ", access: read-only");
    publish();
    expect(worker.connected).toBe(true);
    worker.close();
    const reconnected = make();
    expect(await reconnected.connect(old)).toMatchObject({ member: "orch", status: "idle" });
    write("second", "updated");
    publish();
    await waitFor(() => !reconnected.connected);
    await expect(make().connect(old)).rejects.toMatchObject({ code: "team_launch_mismatch" });
    expect(await make().connect(launch(second))).toMatchObject({ member: "orch", status: "idle" });
  });
  it("migrates a legacy local owner path only when its realpath matches", () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-owner-migrate-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const daemon = new Daemon({ config: CafeConfig.parse({ host: "owner-migrate", mode: "root", security: { mode: "plaintext" } }), home, log: () => {} });
    cleanup.push(() => daemon.stop());
    const root = join(home, "repo");
    const alias = join(home, "repo-alias");
    mkdirSync(root);
    writeFileSync(join(root, ".cafe"), roster([]));
    symlinkSync(root, alias, "junction");
    const team = readCafeFile(join(root, ".cafe")).team!;
    const key = `${daemon.host}/${team.name}/${team.channel}`;
    daemon.store.setKv("rosterOwners", { [key]: alias });
    daemon.publishRoster(root, team);
    expect(daemon.store.getKv<Record<string, string>>("rosterOwners")?.[key]).toBe(realpathSync(root));
  });

  it("drops a member removed from the authoritative .cafe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cafe-roster-"));
    writeFileSync(join(dir, ".cafe"), roster(["dev1", "dev2"]));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const d = await startDaemon("ros1", { mode: "root" });
    cleanup.push(d.stop);

    const stale = mkdtempSync(join(tmpdir(), "cafe-roster-copy-"));
    writeFileSync(join(stale, ".cafe"), roster(["dev1"]));
    cleanup.push(() => rmSync(stale, { recursive: true, force: true }));
    const publish = (path: string) => d.daemon.publishRoster(path, readCafeFile(join(path, ".cafe")).team!);
    publish(dir);
    const before = d.daemon.teams()[0]!.revision;

    const c = new CafeClient({ daemon: d.addr });
    cleanup.push(() => c.close());
    await c.connect(member("dev1", stale));
    expect(d.daemon.teams()[0]!.roster.map((m) => m.name)).toEqual(["orch", "dev1", "dev2"]);
    expect(d.daemon.teams()[0]!.revision).toBe(before);
    expect(() => publish(stale)).toThrow(/roster directory/i);

    writeFileSync(join(dir, ".cafe"), roster(["dev1"]));
    publish(dir);
    expect(d.daemon.teams()[0]!.roster.map((m) => m.name)).toEqual(["orch", "dev1"]);
    expect(d.daemon.teams()[0]!.revision).toBeGreaterThan(before!);
  });

  it("removes a forgotten Host's teams from memory and teams.json", async () => {
    const root = await startDaemon("hubR", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pcR", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);

    const dev = await barista(child.addr, identity("dev1", { team: "repo", teamChannel: "repo-dev", member: "dev1", channels: ["repo-dev"] }));
    cleanup.push(() => dev.client.close());
    await waitFor(() => root.daemon.teams().some((t) => t.host === "pcR" && t.team === "repo"), 5000);

    await child.stop();
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pcR" && !d.online), 5000);
    const res = await fetch(`http://${root.addr}/api/hosts/forget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "pcR" }),
    });
    expect(res.status, await res.text()).toBe(200);
    expect(root.daemon.teams().some((t) => t.host === "pcR")).toBe(false);

    const saved = JSON.parse(readFileSync(join(root.home, "teams.json"), "utf8")) as { host: string }[];
    expect(saved.some((t) => t.host === "pcR")).toBe(false);
  });

  it("republishes a child roster learned while the Root was offline", async () => {
    const root1 = await startDaemon("hubP", { mode: "root" });
    cleanup.push(root1.stop);
    const port = Number(root1.addr.split(":")[1]);
    const child = await startDaemon("pcP", { config: { root: root1.addr }, timing: FAST });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);
    await root1.stop();
    await waitFor(() => !child.daemon.rootOnline, 5000);

    const dev = await barista(child.addr, identity("dev1", { team: "repo", teamChannel: "repo-dev", member: "dev1", channels: ["repo-dev"] }));
    cleanup.push(() => dev.client.close());
    await waitFor(() => child.daemon.teams().some((t) => t.team === "repo" && t.host === "pcP"), 5000);

    const root2 = await startDaemon("hubP", { mode: "root", config: { port, advertise: "127.0.0.1" } });
    cleanup.push(root2.stop);
    await waitFor(() => root2.daemon.teams().some((t) => t.host === "pcP" && t.team === "repo"), 8000);
  }, 30_000);

  it("ignores an equal revision but accepts a newer one", async () => {
    const d = await startDaemon("rev1", { mode: "root" });
    cleanup.push(d.stop);
    const key = "rev1/repo";
    const team = { team: "repo", host: "rev1", channel: "repo-dev", members: [{ name: "a", description: "", tags: [], scope: [], mode: "headless" as const, dir: "." }], revision: 10 };
    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam(team);
    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam({ ...team, members: [{ ...team.members[0]!, name: "stale" }], revision: 10 });
    expect(d.daemon.teams().find((t) => `${t.host}/${t.team}` === key)!.roster.map((m) => m.name)).toEqual(["a"]);

    (d.daemon as unknown as { storeTeam: (t: unknown) => void }).storeTeam({ ...team, members: [{ ...team.members[0]!, name: "b" }], revision: 11 });
    expect(d.daemon.teams().find((t) => `${t.host}/${t.team}` === key)!.roster.map((m) => m.name)).toEqual(["b"]);
  });
});