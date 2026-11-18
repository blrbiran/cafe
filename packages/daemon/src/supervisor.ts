import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIdentity } from "@cafe/protocol/cafe-file";

export interface BaristaSpec {
  /** Directory the headless pi runs in (its `.cafe` decides identity). */
  dir: string;
  /** Extra args for pi. */
  args?: string[];
}

interface Worker {
  spec: BaristaSpec;
  slot: number;
  child?: ChildProcess;
  restarts: number;
  startedAt?: number;
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

export function defaultExtensionPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../pi-extension/src/index.ts");
}

/**
 * Keeps headless Baristas alive: one `pi --mode rpc` process per concurrency
 * slot, restarted with exponential backoff when it exits. Registration and
 * Order handling happen inside pi via the cafe extension; the supervisor only
 * owns process lifetime. The list is persisted so Baristas come back with the Daemon.
 */
export class Supervisor {
  private workers: Worker[] = [];
  private readonly file: string;
  private readonly logDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly piBin: string;
  private readonly extension: string;

  constructor(opts: { home: string; daemonAddr: string; token: string; piBin?: string; extension?: string }) {
    this.file = join(opts.home, "baristas.json");
    this.logDir = join(opts.home, "logs");
    this.piBin = opts.piBin ?? process.env.CAFE_PI_BIN ?? "pi";
    this.extension = opts.extension ?? defaultExtensionPath();
    this.env = { ...process.env, CAFE_DAEMON: opts.daemonAddr, CAFE_TOKEN: opts.token, CAFE_HEADLESS: "1" };
  }

  /** Restore persisted Baristas. */
  restore(): void {
    if (!existsSync(this.file)) return;
    try {
      for (const spec of JSON.parse(readFileSync(this.file, "utf8")) as BaristaSpec[]) this.start(spec, false);
    } catch {
      // corrupt file: ignore
    }
  }

  start(spec: BaristaSpec, persist = true): WorkerInfo[] {
    const dir = resolve(spec.dir);
    if (this.workers.some((w) => w.spec.dir === dir)) throw new Error(`barista already running in ${dir}`);
    const { cafe } = loadIdentity(dir);
    const n = cafe.concurrency;
    for (let slot = 1; slot <= n; slot++) {
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
      startedAt: w.startedAt,
      running: !!w.child && w.child.exitCode === null,
    }));
  }

  shutdown(): void {
    for (const w of this.workers) this.kill(w);
  }

  private launch(w: Worker): void {
    mkdirSync(this.logDir, { recursive: true });
    const name = w.spec.dir.split(/[\\/]/).filter(Boolean).pop() ?? "barista";
    const log = createWriteStream(join(this.logDir, `barista-${name}-${w.slot}.log`), { flags: "a" });
    const args = ["--mode", "rpc", "--no-session", "-e", this.extension, ...(w.spec.args ?? [])];
    const child = spawn(this.piBin, args, { cwd: w.spec.dir, env: this.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    w.child = child;
    w.startedAt = Date.now();
    // Must listen for 'error' or a failed spawn crashes the daemon.
    child.on("error", (err) => log.write(`[cafe] spawn error: ${err.message}\n`));
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.on("exit", (code, signal) => {
      log.write(`[cafe] exited code=${code} signal=${signal}\n`);
      log.end();
      if (w.child === child) w.child = undefined;
      if (w.stopping) return;
      // Reset backoff after a healthy minute.
      if (w.startedAt && Date.now() - w.startedAt > 60_000) w.restarts = 0;
      const delay = Math.min(60_000, 1000 * 2 ** w.restarts++);
      w.timer = setTimeout(() => !w.stopping && this.launch(w), delay);
    });
  }

  private kill(w: Worker): void {
    w.stopping = true;
    clearTimeout(w.timer);
    const child = w.child;
    if (!child?.pid || child.exitCode !== null) return;
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, s); // whole process group
      } catch {
        child.kill(s);
      }
    };
    signal("SIGTERM");
    const t = setTimeout(() => child.exitCode === null && signal("SIGKILL"), 5000);
    t.unref();
  }

  private save(): void {
    const specs = [...new Map(this.workers.map((w) => [w.spec.dir, w.spec])).values()];
    writeFileSync(this.file, JSON.stringify(specs, null, 2));
  }
}
