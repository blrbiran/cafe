import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "@cafe/daemon";
import type { TeamSpec } from "@cafe/protocol";
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
  writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: repo-dev\n  members: []\n");
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
    const started = sup.startTeam(roster, team);
    expect(started.map((w) => w.member).sort()).toEqual(["arch", "dev1", "dev2"]);
    expect(started.find((w) => w.member === "arch")!.cwd).toBe(join(dirname(roster), "repo-arch"));
    const logs = new Set(started.map((w) => w.log));
    expect(logs.size).toBe(3);
    await waitFor(() => readFileSync(pidfile, "utf8").split("\n").filter(Boolean).length === 3, 5000);

    // Idempotent: a second start adds nothing while the workers are live.
    expect(sup.startTeam(roster, team)).toHaveLength(3);

    // save() keeps one spec per roster, with the full roster.
    const saved = JSON.parse(readFileSync(join(home, "baristas.json"), "utf8")) as { team?: { spec: TeamSpec } }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.team!.spec.members.map((m) => m.name).sort()).toEqual(["arch", "dev1", "dev2", "human"]);

    expect(sup.stopTeam(roster, "dev1")).toBe(1);
    expect(sup.list().map((w) => w.member).sort()).toEqual(["arch", "dev2"]);
    expect(sup.stopTeam(roster)).toBe(2);
    expect(sup.list()).toHaveLength(0);
  });

  it("restores supervised team members after a restart", async () => {
    const { home, roster } = setup();
    const sup = supervisor(home);
    sup.startTeam(roster, team);
    await sup.shutdown();
    const again = supervisor(home);
    await again.restore();
    expect(again.list().map((w) => w.member).sort()).toEqual(["arch", "dev1", "dev2"]);
  });
});