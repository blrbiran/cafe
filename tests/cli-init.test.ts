import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCafeFile } from "@cafe/protocol/cafe-file";

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const dirs: string[] = [];
function temp(prefix = "cafe-init-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function cafe(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CAFE_HOME: join(cwd, ".home"), CAFE_DAEMON: "", CAFE_TOKEN: "" },
  });
}

describe("cafe init", () => {
  it("creates a .cafe the protocol can read" , () => {
    const dir = temp();
    const r = cafe(dir, "init", "--yes", "--name", "widgets", "--description", "owns widgets");
    expect(r.status).toBe(0);
    const file = join(dir, ".cafe");
    const id = readCafeFile(file);
    expect(id).toMatchObject({ name: "widgets", description: "owns widgets", role: "barista", concurrency: 1 });
    expect(readFileSync(file, "utf8")).toContain("#");
    expect(r.stdout).toContain(`cafe barista start --dir ${realpathSync(dir)}`);
  });

  it("defaults the name to the directory and works without a TTY", () => {
    const dir = temp("cafe-widgets-");
    const r = cafe(dir, "init");
    expect(r.status).toBe(0);
    expect(readCafeFile(join(dir, ".cafe")).name).toBe(dir.split("/").pop());
  });

  it("refuses to overwrite an existing .cafe without --force", () => {
    const dir = temp();
    writeFileSync(join(dir, ".cafe"), "name: keep-me\n");
    const r = cafe(dir, "init", "--yes");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--force");
    expect(readFileSync(join(dir, ".cafe"), "utf8")).toBe("name: keep-me\n");
  });

  it("overwrites with --force", () => {
    const dir = temp();
    writeFileSync(join(dir, ".cafe"), "name: keep-me\n");
    const r = cafe(dir, "init", "--yes", "--force", "--name", "new-name");
    expect(r.status).toBe(0);
    expect(readCafeFile(join(dir, ".cafe")).name).toBe("new-name");
  });

  it("never overwrites the ~/.cafe data directory", () => {
    const dir = temp();
    mkdirSync(join(dir, ".cafe"));
    const r = cafe(dir, "init", "--yes", "--force");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/directory/);
  });

  it("rejects an invalid name before writing", () => {
    const dir = temp();
    const r = cafe(dir, "init", "--yes", "--name", "bad name!");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("name");
    expect(() => readCafeFile(join(dir, ".cafe"))).toThrow();
  });
});

describe("help", () => {
  it("shows a quick start and the init command", () => {
    const dir = temp();
    const r = cafe(dir, "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Quick start");
    expect(r.stdout).toContain("cafe init");
  });

  it("gives every documented subcommand a description", () => {
    const dir = temp();
    for (const [cmd, needle] of [
      [["barista", "start"], "directory"],
      [["barista", "stop"], "stop"],
      [["barista", "list"], "list"],
      [["config", "get"], "value"],
      [["root", "show"], "root"],
      [["skill", "install"], "~/.claude/skills/cafe"],
    ] as const) {
      const r = cafe(dir, ...cmd, "--help");
      expect(r.status, `${cmd.join(" ")} --help`).toBe(0);
      expect(r.stdout, `${cmd.join(" ")} --help`).toMatch(new RegExp(needle, "i"));
    }
  });

  it("fails an unknown command even with --help", () => {
    const dir = temp();
    const r = cafe(dir, "frobnicate", "--help");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command 'frobnicate'");
  });
});
