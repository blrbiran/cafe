import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { formatApiError } from "../packages/cli/src/errors.ts";

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const homes: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "cafe-cli-"));
  homes.push(d);
  return d;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function cafe(h: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: "", CAFE_TOKEN: "" },
  });
}

describe("daemon API errors", () => {
  it("does not repeat an error code already present in the message", () => {
    expect(formatApiError({ error: "EISDIR", message: "EISDIR: illegal operation on a directory, read" }, 500)).toBe("EISDIR: illegal operation on a directory, read");
  });

  it("keeps the code for a plain human message", () => {
    expect(formatApiError({ error: "no_barista", message: "no barista available" }, 503)).toBe("no_barista: no barista available");
    expect(formatApiError({}, 502)).toBe("502");
  });
});

describe("config get", () => {
  it("prints (not set) for an unset known value", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "router.model");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("(not set)");
    expect(r.stdout).not.toContain("undefined");
  });

  it("prints null for an unset value with --json", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "router.model", "--json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBeNull();
  });

  it("fails for an unknown key", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "nope");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown config key 'nope'");
  });

  it("still prints a set value", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "port");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("47821");
  });

  it("marks a config change that needs a restart", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "set", "mode", "root");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("restart required");
    expect(r.stdout).toContain("cafe daemon restart");
    expect(parse(readFileSync(join(h, "config.yml"), "utf8")).mode).toBe("root");
  });

  it("connect saves mode, root and token together", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "connect", "10.0.0.5:4777", "--token", "shared");
    expect(r.status).toBe(0);
    const saved = parse(readFileSync(join(h, "config.yml"), "utf8"));
    expect(saved).toMatchObject({ mode: "daemon", root: "10.0.0.5:4777", token: "shared" });
    expect(r.stdout).toContain("restart required");
  });
});
