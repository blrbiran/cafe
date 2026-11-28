import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "@cafe/daemon";
import type { TeamSpec } from "@cafe/protocol";
import { trustMemberPath } from "../packages/daemon/src/team-paths.ts";
import { waitFor } from "./helpers.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
chmodSync(FAKE_PI, 0o755);

const cleanup: Array<() => Promise<void> | void> = [];
const pidfiles: string[] = [];
afterEach(async () => {
  const pids = pidfiles.splice(0).flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number) : []));
  while (cleanup.length) await cleanup.pop()!();
  for (const pid of pids) for (const t of [-pid, pid]) try { process.kill(t, "SIGKILL"); } catch {}
  delete process.env.FAKE_PI_PIDFILE;
});

function setup(): { home: string; roster: string; pidfile: string } {
  const root = mkdtempSync(join(tmpdir(), "cafe-team-sup-"));
  const home = join(root, "home");
  const roster = join(root, "repo");
  mkdirSync(home);
  mkdirSync(roster);
  mkdirSync(join(root, "repo-arch"));
  writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: repo-dev\n  members:\n    - name: lead\n      duty: orchestrator\n    - name: arch\n      dir: ../repo-arch\n");
  const pidfile = join(root, "pids.txt");
  pidfiles.push(pidfile);
  process.env.FAKE_PI_PIDFILE = pidfile;
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { home, roster, pidfile };
}

function supervisor(home: string) {
  const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: FAKE_PI, extension: "/dev/null", graceMs: 500 });
  cleanup.push(() => sup.shutdown());
  return sup;
}

const team: TeamSpec = {
  name: "repo",
  channel: "repo-dev",
  members: [
    { name: "dev1", duty: "developer", description: "", tags: [], scope: [], mode: "headless", dir: "." },
    { name: "dev2", duty: "developer", description: "", tags: [], scope: [], mode: "headless", dir: "." },
    { name: "arch", duty: "architect", description: "", tags: [], scope: [], mode: "headless", dir: "../repo-arch" },
    { name: "human", duty: "reviewer", description: "", tags: [], scope: [], mode: "tui", dir: "." },
  ],
};

