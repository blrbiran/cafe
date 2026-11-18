import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIdentity } from "@cafe/protocol/cafe-file";
import { openWorkerLog, type CappedLineFile } from "./proc/cappedLog.ts";
import { probeGroup, readProcessStart, signalGroup } from "./proc/processStart.ts";

export interface BaristaSpec {
  /** Directory the headless pi runs in (its `.cafe` decides identity). */
  dir: string;
  /** Extra args for pi. */
  args?: string[];
  /** Agent executable for this Barista (`pi` by default; `omp` for oh-my-pi). */
  bin?: string;
}

interface Worker {
  spec: BaristaSpec;
  slot: number;
  child?: ChildProcess;
  /** `ps lstart` of the guard (process-group leader), recorded for reaping after a crash. */
  startedAt?: string;
  restarts: number;
  launchedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  stopping: boolean;
}

export interface WorkerInfo {
  dir: string;
  slot: number;
  pid?: number;
  restarts: number;
  startedAt?: number;
  running: boolean;
}

/** One live worker group as persisted in `baristas.runtime.json`. */
interface RuntimeEntry {
  dir: string;
  slot: number;
  /** Guard pid; also the process-group id. */
  pid: number;
  startedAt: string;
}

export interface SupervisorOptions {
  home: string;
  daemonAddr: string;
  token: string;
  piBin?: string;
  extension?: string;
  /** SIGTERM → SIGKILL grace for a worker group (default 5s). */
  graceMs?: number;
  /** First restart delay; doubles per consecutive crash up to 60s (default 1s). */
  backoffBaseMs?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, "proc", "guard.mjs");
/** After a worker's leader exits, give the pipes this long, then SIGKILL the group (grandchildren). */
const EXIT_DRAIN_MS = 1000;
const EXIT_NOT_FOUND = 127;

export function defaultExtensionPath(): string {
  return resolve(here, "../../pi-extension/src/index.ts");
}

/**
 * Keeps headless Baristas alive: one `pi --mode rpc` per concurrency slot, restarted with exponential
 * backoff. Registration and Order handling happen inside pi (cafe extension); the supervisor only owns
 * process lifetime.
 *
 * Each worker runs as `node guard.mjs pi …` in its own process group. The guard watches an fd-3 pipe from
 * this process and stops the group when the daemon dies, so workers never outlive it (no duplicates after
 * a restart). As a second line of defence, live groups are recorded with their start time in
 * `baristas.runtime.json`, and `restore()` reaps any that survived (exact pid + start-time match only).
 */
export class Supervisor {
  private workers: Worker[] = [];
  private readonly file: string;
  private readonly runtimeFile: string;
  private readonly logDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly piBin: string;
  private readonly extension: string;
  private readonly graceMs: number;
  private readonly backoffBaseMs: number;

  constructor(opts: SupervisorOptions) {
    this.file = join(opts.home, "baristas.json");
    this.runtimeFile = join(opts.home, "baristas.runtime.json");
    this.logDir = join(opts.home, "logs");
    this.piBin = opts.piBin ?? process.env.CAFE_PI_BIN ?? "pi";
    this.extension = opts.extension ?? defaultExtensionPath();
    this.graceMs = opts.graceMs ?? 5000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.env = {
      ...process.env,
      CAFE_DAEMON: opts.daemonAddr,
      CAFE_TOKEN: opts.token,
      CAFE_HEADLESS: "1",
      CAFE_GUARD_FD: "3",
      CAFE_GUARD_GRACE_MS: String(this.graceMs),
    };
  }

  /** Reap worker groups left by a previous daemon, then start the persisted Baristas. */
  async restore(): Promise<{ reaped: number; skipped: string[] }> {
    const result = await this.reapStale();
    if (existsSync(this.file)) {
      try {
        for (const spec of JSON.parse(readFileSync(this.file, "utf8")) as BaristaSpec[]) {
          try {
            this.start(spec, false);
          } catch {
            // e.g. directory no longer exists
          }
        }
      } catch {
        // corrupt file: ignore
      }
    }
    return result;
  }

  start(spec: BaristaSpec, persist = true): WorkerInfo[] {
    const dir = resolve(spec.dir);
    if (this.workers.some((w) => w.spec.dir === dir)) throw new Error(`barista already running in ${dir}`);
    const { cafe } = loadIdentity(dir);
    for (let slot = 1; slot <= cafe.concurrency; slot++) {
      const w: Worker = { spec: { ...spec, dir }, slot, restarts: 0, stopping: false };
      this.workers.push(w);
      this.launch(w);
    }
    if (persist) this.save();
    return this.list().filter((w) => w.dir === dir);
  }

  stop(dir: string): number {
    const target = resolve(dir);
    const ws = this.workers.filter((w) => w.spec.dir === target);
    for (const w of ws) this.kill(w);
    this.workers = this.workers.filter((w) => w.spec.dir !== target);
    this.save();
    return ws.length;
  }

  list(): WorkerInfo[] {
    return this.workers.map((w) => ({
      dir: w.spec.dir,
      slot: w.slot,
      pid: w.child?.pid,
      restarts: w.restarts,
      startedAt: w.launchedAt,
      running: !!w.child && w.child.exitCode === null && w.child.signalCode === null,
    }));
  }

  /** Signal every worker group (SIGTERM, SIGKILL after the grace) and resolve once they are gone or the grace passed. */
  async shutdown(): Promise<void> {
    const groups = this.workers.map((w) => w.child?.pid).filter((p): p is number => !!p);
    for (const w of this.workers) this.kill(w);
    const deadline = Date.now() + this.graceMs + 500;
    while (groups.some((g) => probeGroup(g) === "present") && Date.now() < deadline) await sleep(50);
  }

