import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "@cafe/daemon";
import { readProcessStart } from "../packages/daemon/src/proc/processStart.ts";
import { waitFor } from "./helpers.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const SUPERVISE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "supervise.ts");
chmodSync(FAKE_PI, 0o755);

const cleanup: Array<() => Promise<void> | void> = [];
const pidfiles: string[] = [];
afterEach(async () => {
  // Kill every fake worker first (the temp dir holding the pidfile is removed by cleanup).
  const pids = pidfiles.splice(0).flatMap(pidsIn);
  while (cleanup.length) await cleanup.pop()!();
  for (const pid of pids) killGroup(pid);
  delete process.env.FAKE_PI_PIDFILE;
  delete process.env.FAKE_PI_EXIT_AFTER_MS;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  }
}

function pidsIn(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

/** A temp CAFE_HOME, a barista dir with a .cafe, and a pidfile the fake pi appends to. */
function setup(concurrency = 1) {
  const root = mkdtempSync(join(tmpdir(), "cafe-sup-"));
  const home = join(root, "home");
  const dir = join(root, "work");
  mkdirSync(home);
  mkdirSync(dir);
  writeFileSync(join(dir, ".cafe"), `name: worker\nconcurrency: ${concurrency}\n`);
  const pidfile = join(root, "pids.txt");
  pidfiles.push(pidfile);
  process.env.FAKE_PI_PIDFILE = pidfile;
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, dir, pidfile };
}

function supervisor(home: string, extra: { backoffBaseMs?: number; log?: (message: string) => void } = {}) {
  const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: FAKE_PI, extension: "/dev/null", graceMs: 500, ...extra });
  cleanup.push(() => sup.shutdown());
  return sup;
}

