import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "../packages/daemon/src/supervisor.ts";
import { revokeMemberPath, trustMemberPath } from "../packages/daemon/src/team-paths.ts";
import { probeGroup } from "../packages/daemon/src/proc/processStart.ts";
import type { TeamSpec } from "@cafe/protocol";
import { readCafeFile } from "../packages/protocol/src/cafeFile.ts";
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const cleanup: Array<() => Promise<void> | void> = [];
const pidfiles: string[] = [];
afterEach(async () => {
  const pids = pidfiles.splice(0).flatMap((file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
  while (cleanup.length) await cleanup.pop()!();
  for (const pid of pids) for (const target of [-pid, pid]) try { process.kill(target, "SIGKILL"); } catch {}
  delete process.env.FAKE_PI_PIDFILE;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cafe-sync-recovery-"));
  const home = join(root, "home");
  const roster = join(root, "repo");
  mkdirSync(home);
  mkdirSync(roster);
  for (const dir of ["one", "two", "three"]) mkdirSync(join(roster, dir));
  writeFileSync(join(roster, ".cafe"), "fixture");
  const pidfile = join(root, "pids.txt");
  pidfiles.push(pidfile);
  process.env.FAKE_PI_PIDFILE = pidfile;
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const makeSupervisor = () => {
    const supervisor = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", cliBin: FAKE_PI, graceMs: 250 });
    cleanup.push(() => supervisor.shutdown());
    return supervisor;
  };
  return { home, roster, pidfile, makeSupervisor };
}

const member = (name: string, dir: string, description = "") => ({
  name, description, duty: "developer", tags: [], scope: [], mode: "headless" as const,
  agent: "codex" as const, dir, access: "write" as const,
});
const rosterSpec = (members: TeamSpec["members"]): TeamSpec => ({ name: "repo", channel: "dev", members });

async function recordedPids(file: string, count: number): Promise<number[]> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= count);
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

describe("team sync recovery", () => {
  it("restarts changed running members but leaves new and intentionally stopped members stopped", async () => {
    const { roster, pidfile, makeSupervisor } = fixture();
    const first = makeSupervisor();
    const original = rosterSpec([member("one", "one"), member("two", "two")]);
    first.startTeam(roster, original);
    const initial = await recordedPids(pidfile, 2);
    first.stopTeam(roster, "two");

    const updated = rosterSpec([
      { ...member("one", "one"), agent: "claude" },
      member("two", "two"),
      member("three", "three"),
    ]);
    const result = await first.syncTeam(roster, updated);
    expect(result.restarted).toEqual(["one"]);
    expect(result.started).toEqual([]);
    expect(first.list().map((worker) => worker.member)).toEqual(["one"]);
    const after = await recordedPids(pidfile, 3);
    expect(initial).toHaveLength(2);
    expect(after).toHaveLength(3);

    await first.shutdown();
    const restored = makeSupervisor();
    await restored.restore();
    expect(restored.list().map((worker) => worker.member)).toEqual(["one"]);
  });

  it("persists a revocation fence before stopping a worker and never restores its old write access", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const first = makeSupervisor();
    first.startTeam(roster, rosterSpec([member("one", "one")]));
    await waitFor(() => first.list().some((worker) => worker.running));

    const next = rosterSpec([{ ...member("one", "one"), access: "read-only" }]);
    const result = await first.syncTeam(roster, next);
    expect(result.stopped).toEqual(["one"]);
    expect(result.restarted).toEqual(["one"]);
    expect(first.list().map((worker) => worker.member)).toEqual(["one"]);
    await first.shutdown();

    const restored = makeSupervisor();
    await restored.restore();
    expect(restored.list().map((worker) => worker.member)).toEqual(["one"]);
    const durable = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8")) as Record<string, { committedHash: string; members: Record<string, { wanted: boolean }> }>;
    expect(Object.values(durable)[0]!.members.one?.wanted).toBe(true);
    const saved = JSON.parse(readFileSync(join(home, "baristas.json"), "utf8")) as Array<{ team: { spec: TeamSpec } }>;
    expect(saved[0]!.team.spec.members[0]!.access).toBe("read-only");
  });

  it("keeps a downgraded writer stopped across restore when another member fails preflight", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const first = makeSupervisor();
    first.startTeam(roster, rosterSpec([member("one", "one"), member("two", "two")]));
    await waitFor(() => first.list().filter((worker) => worker.running).length === 2);

    const invalid = rosterSpec([
      { ...member("one", "one"), access: "read-only" },
      member("two", "two"),
      member("invalid", "missing"),
    ]);
    await expect(first.syncTeam(roster, invalid)).rejects.toThrow(/does not exist/);
    expect(first.list().map((worker) => worker.member)).toEqual(["two"]);
    await first.shutdown();

    const restored = makeSupervisor();
    await restored.restore();
    expect(restored.list().map((worker) => worker.member)).toEqual(["two"]);
    const states = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8")) as Record<string, { members: Record<string, { wanted: boolean }> }>;
    expect(Object.values(states)[0]!.members.one?.wanted).toBe(false);
  });

  it("stops a worker whose old external grant is revoked even when the proposed path is valid", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const external = join(dirname(roster), "external-next");
    mkdirSync(external);
    writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: dev\n  members:\n    - name: orch\n      duty: orchestrator\n      dir: .\n    - name: outside\n      dir: ../external-next\n");
    trustMemberPath(home, roster, "repo", "outside", "../external-next");
    const supervisor = makeSupervisor();
    supervisor.startTeam(roster, rosterSpec([member("one", "one"), member("two", "two"), member("outside", "../external-next")]));
    await waitFor(() => supervisor.list().filter((worker) => worker.running).length === 3);
    const grantId = JSON.parse(readFileSync(join(home, "team-path-grants.json"), "utf8"))[0].grantId as string;
    revokeMemberPath(home, grantId);

    const invalid = rosterSpec([member("one", "one"), member("two", "two"), member("outside", "three"), member("invalid", "missing")]);
    await expect(supervisor.syncTeam(roster, invalid)).rejects.toThrow(/does not exist/);
    expect(supervisor.list().map((worker) => worker.member).sort()).toEqual(["one", "two"]);
  });

  it("stops a revoked member before an unrelated member fails roster preflight", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const external = join(dirname(roster), "external");
    mkdirSync(external);
    writeFileSync(join(roster, ".cafe"), "name: repo\nteam:\n  channel: dev\n  members:\n    - name: orch\n      duty: orchestrator\n      dir: .\n    - name: outside\n      dir: ../external\n");
    trustMemberPath(home, roster, "repo", "outside", "../external");
    const supervisor = makeSupervisor();
    const original = rosterSpec([member("one", "one"), member("two", "two"), member("outside", "../external")]);
    supervisor.startTeam(roster, original);
    await waitFor(() => supervisor.list().filter((worker) => worker.running).length === 3);
    const grantId = JSON.parse(readFileSync(join(home, "team-path-grants.json"), "utf8"))[0].grantId as string;
    revokeMemberPath(home, grantId);

    const invalid = rosterSpec([
      member("one", "one"),
      member("two", "two"),
      member("outside", "../external"),
      member("new-invalid", "missing"),
    ]);
    await expect(supervisor.syncTeam(roster, invalid)).rejects.toThrow(/exact local grant/);
    expect(supervisor.list().map((worker) => worker.member).sort()).toEqual(["one", "two"]);
    const state = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8")) as Record<string, { members: Record<string, { wanted: boolean }> }>;
    expect(Object.values(state)[0]!.members.outside?.wanted).toBe(false);
  });

  it("restores previously wanted workers after a crash during the local commit phase", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const initial = makeSupervisor();
    const configured = rosterSpec([member("one", "one")]);
    initial.startTeam(roster, configured);
    await waitFor(() => initial.list().some((worker) => worker.running));
    const stoppedPid = initial.list()[0]!.pid!;
    initial.stopTeam(roster, "one");
    await initial.shutdown();
    await waitFor(() => probeGroup(stoppedPid) === "gone");

    const syncPath = join(home, "team-sync.json");
    const states = JSON.parse(readFileSync(syncPath, "utf8")) as Record<string, any>;
    const state = Object.values(states)[0]!;
    state.members.one.wanted = true;
    state.intent = { rosterRootId: state.rosterRootId, fromPath: state.rosterDir, committedHash: state.committedHash, targetHash: state.committedHash, phase: "committing", affectedGroups: [], staleTuiReservationIds: [] };
    state.pendingSpec = configured;
    writeFileSync(syncPath, JSON.stringify(states));
    writeFileSync(join(home, "baristas.json"), "[]");

    const restored = makeSupervisor();
    await restored.restore();
    expect(restored.list().map((worker) => worker.member)).toEqual(["one"]);
    expect(JSON.parse(readFileSync(syncPath, "utf8"))[Object.keys(states)[0]!]!.intent).toBeUndefined();
  });

  it("preserves an intentional stop issued while sync waits for the old group", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    const original = rosterSpec([member("one", "one")]);
    supervisor.startTeam(roster, original);
    await waitFor(() => supervisor.list().some((worker) => worker.running));
    const changed = rosterSpec([{ ...member("one", "one"), agent: "claude" }]);

    const syncing = supervisor.syncTeam(roster, changed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(supervisor.stopTeam(roster, "one")).toBe(0);
    await syncing;
    expect(supervisor.list()).toEqual([]);
    const state = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8")) as Record<string, { members: Record<string, { wanted: boolean }> }>;
    expect(Object.values(state)[0]!.members.one?.wanted).toBe(false);
  });

  it("safety-stops saved workers when the roster directory has been removed", async () => {
    const { roster, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    supervisor.startTeam(roster, rosterSpec([member("one", "one")]));
    await waitFor(() => supervisor.list().some((worker) => worker.running));
    rmSync(roster, { recursive: true, force: true });

    const result = await supervisor.stopUnsafeTeamWorkers(roster);
    expect(result.stopped).toEqual(["one"]);
    expect(supervisor.list()).toEqual([]);
  });

  it("keeps TUI directory reservations stale when the roster becomes invalid", () => {
    const { roster, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    supervisor.commitRosterWriteScopes(roster, rosterSpec([{ ...member("human", "one"), mode: "tui" }]));
    expect(supervisor.staleTuiReservations()).toEqual([]);

    supervisor.markRosterTuiReservationsStale(roster);
    expect(supervisor.staleTuiReservations()).toMatchObject([{ member: "human", path: realpathSync(join(roster, "one")) }]);
  });

  it("does not commit or restart a replacement when the roster snapshot changes during stop", async () => {
    const { home, roster, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    supervisor.startTeam(roster, rosterSpec([member("one", "one")]));
    await waitFor(() => supervisor.list().some((worker) => worker.running));

    await expect(supervisor.syncTeam(
      roster,
      rosterSpec([{ ...member("one", "one"), agent: "claude" }]),
      () => { throw new Error("roster changed during sync"); },
    )).rejects.toThrow(/roster changed during sync/);
    expect(supervisor.list()).toEqual([]);
    const states = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8")) as Record<string, { members: Record<string, { wanted: boolean }> }>;
    expect(Object.values(states)[0]!.members.one?.wanted).toBe(false);
  });

  it("removes a worker from routing after durable revocation intent and before signaling", async () => {
    const { home, roster, pidfile } = fixture();
    const observations: Array<{ intent: boolean; groupPresent: boolean }> = [];
    let supervisor!: Supervisor;
    supervisor = new Supervisor({
      home, daemonAddr: "127.0.0.1:1", token: "t", cliBin: FAKE_PI, graceMs: 250,
      onTeamMemberStopping: (root: string, name: string) => {
        if (name !== "one") return;
        const state = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8"))[root];
        const pid = supervisor.list().find((worker) => worker.member === name)?.pid;
        observations.push({ intent: state?.intent?.phase === "stopping", groupPresent: !!pid && probeGroup(pid) === "present" });
      },
    } as any);
    cleanup.push(() => supervisor.shutdown());
    const original = rosterSpec([member("one", "one")]);
    supervisor.startTeam(roster, original);
    await recordedPids(pidfile, 1);
    const result = await supervisor.syncTeam(roster, rosterSpec([member("two", "two")]));

    expect(result.stopped).toEqual(["one"]);
    expect(observations).toEqual([{ intent: true, groupPresent: true }]);
  });

  it("keeps a read-only process-group fence pending and refuses sync/start retries while it lives", async () => {
    const { home, roster, pidfile, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    const original = rosterSpec([{ ...member("one", "one"), access: "read-only" }]);
    supervisor.startTeam(roster, original);
    await recordedPids(pidfile, 1);
    const livePid = supervisor.list()[0]?.pid!;
    const states = JSON.parse(readFileSync(join(home, "team-sync.json"), "utf8")) as Record<string, any>;
    const state = Object.values(states)[0]!;
    state.intent = { rosterRootId: state.rosterRootId, fromPath: state.rosterDir, committedHash: state.committedHash, targetHash: "pending", phase: "stop-pending", affectedGroups: [{ member: "one", pid: livePid, startedAt: "unavailable" }], staleTuiReservationIds: [] };
    state.pendingSpec = rosterSpec([{ ...member("one", "one"), access: "read-only", agent: "claude" }]);
    writeFileSync(join(home, "team-sync.json"), JSON.stringify(states));
    const updated = state.pendingSpec as TeamSpec;

    const retry = await supervisor.syncTeam(roster, updated);
    expect(retry.pending).toEqual(["one"]);
    expect(() => supervisor.startTeam(roster, updated)).toThrow(/pending reconciliation/);
    expect(readFileSync(pidfile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("refuses team start with changed launch config until sync reconciles the live worker", async () => {
    const { roster, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    supervisor.startTeam(roster, rosterSpec([member("one", "one")]));
    await waitFor(() => supervisor.list().some((worker) => worker.running));

    expect(() => supervisor.startTeam(roster, rosterSpec([{ ...member("one", "one"), agent: "claude" }]))).toThrow(/run cafe team sync/);
    expect(supervisor.list()).toHaveLength(1);
  });

  it("leaves a semantically unchanged running worker in place", async () => {
    const { roster, pidfile, makeSupervisor } = fixture();
    const supervisor = makeSupervisor();
    const configured = rosterSpec([member("one", "one")]);
    supervisor.startTeam(roster, configured);
    await recordedPids(pidfile, 1);
    const guardPid = supervisor.list()[0]?.pid;
    const result = await supervisor.syncTeam(roster, configured);
    expect(result.restarted).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(supervisor.list()[0]?.pid).toBe(guardPid);
    expect(readFileSync(pidfile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });
});