  // ---------------------------------------------------------------------------

  private launch(w: Worker): void {
    mkdirSync(this.logDir, { recursive: true });
    const name = w.spec.dir.split(/[\\/]/).filter(Boolean).pop() ?? "barista";
    let log: CappedLineFile | undefined;
    try {
      log = openWorkerLog(join(this.logDir, `barista-${name}-${w.slot}.log`));
    } catch {
      // Logging must never stop a worker from running.
    }
    const note = (msg: string) => {
      try {
        log?.write(Buffer.from(`[cafe] ${new Date().toISOString()} ${msg}\n`));
      } catch {
        log = undefined;
      }
    };
    const bin = w.spec.bin ?? this.piBin;
    const args = [GUARD, bin, "--mode", "rpc", "--no-session", "-e", this.extension, ...(w.spec.args ?? [])];
    // fd 3 is the guard's parent-death pipe: we keep our end open and never write to it.
    const child = spawn(process.execPath, args, { cwd: w.spec.dir, env: this.env, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true });
    // Attach 'error' first: an unhandled spawn error would crash the daemon.
    child.on("error", (err) => note(`spawn error: ${err.message}`));
    w.child = child;
    w.launchedAt = Date.now();
    w.startedAt = undefined;
    const sink = (chunk: Buffer) => {
      try {
        log?.write(chunk);
      } catch {
        log = undefined;
      }
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdio[3]?.on("error", () => {});
    note(`started pid=${child.pid} in ${w.spec.dir}`);
    if (child.pid) {
      const pid = child.pid;
      void readProcessStart(pid).then((lstart) => {
        if (lstart && w.child === child && child.exitCode === null) {
          w.startedAt = lstart;
          this.saveRuntime();
        }
      });
    }
    child.on("exit", (code, signal) => {
      note(code === EXIT_NOT_FOUND ? `agent executable not found: ${bin} (set CAFE_PI_BIN or --agent)` : `exited code=${code} signal=${signal}`);
      const pgid = child.pid;
      // Grandchildren may still hold the group's pipes: give them a moment, then SIGKILL the group.
      if (pgid) setTimeout(() => signalGroup(pgid, "SIGKILL"), EXIT_DRAIN_MS).unref?.();
      setTimeout(() => log?.close(), EXIT_DRAIN_MS + 100).unref?.();
      if (w.child === child) {
        w.child = undefined;
        w.startedAt = undefined;
        this.saveRuntime();
      }
      if (w.stopping) return;
      // Reset backoff after a healthy minute; never hot-loop (a missing binary backs off like any crash).
      if (w.launchedAt && Date.now() - w.launchedAt > 60_000) w.restarts = 0;
      const delay = Math.min(60_000, this.backoffBaseMs * 2 ** w.restarts++);
      w.timer = setTimeout(() => !w.stopping && this.launch(w), delay);
    });
  }

  private kill(w: Worker): void {
    w.stopping = true;
    clearTimeout(w.timer);
    const child = w.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const pgid = child.pid;
    signalGroup(pgid, "SIGTERM");
    setTimeout(() => {
      if (probeGroup(pgid) === "present") signalGroup(pgid, "SIGKILL");
    }, this.graceMs).unref?.();
  }

  /**
   * Reap worker groups recorded by a previous daemon that are still alive. Mirrors ccloop
   * reapRunProcesses: only an exact pid + start-time match is signalled, identity is re-checked right
   * before signalling, and a pid that now belongs to another process is never touched.
   */
  private async reapStale(): Promise<{ reaped: number; skipped: string[] }> {
    const skipped: string[] = [];
    let reaped = 0;
    let entries: RuntimeEntry[] = [];
    try {
      if (existsSync(this.runtimeFile)) entries = JSON.parse(readFileSync(this.runtimeFile, "utf8")) as RuntimeEntry[];
    } catch {
      skipped.push(`${this.runtimeFile}: unreadable`);
    }
    for (const e of entries) {
      if (!Number.isSafeInteger(e.pid) || e.pid <= 0 || typeof e.startedAt !== "string") continue;
      if (probeGroup(e.pid) !== "present") continue;
      const lstart = await readProcessStart(e.pid);
      if (lstart === null || lstart !== e.startedAt.trim()) {
        skipped.push(`pid ${e.pid}: identity changed (${lstart ?? "leader gone"}), not signalled`);
        continue;
      }
      const again = await readProcessStart(e.pid);
      if (again !== e.startedAt.trim()) {
        skipped.push(`pid ${e.pid}: identity changed before signalling`);
        continue;
      }
      signalGroup(e.pid, "SIGTERM");
      if (!(await waitGone(e.pid, this.graceMs))) {
        signalGroup(e.pid, "SIGKILL");
        await waitGone(e.pid, 5000);
      }
      reaped++;
    }
    this.saveRuntime();
    return { reaped, skipped };
  }

  private saveRuntime(): void {
    const live: RuntimeEntry[] = this.workers
      .filter((w) => w.child?.pid && w.startedAt)
      .map((w) => ({ dir: w.spec.dir, slot: w.slot, pid: w.child!.pid!, startedAt: w.startedAt! }));
    writeAtomic(this.runtimeFile, JSON.stringify(live, null, 2));
  }

  private save(): void {
    const specs = [...new Map(this.workers.map((w) => [w.spec.dir, w.spec])).values()];
    writeAtomic(this.file, JSON.stringify(specs, null, 2));
  }
}

function writeAtomic(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() <= deadline) {
    if (probeGroup(pgid) === "gone") return true;
    await sleep(50);
  }
  return probeGroup(pgid) === "gone";
}