describe("supervisor", () => {
  it("does not attach a concurrency warning to a one-slot worker", () => {
    const { home, dir } = setup(1);
    const messages: string[] = [];
    const sup = supervisor(home, { log: (message) => messages.push(message) });
    const started = sup.start({ dir });
    expect(started).toHaveLength(1);
    expect(started[0]?.warning).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it("starts one serial worker and warns when .cafe requests unsupported parallel slots", async () => {
    const { home, dir, pidfile } = setup(3);
    const messages: string[] = [];
    const sup = supervisor(home, { log: (message) => messages.push(message) });
    const started = sup.start({ dir });
    expect(started).toHaveLength(1);
    expect(started[0]?.warning).toContain("concurrency 3");
    await waitFor(() => pidsIn(pidfile).length === 1, 5000);
    expect(sup.list().every((w) => w.running)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "baristas.json"), "utf8"))).toEqual([{ dir }]);
    await waitFor(() => JSON.parse(readFileSync(join(home, "baristas.runtime.json"), "utf8")).length === 1, 5000);

    // Worker output reaches the per-worker log.
    const log = sup.list()[0]!.log;
    await waitFor(() => readFileSync(log, "utf8").includes("fake pi"), 5000);
    expect(sup.stop(dir)).toBe(1);
    await waitFor(() => pidsIn(pidfile).every((p) => !alive(p)), 5000);
    expect(sup.list()).toEqual([]);
    expect(messages.join("\n")).toContain("concurrency 3");
  });

  it("restarts a crashed worker with backoff", async () => {
    const { home, dir, pidfile } = setup();
    process.env.FAKE_PI_EXIT_AFTER_MS = "150";
    const sup = supervisor(home, { backoffBaseMs: 50 });
    sup.start({ dir });
    await waitFor(() => pidsIn(pidfile).length >= 3, 8000);
    expect(sup.list()[0]!.restarts).toBeGreaterThanOrEqual(2);
    expect(readFileSync(sup.list()[0]!.log, "utf8")).toContain("exited code=3");
  });

  it("workers die with the supervising process (parent-death guard)", async () => {
    const { home, dir, pidfile } = setup();
    const proc: ChildProcess = spawn(process.execPath, ["--no-warnings", SUPERVISE], {
      env: { ...process.env, SUP_HOME: home, SUP_DIR: dir, CAFE_PI_BIN: FAKE_PI },
      stdio: ["ignore", "pipe", "inherit"],
    });
    cleanup.push(() => void proc.kill("SIGKILL"));
    await waitFor(() => pidsIn(pidfile).length === 1, 8000);
    const [fake] = pidsIn(pidfile);
    expect(alive(fake!)).toBe(true);
    proc.kill("SIGKILL"); // no chance to clean up
    await waitFor(() => !alive(fake!), 5000);
  });

  it("restore() reaps a surviving worker group recorded by a previous daemon, without duplicates", async () => {
    const { home, dir, pidfile } = setup();
    // Simulate a worker that outlived its daemon: a detached group leader recorded in the runtime file.
    const stale = spawn(FAKE_PI, [], { detached: true, stdio: "ignore", env: process.env });
    stale.on("error", () => {});
    await waitFor(() => pidsIn(pidfile).length === 1, 5000);
    const startedAt = (await readProcessStart(stale.pid!))!;
    writeFileSync(join(home, "baristas.json"), JSON.stringify([{ dir }]));
    writeFileSync(join(home, "baristas.runtime.json"), JSON.stringify([{ dir, slot: 1, pid: stale.pid, startedAt }]));

    const sup = supervisor(home);
    const result = await sup.restore();
    expect(result.reaped).toBe(1);
    await waitFor(() => !alive(stale.pid!), 5000);
    await waitFor(() => pidsIn(pidfile).length === 2, 5000);
    expect(pidsIn(pidfile).filter(alive)).toHaveLength(1);
    expect(sup.list()).toHaveLength(1);
  });

  it("restore() never signals a pid whose start time does not match (pid reuse)", async () => {
    const { home, pidfile } = setup();
    const other = spawn(FAKE_PI, [], { detached: true, stdio: "ignore", env: process.env });
    other.on("error", () => {});
    await waitFor(() => pidsIn(pidfile).length === 1, 5000);
    writeFileSync(join(home, "baristas.runtime.json"), JSON.stringify([{ dir: "/x", slot: 1, pid: other.pid, startedAt: "Mon Jan  1 00:00:00 2001" }]));
    const sup = supervisor(home);
    const result = await sup.restore();
    expect(result.reaped).toBe(0);
    expect(result.skipped.join()).toContain(`pid ${other.pid}`);
    expect(alive(other.pid!)).toBe(true);
  });

  it("holds a persisted write scope when restore cannot verify the process group leader", async () => {
    const { home, dir, pidfile } = setup();
    const other = spawn(FAKE_PI, [], { detached: true, stdio: "ignore", env: process.env });
    other.on("error", () => {});
    await waitFor(() => pidsIn(pidfile).length === 1);
    const path = realpathSync(dir);
    const { dev, ino } = statSync(path, { bigint: true });
    const runtime = join(home, "baristas.runtime.json");
    writeFileSync(runtime, JSON.stringify([{ dir, slot: 1, pid: other.pid, startedAt: "not verified", writeScope: { path, ancestors: [`${dev}:${ino}`] } }]));
    const sup = supervisor(home);
    const result = await sup.restore();
    expect(result.reaped).toBe(0);
    expect(alive(other.pid!)).toBe(true);
    expect(() => sup.start({ dir, access: "workspace-write" })).toThrow(/still stopping/);
    expect(JSON.parse(readFileSync(runtime, "utf8"))).toEqual([expect.objectContaining({ pid: other.pid })]);
  });

  it("a missing pi binary is refused by the read-only probe instead of hot-looping", async () => {
    const { home, dir } = setup();
    const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: "/nonexistent/pi", graceMs: 200, backoffBaseMs: 300 });
    cleanup.push(() => sup.shutdown());
    sup.start({ dir });
    // The isolation probe fails closed before process creation: the worker never spawns, so it cannot
    // restart forever; it reports the same "not found" reason the old spawn path did.
    await waitFor(() => sup.list()[0]?.state === "failed", 5000);
    await new Promise((r) => setTimeout(r, 700));
    expect(sup.list()[0]!.lastError).toMatch(/not found/i);
    expect(sup.list()[0]!.restarts).toBe(0);
  });
});

