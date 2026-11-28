import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probeReadonlyRuntime, readonlyToolArgs, Supervisor } from "../packages/daemon/src/supervisor.ts";

const root = mkdtempSync(join(tmpdir(), "cafe-runtime-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PROBE = new URL("../scripts/readonly-runtime-probe.mjs", import.meta.url).pathname;

function fakeRuntime(name: string, script: string): string {
  const bin = join(root, name);
  writeFileSync(bin, `#!${process.execPath}\n${script}\n`, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

/** A runtime that behaves like a compatible, properly restricted read-only binary. */
function compliantRuntime(dirName: string, name: "pi" | "omp"): string {
  mkdirSync(join(root, dirName));
  const tools = name === "pi"
    ? ["read", "grep", "find", "ls", "cafe_agents", "cafe_ask", "cafe_reply", "cafe_decline"]
    : ["read", "grep", "glob", "cafe_agents", "cafe_ask", "cafe_reply", "cafe_decline"];
  return fakeRuntime(join(dirName, name), `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log(${JSON.stringify(name === "pi" ? "pi 1.6.0" : "omp/19.0.1")}); process.exit(0); }
if (a.includes("--help")) { console.log("--tools --no-mcp --no-extensions -e --mode rpc --no-session"); process.exit(0); }
if (process.env.CAFE_PROBE && a.includes("rpc")) {
  let input = "";
  process.stdin.on("data", (d) => input += d);
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ id: 1, tools: ${JSON.stringify(tools)} }));
    console.log(JSON.stringify({ id: 2, unavailable: true }));
    console.log(JSON.stringify({ id: 3, success: true }));
    process.exit(0);
  });
} else {
  fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(a) + "\\n");
  setInterval(() => {}, 1000);
}
`);
}

/** A runtime that exposes a namespaced write tool and touches its profile directory. */
function leakingRuntime(dirName: string, marker: string): string {
  mkdirSync(join(root, dirName));
  return fakeRuntime(join(dirName, "pi"), `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("pi 1.6.0"); process.exit(0); }
if (a.includes("--help")) { console.log("--tools --no-mcp --no-extensions -e --mode rpc --no-session"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(marker)}, "side effect");
if (process.env.CAFE_PROBE && a.includes("rpc")) {
  let input = "";
  process.stdin.on("data", (d) => input += d);
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ id: 1, tools: ["read", "mcp__fake__write"] }));
    console.log(JSON.stringify({ id: 2, tools: ["mcp__fake__write"] }));
    console.log(JSON.stringify({ id: 3, success: false }));
    process.exit(0);
  });
} else {
  setInterval(() => {}, 1000);
}
`);
}

async function waitForWorker(sup: Supervisor, dir: string, state: "running" | "failed"): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const worker = sup.list().find((w) => w.dir === dir);
    if (worker?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`worker in ${dir} never became ${state}: ${JSON.stringify(sup.list())}`);
}

describe("read-only worker launch", () => {
  it("does not accept an unverified runtime based on RPC tool names alone", async () => {
    const binary = compliantRuntime("unverified-pi", "pi");
    const extension = join(root, "unverified-extension.mjs");
    writeFileSync(extension, "export default () => {};");
    const result = await probeReadonlyRuntime(binary, "pi", extension, { home: join(root, "unverified-home") });
    expect(result.supported).toBe(false);
  });

  it("finds a bare runtime on the worker PATH while keeping an unverified launch blocked", async () => {
    compliantRuntime("runtime-path", "omp");
    const extension = join(root, "path-extension.mjs");
    writeFileSync(extension, "export default () => {};");
    const options = { home: join(root, "path-home"), path: join(root, "runtime-path") };
    await expect(probeReadonlyRuntime("omp", "omp", extension, options)).resolves.toMatchObject({
      supported: false, binaryHash: expect.stringMatching(/^[a-f0-9]{64}$/), reason: expect.stringMatching(/found.*cannot verify/i),
    });
    await expect(probeReadonlyRuntime("absent", "omp", extension, options)).resolves.toMatchObject({
      supported: false, binaryHash: "", reason: expect.stringMatching(/daemon.*PATH/i),
    });
  });

  it("builds the Pi allowlist and disables MCP and extension discovery", () => {
    expect(readonlyToolArgs("pi", "/cafe/ext.ts")).toEqual([
      "--tools", "read,grep,find,ls,cafe_ask,cafe_agents,cafe_reply,cafe_decline",
      "--no-mcp", "--no-extensions", "-e", "/cafe/ext.ts",
    ]);
  });

  it("builds the OMP allowlist and disables extension discovery", () => {
    expect(readonlyToolArgs("omp", "/cafe/ext.ts")).toEqual([
      "--tools", "read,grep,glob,cafe_ask,cafe_agents,cafe_reply,cafe_decline",
      "--no-extensions", "-e", "/cafe/ext.ts",
    ]);
  });

  it("documents that standalone workers default to read-only and require --write for editing", () => {
    const result = spawnSync(process.execPath, [new URL("../packages/cli/bin/cafe.js", import.meta.url).pathname, "barista", "start", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--write");
    expect(result.stdout).toMatch(/read-only.*default|default.*read-only/i);
  });

  it("passes the exact Pi and OMP read-only argv and permits explicit write launches", async () => {
    const home = join(root, "sup-home");
    const argsFile = join(root, "args.jsonl");
    const extension = join(root, "cafe-ext.mjs");
    writeFileSync(extension, "export default () => {};");
    const piBin = compliantRuntime("rpi", "pi");
    const ompBin = compliantRuntime("romp", "omp");
    process.env.FAKE_ARGS_FILE = argsFile;
    const dirs = ["pi-read", "omp-read", "pi-write", "omp-write"].map((name) => {
      const dir = join(root, name); mkdirSync(dir); writeFileSync(join(dir, ".cafe"), `name: ${name}\n`); return dir;
    });
    const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin, extension, graceMs: 100, backoffBaseMs: 5000, probeScript: PROBE });
    sup.start({ dir: dirs[0]! });
    sup.start({ dir: dirs[1]!, bin: ompBin });
    sup.start({ dir: dirs[2]!, access: "workspace-write" });
    sup.start({ dir: dirs[3]!, bin: ompBin, access: "workspace-write" });
    await Promise.all(dirs.map((dir) => waitForWorker(sup, dir, "running")));
    // The guard marks a worker running the moment its child spawns; the fake still needs to boot
    // before it can record its argv, so settle briefly before stopping.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await sup.shutdown();
    const argvs = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argvs.filter((a) => a.includes("--tools")).every((a) => a.includes("-e") && a.includes(extension))).toBe(true);
    expect(argvs.some((a) => a[a.indexOf("--tools") + 1] === "read,grep,find,ls,cafe_ask,cafe_agents,cafe_reply,cafe_decline" && a.includes("--no-mcp") && a.includes("--no-extensions"))).toBe(true);
    expect(argvs.some((a) => a[a.indexOf("--tools") + 1] === "read,grep,glob,cafe_ask,cafe_agents,cafe_reply,cafe_decline" && !a.includes("--no-mcp") && a.includes("--no-extensions"))).toBe(true);
    expect(argvs.filter((a) => !a.includes("--tools"))).toHaveLength(2);
  });

  it("runs an isolated no-model probe, blocks a fake namespaced write tool, and caches only by binary hash", async () => {
    const home = join(root, "probe-cache");
    const extension = join(root, "ext.mjs");
    writeFileSync(extension, "export default () => {};");
    const safe = compliantRuntime("probe-safe", "pi");
    const result = await probeReadonlyRuntime(safe, "pi", extension, { home, probeScript: PROBE });
    expect(result.supported).toBe(true);
    expect(result.binaryHash).toMatch(/^[0-9a-f]{64}$/);
    const cached = await probeReadonlyRuntime(safe, "pi", extension, { home, probeScript: PROBE });
    expect(cached.fromCache).toBe(true);
    writeFileSync(safe, readFileSync(safe, "utf8").replace("cafe_ask", "mcp__fake__write"));
    chmodSync(safe, 0o755);
    const changed = await probeReadonlyRuntime(safe, "pi", extension, { home, probeScript: PROBE });
    expect(changed.supported).toBe(false);
    expect(changed.binaryHash).not.toBe(result.binaryHash);
    const marker = join(root, "side-effect");
    const bad = await probeReadonlyRuntime(leakingRuntime("probe-leak", marker), "pi", extension, { home, probeScript: PROBE });
    expect(bad.supported).toBe(false);
    expect(bad.reason).toMatch(/tool|write|allowlist|mcp/i);
  });

  it("refuses to spawn a worker when the exact executable hash has no passing probe", async () => {
    const home = join(root, "failing-home");
    const dir = join(root, "failing-work");
    mkdirSync(dir); writeFileSync(join(dir, ".cafe"), "name: failing\n");
    const extension = join(root, "failing-ext.mjs");
    writeFileSync(extension, "export default () => {};");
    const marker = join(root, "failing-side-effect");
    const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: leakingRuntime("failing-bin", marker), extension, graceMs: 100, probeScript: PROBE });
    sup.start({ dir });
    await waitForWorker(sup, dir, "failed");
    const w = sup.list()[0]!;
    expect(w.state).toBe("failed");
    expect(w.lastError).toMatch(/probe|unsupported|read-only/i);
    expect(w.pid).toBeUndefined();
  });
});
