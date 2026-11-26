import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentIdentity, loadTeamMember, readCafeFile } from "@cafe/protocol/cafe-file";

const dirs: string[] = [];
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cafe-team-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const roster = (extra = "") => `name: myproj
description: project
team:
  channel: myproj-dev
  members:
    - name: orch
      duty: orchestrator
      description: splits work
      mode: headless
    - name: dev1
      duty: developer
      description: writes code
      mode: headless
    - name: watch
      duty: monitor
      observer: true
      channels: [myproj-dev, default]
${extra}`;

describe(".cafe team roster (v4-11)", () => {
  it("parses the roster and defaults each member into the team channel", () => {
    const dir = scratch({ ".cafe": roster() });
    const doc = readCafeFile(join(dir, ".cafe"));
    expect(doc.team).toMatchObject({ name: "myproj", channel: "myproj-dev" });
    expect(doc.team!.members.find((m) => m.name === "dev1")!.channels).toEqual(["myproj-dev"]);
    const loaded = loadTeamMember(dir, "dev1");
    expect(loaded.member).toMatchObject({ duty: "developer", mode: "headless" });
  });

  it("sanitizes a team name into a channel and rejects the reserved default", () => {
    const dir = scratch({ ".cafe": "name: my.proj\nteam:\n  members:\n    - name: orch\n      duty: orchestrator\n    - name: dev1\n" });
    expect(readCafeFile(join(dir, ".cafe")).team!.channel).toBe("my-proj");
    const bad = scratch({ ".cafe": "name: myproj\nteam:\n  channel: default\n  members:\n    - name: orch\n      duty: orchestrator\n" });
    expect(() => readCafeFile(join(bad, ".cafe"))).toThrow(/invalid or reserved/);
  });

  it("requires exactly one orchestrator and a member name different from the team name (v4-13)", () => {
    const none = scratch({ ".cafe": "name: myproj\nteam:\n  members:\n    - name: dev1\n" });
    expect(() => readCafeFile(join(none, ".cafe"))).toThrow(/exactly one member with duty: orchestrator \(found 0\)/);
    const two = scratch({ ".cafe": "name: myproj\nteam:\n  members:\n    - name: o1\n      duty: orchestrator\n    - name: o2\n      duty: Orchestrator\n" });
    expect(() => readCafeFile(join(two, ".cafe"))).toThrow(/exactly one member with duty: orchestrator \(found 2\)/);
    const same = scratch({ ".cafe": "name: myproj\nteam:\n  members:\n    - name: myproj\n      duty: orchestrator\n" });
    expect(() => readCafeFile(join(same, ".cafe"))).toThrow(/same name as the team/);
  });

  it("rejects duplicate members, a non-member channel and a bad observer", () => {
    const dup = scratch({ ".cafe": roster("    - name: dev1\n") });
    expect(() => readCafeFile(join(dup, ".cafe"))).toThrow(/listed twice/);
    const off = scratch({ ".cafe": roster("    - name: lone\n      channels: [other]\n") });
    expect(() => readCafeFile(join(off, ".cafe"))).toThrow(/must include the team channel/);
    const obs = scratch({ ".cafe": roster().replace("channels: [myproj-dev, default]", "channels: [default]") });
    expect(() => readCafeFile(join(obs, ".cafe"))).toThrow(/must include the team channel/);
  });

  it("registers a member identity from a sibling directory with no .cafe of its own", () => {
    const dir = scratch({ ".cafe": roster() });
    const work = mkdtempSync(join(tmpdir(), "cafe-work-"));
    dirs.push(work);
    process.env.CAFE_TEAM_MEMBER = "dev1";
    process.env.CAFE_TEAM_DIR = dir;
    try {
      const loaded = loadAgentIdentity(work);
      expect(loaded.identity).toMatchObject({
        name: "dev1",
        role: "barista",
        duty: "developer",
        team: "myproj",
        teamChannel: "myproj-dev",
        member: "dev1",
        channels: ["myproj-dev"],
        teamDir: dir,
      });
    } finally {
      delete process.env.CAFE_TEAM_MEMBER;
      delete process.env.CAFE_TEAM_DIR;
    }
  });

  it("names the roster when a member is unknown", () => {
    const dir = scratch({ ".cafe": roster() });
    expect(() => loadTeamMember(dir, "nope")).toThrow(/roster: orch, dev1, watch/);
  });
});