import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { readCafeFile } from "../packages/protocol/src/cafeFile.ts";
import { CafeClient } from "../packages/protocol/src/client.ts";
import { readPathGrants } from "../packages/daemon/src/team-paths.ts";
import { Supervisor } from "../packages/daemon/src/supervisor.ts";
import { runDaemon, type Running } from "../packages/daemon/src/index.ts";

const roots: string[] = [];
const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const FAST = { ackTimeoutMs: 300, heartbeatIntervalMs: 200, broadcastDeadlineMs: 800, reconnectMinMs: 50, reconnectMaxMs: 200 };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function startDaemon(host: string, home: string): Promise<Running & { home: string; addr: string }> {
  writeFileSync(join(home, "config.yml"), stringify({ host, token: "t0k", port: 0, advertise: "127.0.0.1", mode: "root", security: { mode: "plaintext" } }));
  const running = await runDaemon({ home, timing: FAST, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "no-web") });
  const addr = `127.0.0.1:${running.server.port}`;
  running.daemon.supervisor = new Supervisor({ home, daemonAddr: addr, token: "t0k" });
  return Object.assign(running, { home, addr });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cafe-team-relocate-"));
  roots.push(root);
  const home = join(root, "home");
  const source = join(root, "source");
  const destination = join(root, "destination");
  for (const path of [home, source, destination]) mkdirSync(path);
  for (const path of [source, destination]) {
    mkdirSync(join(path, "worker"));
    writeFileSync(join(path, ".cafe"), stringify({
      name: "same-team", team: { channel: "dev", members: [
        { name: "orch", duty: "orchestrator", dir: "." },
        { name: "worker", mode: "tui", dir: "worker" },
      ] },
    }));
  }
  return { home, source, destination };
}