describe("capped worker log", () => {
  it("cuts at the last full line under the cap and writes a marker", async () => {
    const { CappedLineFile, logTruncatedMarker } = await import("../packages/daemon/src/proc/cappedLog.ts");
    const root = mkdtempSync(join(tmpdir(), "cafe-cap-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "w.log");
    const f = new CappedLineFile(path, 20, logTruncatedMarker);
    f.write(Buffer.from("line one\n"));
    f.write(Buffer.from("line two\nline three\n"));
    f.write(Buffer.from("ignored\n"));
    f.close();
    expect(readFileSync(path, "utf8")).toBe(`line one\nline two\n${logTruncatedMarker(18)}`);
  });
});

// #82: a worker that fails at once (a Codex TUI Barista with no Codex session in its directory)
// was restarted forever, every minute, and the only trace was a per-worker log nobody was pointed at.
describe("supervisor failed state (#82)", () => {
  function failing(root: string): string {
    const bin = join(root, "fails.sh");
    writeFileSync(bin, "#!/bin/sh\necho 'cafe: cannot start: no Codex session in this directory' >&2\necho 'next: start codex here and try again' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    return bin;
  }

  it("stops restarting after three quick failures and keeps the reason", async () => {
    const { root, home, dir } = setup();
    const logged: string[] = [];
    const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: FAKE_PI, extension: "/dev/null", graceMs: 500, backoffBaseMs: 20, log: (m: string) => logged.push(m) });
    cleanup.push(() => sup.shutdown());
    sup.start({ dir, bin: failing(root) });
    await waitFor(() => sup.list()[0]?.state === "failed", 8000);
    const w = sup.list()[0]!;
    expect(w.restarts).toBeLessThanOrEqual(3);
    expect(w.running).toBe(false);
    expect(w.lastError).toContain("no Codex session");
    expect(w.lastError).toContain("next: start codex");
    // #102: the log name carries a short hash of the full directory, so two `work` dirs cannot collide.
    expect(w.log).toMatch(new RegExp(`^${join(home, "logs", "barista-work")}-[0-9a-f]{8}-1\\.log$`));
    // The daemon log hears about it, not only the per-worker log.
    expect(logged.join("\n")).toMatch(/gave up after 3 failed starts/);
    await new Promise((r) => setTimeout(r, 300));
    expect(sup.list()[0]!.restarts).toBe(w.restarts); // really stopped
  });

  it("lets start() replace a failed Barista in the same directory", async () => {
    const { root, home, dir } = setup();
    const sup = supervisor(home, { backoffBaseMs: 20 });
    sup.start({ dir, bin: failing(root) });
    await waitFor(() => sup.list()[0]?.state === "failed", 8000);
    const again = sup.start({ dir });
    expect(again).toHaveLength(1);
    expect(sup.list()).toHaveLength(1);
    await waitFor(() => sup.list()[0]?.state === "running", 5000);
  });

  // #102: `barista-<basename>-<slot>.log` made two different `…/work` directories share one log.
  it("gives same-named directories in different paths different worker logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cafe-sup-same-"));
    const home = join(root, "home");
    const a = join(root, "a", "work");
    const b = join(root, "b", "work");
    mkdirSync(home);
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, ".cafe"), "name: worker\n");
    writeFileSync(join(b, ".cafe"), "name: worker\n");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: FAKE_PI, extension: "/dev/null", graceMs: 200 });
    cleanup.push(() => sup.shutdown());

    const wa = sup.start({ dir: a })[0]!;
    const wb = sup.start({ dir: b })[0]!;
    expect(wa.log).not.toBe(wb.log);
    await waitFor(() => existsSync(wa.log) && existsSync(wb.log), 5000);
  });
});
