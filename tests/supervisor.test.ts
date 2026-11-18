import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function supervisor(home: string, extra: { backoffBaseMs?: number } = {}) {
  const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: FAKE_PI, extension: "/dev/null", graceMs: 500, ...extra });
  cleanup.push(() => sup.shutdown());
  return sup;
}

describe("supervisor", () => {
  it("starts one worker per concurrency slot, lists and stops them", async () => {
    const { home, dir, pidfile } = setup(2);
    const sup = supervisor(home);
    const started = sup.start({ dir });
    expect(started).toHaveLength(2);
    await waitFor(() => pidsIn(pidfile).length === 2, 5000);
    expect(sup.list().every((w) => w.running)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "baristas.json"), "utf8"))).toEqual([{ dir }]);
    await waitFor(() => JSON.parse(readFileSync(join(home, "baristas.runtime.json"), "utf8")).length === 2, 5000);

    // Worker output reaches the per-worker log.
    const log = join(home, "logs", "barista-work-1.log");
    await waitFor(() => readFileSync(log, "utf8").includes("fake pi"), 5000);
    expect(sup.stop(dir)).toBe(2);
    await waitFor(() => pidsIn(pidfile).every((p) => !alive(p)), 5000);
    expect(sup.list()).toEqual([]);
  });

  it("restarts a crashed worker with backoff", async () => {
    const { home, dir, pidfile } = setup();
    process.env.FAKE_PI_EXIT_AFTER_MS = "150";
    const sup = supervisor(home, { backoffBaseMs: 50 });
    sup.start({ dir });
    await waitFor(() => pidsIn(pidfile).length >= 3, 8000);
    expect(sup.list()[0]!.restarts).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(home, "logs", "barista-work-1.log"), "utf8")).toContain("exited code=3");
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

  it("a missing pi binary backs off instead of hot-looping", async () => {
    const { home, dir } = setup();
    const sup = new Supervisor({ home, daemonAddr: "127.0.0.1:1", token: "t", piBin: "/nonexistent/pi", graceMs: 200, backoffBaseMs: 300 });
    cleanup.push(() => sup.shutdown());
    sup.start({ dir });
    await waitFor(() => existsSync(join(home, "logs", "barista-work-1.log")) && readFileSync(join(home, "logs", "barista-work-1.log"), "utf8").includes("not found"), 5000);
    await new Promise((r) => setTimeout(r, 700));
    // base 300ms doubling: at most ~2 restarts in ~1s.
    expect(sup.list()[0]!.restarts).toBeLessThanOrEqual(3);
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