async function relocate(d: Awaited<ReturnType<typeof startDaemon>>, source: string, destination: string, key = readFileSync(join(d.home, "operator.key"), "utf8")) {
  return fetch(`http://${d.addr}/api/team-relocate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cafe-operator-key": key },
    body: JSON.stringify({ oldRosterDir: source, newRosterDir: destination }),
  });
}

describe("local team relocation", () => {
  it("moves the exact local owner, preserves old TUI reservations, and rejects the old root after restart", async () => {
    const { home, source, destination } = fixture();
    const sourceSpec = readCafeFile(join(source, ".cafe")).team!;
    const daemon = await startDaemon("relocate-local", home);
    try {
      const supervisor = new Supervisor({ home, daemonAddr: `127.0.0.1:${daemon.server.port}`, token: "t0k", cliBin: FAKE_PI });
      daemon.daemon.supervisor = supervisor;
      daemon.daemon.publishRoster(source, sourceSpec);
      const knownRosterId = "stable-fixture-roster";
      daemon.daemon.store.setKv("rosterRootIds", { [realpathSync(source)]: knownRosterId });
      const oldReservations = supervisor.staleTuiReservations();
      expect(oldReservations).toEqual([]);

      const response = await relocate(daemon, source, destination);
      expect(response.status, await response.text()).toBe(200);
      expect(daemon.daemon.store.getKv("rosterRootIds")).toEqual({ [realpathSync(destination)]: knownRosterId });
      expect(readPathGrants(home).every((grant) => grant.rosterRoot !== source)).toBe(true);
      expect(supervisor.staleTuiReservations()).toEqual(expect.arrayContaining([
        expect.objectContaining({ rosterDir: realpathSync(source), member: "worker" }),
      ]));
      expect(() => daemon.daemon.publishRoster(source, sourceSpec)).toThrow(/relocat|uses roster directory/i);
      daemon.daemon.publishRoster(destination, readCafeFile(join(destination, ".cafe")).team!);
      await supervisor.shutdown();
    } finally {
      await daemon.stop();
    }

    const restored = await startDaemon("relocate-local", home);
    try {
      expect(() => restored.daemon.publishRoster(source, sourceSpec)).toThrow(/relocat|uses roster directory/i);
      restored.daemon.publishRoster(destination, readCafeFile(join(destination, ".cafe")).team!);
    } finally {
      await restored.stop();
    }
  });

  it("resumes persisted ownership transfer after the daemon stops before commit", async () => {
    const { home, source, destination } = fixture();
    const first = await startDaemon("relocate-interrupted", home);
    try {
      first.daemon.publishRoster(source, readCafeFile(join(source, ".cafe")).team!);
      vi.spyOn(first.daemon, "recoverTeamRelocation").mockRejectedValueOnce(new Error("fixture interrupted before ownership commit"));
      expect((await relocate(first, source, destination)).ok).toBe(false);
      expect(first.daemon.supervisor?.pendingTeamRelocation()?.phase).toBe("committing");
      expect(() => first.daemon.supervisor!.startTeam(source, readCafeFile(join(source, ".cafe")).team!)).toThrow(/fenced by a roster relocation/);
    } finally {
      await first.stop();
    }
    const restored = await startDaemon("relocate-interrupted", home);
    try {
      await restored.daemon.supervisor!.restore();
      await restored.daemon.recoverTeamRelocation();
      expect(restored.daemon.supervisor!.pendingTeamRelocation()).toBeUndefined();
      expect(restored.daemon.store.getKv("rosterOwners")).toMatchObject({ "relocate-interrupted/same-team/dev": realpathSync(destination) });
      expect(() => restored.daemon.supervisor!.startTeam(source, readCafeFile(join(source, ".cafe")).team!)).toThrow(/fenced by a roster relocation/);
    } finally {
      await restored.stop();
    }
  });

  it("removes a source TUI from routing before relocation stops workers", async () => {
    const { home, source, destination } = fixture();
    const daemon = await startDaemon("relocate-quarantine", home);
    try {
      daemon.daemon.publishRoster(source, readCafeFile(join(source, ".cafe")).team!);
      const c = new CafeClient({ daemon: daemon.addr });
      const spec = readCafeFile(join(source, ".cafe")).team!;
      const member = spec.members.find((m) => m.mode === "tui")!;
      const { memberLaunchHash } = await import("../packages/protocol/src/cafeFile.ts");
      await c.connect({ name: member.name, member: member.name, team: spec.name, teamChannel: spec.channel!,
        channels: [spec.channel!], role: "barista", mode: "tui", cwd: join(source, member.dir),
        memberLaunchHash: memberLaunchHash(source, spec, member), description: "", tags: [], scope: [], concurrency: 1 });
      expect(daemon.daemon.registry.all().some((r) => r.member === member.name && r.status !== "offline")).toBe(true);
      const response = await relocate(daemon, source, destination);
      expect(response.status, await response.text()).toBe(200);
      expect(daemon.daemon.registry.all().some((r) => r.member === member.name && r.status !== "offline")).toBe(false);
      c.close();
    } finally {
      await daemon.stop();
    }
  });

  it("refuses relocation when a destination read-only member has an invalid path", async () => {
    const { home, source, destination } = fixture();
    const daemon = await startDaemon("relocate-preflight", home);
    try {
      daemon.daemon.publishRoster(source, readCafeFile(join(source, ".cafe")).team!);
      const bad = readCafeFile(join(destination, ".cafe"));
      bad.team!.members.push({ name: "broken", dir: "../outside", mode: "headless", access: "read-only" } as never);
      writeFileSync(join(destination, ".cafe"), stringify(bad));
      const response = await relocate(daemon, source, destination);
      expect(response.status).toBe(409);
      expect(daemon.daemon.store.getKv<Record<string, string>>("rosterOwners")?.["relocate-preflight/same-team/dev"]).toBe(realpathSync(source));
      expect(daemon.daemon.supervisor?.pendingTeamRelocation()).toBeUndefined();
    } finally {
      await daemon.stop();
    }
  });

  it("requires the local operator credential and leaves ownership unchanged on denial", async () => {
    const { home, source, destination } = fixture();
    const daemon = await startDaemon("relocate-auth", home);
    try {
      const spec = readCafeFile(join(source, ".cafe")).team!;
      daemon.daemon.publishRoster(source, spec);
      const response = await relocate(daemon, source, destination, "wrong-key");
      expect(response.status).toBe(403);
      expect(() => daemon.daemon.publishRoster(destination, readCafeFile(join(destination, ".cafe")).team!)).toThrow(/uses roster directory/i);
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a destination already owned by another roster", async () => {
    const { home, source, destination } = fixture();
    const daemon = await startDaemon("relocate-conflict", home);
    try {
      const sourceSpec = readCafeFile(join(source, ".cafe")).team!;
      daemon.daemon.publishRoster(source, sourceSpec);
      daemon.daemon.publishRoster(destination, { ...sourceSpec, name: "other-team" });
      const response = await relocate(daemon, source, destination);
      expect(response.status).toBe(409);
      expect(() => daemon.daemon.publishRoster(source, sourceSpec)).not.toThrow();
    } finally {
      await daemon.stop();
    }
  });
});
