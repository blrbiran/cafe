import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { CafeClient } from "@cafe/protocol/client";
import { memberLaunchHash } from "@cafe/protocol/cafe-file";
import { identity, startDaemon, waitFor } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCafeFile } from "../packages/protocol/src/cafeFile.ts";
import { TeamMember } from "../packages/protocol/src/index.ts";
import { effectiveMemberAccess, readPathGrants, resolveMemberPath, revokeMemberPath, trustMemberPath, validateMemberPath } from "../packages/daemon/src/team-paths.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function dir(prefix = "cafe-path-") { const p = mkdtempSync(join(tmpdir(), prefix)); roots.push(p); return p; }
function roster(root: string, memberDir: string, mode = "headless", access = "") {
  const accessLine = access ? `      access: ${access}\n` : "";
  const path = join(root, ".cafe");
  writeFileSync(path, `name: team\ndescription: fixture\nteam:\n  channel: team-dev\n  members:\n    - name: orch\n      duty: orchestrator\n      dir: .\n    - name: worker\n      mode: ${mode}\n      dir: ${JSON.stringify(memberDir)}\n${accessLine}`);
  return path;
}

describe("team path authorization", () => {
  it("rejects unsafe roster directory declarations", () => {
    const root = dir();
    expect(() => readCafeFile(roster(root, "../outside"))).not.toThrow();
    roster(root, "../outside");
    expect(TeamMember.safeParse({ name: "worker", dir: "/tmp/outside" }).success).toBe(false);
    expect(TeamMember.safeParse({ name: "worker", dir: "bad\u0000dir" }).success).toBe(false);
  });

  it.each(["read-only", "write"])("ignores legacy TUI %s without changing YAML or headless access", (access) => {
    const root = dir();
    const file = roster(root, ".", "tui", access);
    const source = readFileSync(file, "utf8").replace("      duty: orchestrator", "      duty: orchestrator\n      access: read-only");
    writeFileSync(file, source);
    const ignored: string[] = [];
    const doc = readCafeFile(file, { onIgnoredTuiAccess: (member: string) => ignored.push(member) });
    expect(ignored).toEqual(["worker"]);
    expect(doc.team!.members[0]?.access).toBe("read-only");
    expect(doc.team!.members[1]).not.toHaveProperty("access");
    expect(readFileSync(file, "utf8")).toBe(source);
  });

  it("keeps the TUI launch hash stable even when a caller supplies ignored access", () => {
    const root = dir();
    const spec = readCafeFile(roster(root, ".", "tui")).team!;
    const member = spec.members[1]!;
    const original = memberLaunchHash(root, spec, member);
    expect(memberLaunchHash(root, spec, { ...member, access: "read-only" })).toBe(original);
    expect(memberLaunchHash(root, spec, { ...member, access: "write" })).toBe(original);
  });

  it("resolves internal paths canonically and rejects unsafe or missing targets", () => {
    const root = dir();
    mkdirSync(join(root, "inside"));
    const outside = dir("cafe-path-outside-");
    symlinkSync(join(root, "inside"), join(root, "inside-link"));
    symlinkSync(outside, join(root, "escape"));
    expect(resolveMemberPath(root, "inside-link").insideRoot).toBe(true);
    expect(() => resolveMemberPath(root, "../outside")).toThrow(/grant|outside|escape/i);
    expect(() => resolveMemberPath(root, "escape")).toThrow(/grant|outside|escape/i);
    expect(() => resolveMemberPath(root, "missing")).toThrow(/exist|directory/i);
    expect(() => resolveMemberPath(root, "bad\u0000path")).toThrow(/NUL|path/i);
  });

  it("requires an exact local grant and invalidates a recreated target", () => {
    const home = dir("cafe-grant-home-");
    const root = dir("cafe-grant-root-");
    const external = dir("cafe-grant-target-");
    const other = dir("cafe-grant-other-");
    mkdirSync(join(root, "other"));
    const targetLink = join(root, "external");
    symlinkSync(external, targetLink);
    symlinkSync(other, join(root, "other-link"));
    roster(root, "external");
    expect(() => resolveMemberPath(root, "external")).toThrow(/grant/i);
    const grant = trustMemberPath(home, root, "team", "worker", "external");
    expect(validateMemberPath(home, root, "worker", "external").realPath).toBe(grant.realPath);
    expect(() => validateMemberPath(home, root, "other", "external")).toThrow(/grant/i);
    expect(() => validateMemberPath(home, root, "worker", "other-link")).toThrow(/grant/i);
    const before = readPathGrants(home);
    expect(before).toHaveLength(1);
    expect((awaitImportStat(grant.realPath)).ino).toBeGreaterThan(0);
    rmSync(external, { recursive: true });
    mkdirSync(external);
    expect(() => validateMemberPath(home, root, "worker", "external")).toThrow(/grant|identity|changed/i);
    const revoked = revokeMemberPath(home, grant.grantId);
    expect(revoked.state).toBe("revoked");
    expect(readPathGrants(home)[0]?.state).toBe("revoked");
  });

  it("allows multiple exact grants for one member and revokes by ID after path loss", () => {
    const home = dir("cafe-grants-home-");
    const root = dir("cafe-grants-root-");
    const a = dir("cafe-grants-a-");
    const b = dir("cafe-grants-b-");
    symlinkSync(a, join(root, "a"));
    symlinkSync(b, join(root, "b"));
    roster(root, "a");
    const first = trustMemberPath(home, root, "team", "worker", "a");
    roster(root, "b");
    const second = trustMemberPath(home, root, "team", "worker", "b");
    expect(first.grantId).not.toBe(second.grantId);
    rmSync(join(root, "a"));
    revokeMemberPath(home, first.grantId);
    expect(readPathGrants(home).find((g) => g.grantId === first.grantId)?.state).toBe("revoked");
    expect(readCafeFile(roster(root, "../outside")).team?.members[1]?.dir).toBe("../outside");
  });

  it("revokes an external terminal grant by operator request and rejects re-registration", async () => {
    const home = dir("cafe-grant-home-");
    const root = dir("cafe-grant-roster-");
    const target = dir("cafe-grant-worker-");
    symlinkSync(target, join(root, "external"));
    const path = roster(root, "external", "tui");
    const spec = readCafeFile(path).team!;
    const member = spec.members[1]!;
    const grant = trustMemberPath(home, root, "team", member.name, "external");
    const d = await startDaemon("grant-control", { home, mode: "root" });
    const worker = new CafeClient({ daemon: d.addr });
    const workerIdentity = identity(member.name, { team: "team", teamChannel: "team-dev", member: member.name, mode: "tui", cwd: target, memberLaunchHash: memberLaunchHash(root, spec, member) });
    try {
      d.daemon.publishRoster(root, spec);
      await worker.connect(workerIdentity);
      const url = `http://${d.addr}/api/team-paths/${grant.grantId}`;
      expect((await fetch(url, { method: "DELETE" })).status).toBe(403);
      const response = await fetch(url, { method: "DELETE", headers: { "x-cafe-operator-key": readFileSync(join(home, "operator.key"), "utf8") } });
      expect(response.status).toBe(200);
      await waitFor(() => !worker.connected);
      expect(readPathGrants(home)).toContainEqual(expect.objectContaining({ grantId: grant.grantId, state: "revoked" }));
      await expect(worker.connect(workerIdentity)).rejects.toMatchObject({ code: "team_launch_mismatch" });
    } finally {
      worker.close();
      await d.stop();
    }
  });

  it("defaults headless members to read-only and labels TUI host-managed", () => {
    expect(effectiveMemberAccess({ mode: "headless" })).toBe("read-only");
    expect(effectiveMemberAccess({ mode: "headless", access: "write" })).toBe("write");
    expect(effectiveMemberAccess({ mode: "tui" })).toBe("host-managed");
    expect(() => effectiveMemberAccess({ mode: "tui", access: "write" })).toThrow(/TUI.*access|access.*TUI/i);
  });
});

function awaitImportStat(path: string) { return statSync(path); }
