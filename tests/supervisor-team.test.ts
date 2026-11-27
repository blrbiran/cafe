import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(started.find((w) => w.member === "arch")!.cwd).toBe(join(dirname(roster), "repo-arch"));
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

  it("refuses a member with a missing worktree before starting anything", () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    expect(() => sup.startTeam(roster, { ...team, members: [{ ...team.members[0]!, dir: "no-such-dir" }] })).toThrow(/does not exist/);
    expect(sup.list()).toHaveLength(0);
  });
});