describe("supervisor teams (v4-11)", () => {
  it("starts one worker per headless member with its own cwd, and stops only supervised members", async () => {
    const { home, roster, pidfile } = setup();
    const sup = supervisor(home);
    expect(() => sup.startTeam(roster, team)).toThrow(/exact local grant/);
    expect(sup.list()).toHaveLength(0);
    trustMemberPath(home, roster, "repo", "arch", "../repo-arch");
    const started = sup.startTeam(roster, team);
    expect(started.map((w) => w.member).sort()).toEqual(["arch", "dev1", "dev2"]);
    expect(started.find((w) => w.member === "arch")!.cwd).toBe(realpathSync(join(dirname(roster), "repo-arch")));
    const logs = new Set(started.map((w) => w.log));
    expect(logs.size).toBe(3);
    await waitFor(() => readFileSync(pidfile, "utf8").split("\n").filter(Boolean).length === 3, 5000);

    // Idempotent: a second start adds nothing while the workers are live.
    expect(sup.startTeam(roster, team)).toHaveLength(3);

    // save() keeps one spec per roster, with exactly the supervised headless members (a TUI member
    // is never a worker and must not be resurrected into one).
    const saved = JSON.parse(readFileSync(join(home, "baristas.json"), "utf8")) as { team?: { spec: TeamSpec } }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.team!.spec.members.map((m) => m.name).sort()).toEqual(["arch", "dev1", "dev2"]);

    expect(sup.stopTeam(roster, "dev1")).toBe(1);
    expect(sup.list().map((w) => w.member).sort()).toEqual(["arch", "dev2"]);
    expect(sup.stopTeam(roster)).toBe(2);
    expect(sup.list()).toHaveLength(0);
  });

  it("stops a supervised member through a symlink to the roster directory", () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    const alias = join(dirname(roster), "roster-alias");
    symlinkSync(roster, alias, "junction");
    sup.startTeam(roster, { ...team, members: [team.members[0]!] });

    expect(sup.stopTeam(alias, "dev1")).toBe(1);
    expect(sup.list()).toHaveLength(0);
  });

  it("restores supervised team members after a restart", async () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    trustMemberPath(home, roster, "repo", "arch", "../repo-arch");
    sup.startTeam(roster, team);
    await sup.shutdown();
    const again = supervisor(home);
    await again.restore();
    expect(again.list().map((w) => w.member).sort()).toEqual(["arch", "dev1", "dev2"]);
  });

  it("persists the supervised set across partial starts and a member stop", async () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    // Starting one member at a time must not shrink what a restart restores.
    sup.startTeam(roster, { ...team, members: [team.members[0]!] });
    sup.startTeam(roster, { ...team, members: [team.members[1]!] });
    expect(sup.list().map((w) => w.member).sort()).toEqual(["dev1", "dev2"]);

    let saved = JSON.parse(readFileSync(join(home, "baristas.json"), "utf8")) as { team?: { spec: TeamSpec } }[];
    expect(saved[0]!.team!.spec.members.map((m) => m.name).sort()).toEqual(["dev1", "dev2"]);

    // Stopping dev1 must leave only dev2 in the saved spec.
    expect(sup.stopTeam(roster, "dev1")).toBe(1);
    saved = JSON.parse(readFileSync(join(home, "baristas.json"), "utf8")) as { team?: { spec: TeamSpec } }[];
    expect(saved[0]!.team!.spec.members.map((m) => m.name)).toEqual(["dev2"]);

    await sup.shutdown();
    const again = supervisor(home);
    await again.restore();
    expect(again.list().map((w) => w.member)).toEqual(["dev2"]);
  });

  it("refuses two write-enabled workers with overlapping directories", () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    mkdirSync(join(roster, "nested"));
    const members: TeamSpec["members"] = [
      { ...team.members[0]!, access: "write" },
      { ...team.members[1]!, access: "write", dir: "nested" },
    ];
    expect(() => sup.startTeam(roster, { ...team, members })).toThrow(/overlapping directories/);
    expect(sup.list()).toHaveLength(0);
  });

  it.each(["team", "standalone"] as const)("rejects a second writer after %s starts", (first) => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    const nested = join(roster, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".cafe"), "name: standalone\n");
    const alias = join(dirname(roster), "nested-alias");
    symlinkSync(nested, alias, "junction");
    const startTeam = () => sup.startTeam(roster, { ...team, members: [{ ...team.members[0]!, access: "write" }] });
    const startStandalone = () => sup.start({ dir: alias, access: "workspace-write" });
    if (first === "team") {
      startTeam();
      expect(startStandalone).toThrow(/overlap.*write/i);
    } else {
      startStandalone();
      expect(startTeam).toThrow(/overlap.*write/i);
    }
    expect(sup.list()).toHaveLength(1);
  });

  it("rejects overlapping writers reached with different path casing on case-insensitive volumes", ({ skip }) => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    const nested = join(roster, "Nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".cafe"), "name: standalone\n");
    const variant = join(dirname(roster), "REPO", "nested");
    if (!existsSync(variant)) skip();
    sup.startTeam(roster, { ...team, members: [{ ...team.members[0]!, access: "write" }] });
    expect(() => sup.start({ dir: variant, access: "workspace-write" })).toThrow(/overlap.*write/i);
    expect(sup.list()).toHaveLength(1);
  });

  it("reserves an unstarted member's write scope across supervisor restart", async () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    const committed = { ...team, members: [{ ...team.members[0]!, duty: "orchestrator", access: "write" as const }] };
    sup.commitRosterWriteScopes(roster, committed);
    expect(sup.list()).toHaveLength(0);
    const restored = supervisor(home);
    await restored.restore();
    expect(() => restored.start({ dir: roster, access: "workspace-write" })).toThrow(/reserved by dev1/);
    expect(restored.list()).toHaveLength(0);
  });

  it("holds an old TUI directory until the operator releases its exact reservation", async () => {
    const { home, roster } = setup();
    const original = join(roster, "old");
    const replacement = join(roster, "new");
    for (const path of [original, replacement]) {
      mkdirSync(path);
      writeFileSync(join(path, ".cafe"), "name: standalone\n");
    }
    const sup = supervisor(home);
    const terminal = (dir: string) => ({ ...team, members: [{ ...team.members[3]!, duty: "orchestrator", dir }] });
    sup.commitRosterWriteScopes(roster, terminal("old"));
    expect(() => sup.start({ dir: original, access: "workspace-write" })).toThrow(/reserved by human/);
    sup.commitRosterWriteScopes(roster, terminal("new"));
    const restored = supervisor(home);
    await restored.restore();
    const [stale] = restored.staleTuiReservations();
    expect(stale).toMatchObject({ member: "human", path: realpathSync(original) });
    expect(() => restored.start({ dir: original, access: "workspace-write" })).toThrow(/reserved by human/);
    expect(restored.releaseTuiReservation(stale!.reservationId)).toBe(true);
    expect(restored.start({ dir: original, access: "workspace-write" })).toHaveLength(1);
    expect(() => restored.start({ dir: replacement, access: "workspace-write" })).toThrow(/reserved by human/);
  });

  it("stops removed and narrowed workers during sync without starting new members", async () => {
    const { home, roster } = setup();
    for (const dir of ["dev1", "dev2", "new"]) mkdirSync(join(roster, dir));
    const sup = supervisor(home);
    const configured = { ...team, members: [
      { ...team.members[0]!, dir: "dev1", duty: "orchestrator", access: "write" as const },
      { ...team.members[1]!, dir: "dev2", access: "write" as const },
    ] };
    sup.startTeam(roster, configured);
    await waitFor(() => sup.list().every((worker) => worker.running));
    const next = { ...configured, members: [
      { ...configured.members[0]!, access: "read-only" as const },
      { ...configured.members[1]!, name: "new", dir: "new" },
    ] };
    const result = await sup.stopUnsafeTeamWorkers(roster, next);
    expect(result.stopped.sort()).toEqual(["dev1", "dev2"]);
    expect(result.pending).toEqual([]);
    expect(sup.list()).toEqual([]);
  });

  it("holds the write directory while the stopped worker group is still exiting", async () => {
    const { home, roster, pidfile } = setup();
    const sup = supervisor(home);
    const teamWriter = { ...team, members: [{ ...team.members[0]!, access: "write" as const }] };
    sup.startTeam(roster, teamWriter);
    await waitFor(() => existsSync(pidfile));
    expect(sup.stopTeam(roster, "dev1")).toBe(1);
    expect(() => sup.startTeam(roster, teamWriter)).toThrow(/still stopping/);
  });

  it("refuses a member with a missing worktree before starting anything", () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    expect(() => sup.startTeam(roster, { ...team, members: [{ ...team.members[0]!, dir: "no-such-dir" }] })).toThrow(/does not exist/);
    expect(sup.list()).toHaveLength(0);
  });
});