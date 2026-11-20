import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@cafe/protocol/version";

/**
 * Controlled update / rollback (#27, v4-2). The updater runs in the CLI, not in
 * the daemon: it stages a release under `CAFE_HOME/releases/<version>`, drains
 * and stops the daemon, atomically switches the `current` symlink, starts the
 * new code and health-checks it. A failed health check switches back to the
 * last-known-good release. Nothing here executes scripts from the package; it
 * only runs its `bin/cafe.js`.
 */

export interface UpdateLogEntry {
  at: number;
  action: "apply" | "rollback";
  ok: boolean;
  from?: string;
  to?: string;
  error?: string;
}

export interface UpdateState {
  current?: string;
  lastGood?: string;
  pending?: string;
  updatedAt: number;
  log: UpdateLogEntry[];
}

export interface HealthResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface ApplyResult {
  ok: boolean;
  from?: string;
  to: string;
  switched: boolean;
  health: HealthResult;
  rolledBack: boolean;
  drained?: { waitedMs: number; openThreads: number; retryable: string[] };
  warning?: string;
}

const releasesDir = (home: string) => join(home, "releases");
const currentLink = (home: string) => join(home, "current");
const stateFile = (home: string) => join(home, "update.json");
const lockFile = (home: string) => join(home, "update.lock");

export function readUpdateState(home: string): UpdateState {
  try {
    const s = JSON.parse(readFileSync(stateFile(home), "utf8")) as UpdateState;
    return { ...s, log: Array.isArray(s.log) ? s.log : [] };
  } catch {
    return { updatedAt: 0, log: [] };
  }
}

function writeUpdateState(home: string, s: UpdateState): void {
  writeFileSync(stateFile(home), `${JSON.stringify({ ...s, log: s.log.slice(-50) }, null, 2)}\n`);
}

function logEntry(state: UpdateState, e: UpdateLogEntry): UpdateLogEntry[] {
  return [...state.log, e].slice(-50);
}

async function health(base: string): Promise<{ version?: string; pid?: number; draining?: boolean } | undefined> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    return (await res.json()) as { version?: string; pid?: number; draining?: boolean };
  } catch {
    return undefined;
  }
}

function runCli(dir: string, args: string[], home: string): string {
  return execFileSync(process.execPath, [join(dir, "bin", "cafe.js"), ...args], {
    env: { ...process.env, CAFE_HOME: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function stopDaemon(base: string): Promise<void> {
  try {
    await fetch(`${base}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
  } catch {
    // already gone
  }
  for (let i = 0; i < 100 && (await health(base)); i++) await new Promise((r) => setTimeout(r, 100));
}

function startDaemon(dir: string, home: string): void {
  const child = spawn(process.execPath, [join(dir, "bin", "cafe.js"), "daemon", "start"], {
    env: { ...process.env, CAFE_HOME: home },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function waitHealthy(base: string, version: string, timeoutMs: number): Promise<HealthResult> {
  const start = Date.now();
  let last = "no health response";
  while (Date.now() - start < timeoutMs) {
    const h = await health(base);
    if (h) {
      if (h.version !== version) last = `health reports ${h.version ?? "unknown"}, expected ${version}`;
      else {
        try {
          const snap = await fetch(`${base}/api/snapshot`, { signal: AbortSignal.timeout(3000) });
          if (snap.ok) return { ok: true, version };
          last = `snapshot returned HTTP ${snap.status}`;
        } catch (err) {
          last = `snapshot failed: ${(err as Error).message}`;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, error: last };
}

/** Atomically point `current` at a release directory. */
export function switchCurrent(home: string, version: string): void {
  const target = join(releasesDir(home), version);
  if (!existsSync(target)) throw new Error(`release ${version} is not staged`);
  const tmp = join(home, `.current-${randomUUID()}`);
  symlinkSync(target, tmp, "dir");
  renameSync(tmp, currentLink(home));
}

export function currentTarget(home: string): string | undefined {
  try {
    return readlinkSync(currentLink(home));
  } catch {
    return undefined;
  }
}

export interface ApplyOptions {
  home: string;
  base: string;
  file: string;
  sha256?: string;
  drainTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export async function applyUpdate(opts: ApplyOptions): Promise<ApplyResult> {
  const { home, base, file, sha256, drainTimeoutMs = 30_000, healthTimeoutMs = 30_000 } = opts;
  mkdirSync(releasesDir(home), { recursive: true });
  let lock: number;
  try {
    lock = openSync(lockFile(home), "wx");
  } catch {
    throw new Error("update_busy: another update is in progress");
  }
  const state = readUpdateState(home);
  try {
    if (!existsSync(file)) throw new Error(`no such release file: ${file}`);
    const pkg = JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" })) as { name?: string; version?: string };
    if (pkg.name !== "@blrbiran/cafe") throw new Error(`bad_package: expected @blrbiran/cafe, got ${pkg.name ?? "(none)"}`);
    const to = pkg.version ?? "";
    if (!/^\d+\.\d+\.\d+/.test(to)) throw new Error(`bad_version: ${to || "(none)"}`);
    let warning: string | undefined;
    if (sha256) {
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (actual !== sha256.toLowerCase()) throw new Error("checksum_mismatch: the release file does not match --sha256");
    } else {
      warning = "no --sha256 given; the release was not checksum-verified";
    }

    const staging = join(releasesDir(home), `.staging-${randomUUID()}`);
    mkdirSync(staging, { recursive: true });
    try {
      execFileSync("tar", ["-xzf", file, "-C", staging, "--strip-components=1"]);
      for (const f of ["bin/cafe.js", "dist/cli.js", "web/index.html"]) {
        if (!existsSync(join(staging, f))) throw new Error(`bad_package: missing ${f}`);
      }
      const stagedVersion = runCli(staging, ["--version"], home);
      const stagedProtocol = Number(runCli(staging, ["--protocol-version"], home));
      if (stagedVersion !== to) throw new Error(`bad_package: package.json says ${to}, CLI says ${stagedVersion}`);
      if (stagedProtocol !== PROTOCOL_VERSION) throw new Error(`protocol_mismatch: the release speaks protocol ${stagedProtocol}, this cafe speaks ${PROTOCOL_VERSION}`);
      const releaseDir = join(releasesDir(home), to);
      rmSync(releaseDir, { recursive: true, force: true });
      renameSync(staging, releaseDir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }

    const before = await health(base);
    const from = before?.version ?? state.current;
    let drained: ApplyResult["drained"];
    if (before) {
      try {
        const res = await fetch(`${base}/api/drain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timeoutMs: drainTimeoutMs }),
          signal: AbortSignal.timeout(drainTimeoutMs + 5000),
        });
        drained = (await res.json()) as ApplyResult["drained"];
      } catch {
        drained = { waitedMs: 0, openThreads: 0, retryable: [] };
      }
      await stopDaemon(base);
    }

    writeUpdateState(home, { ...state, pending: to, updatedAt: Date.now() });
    switchCurrent(home, to);
    startDaemon(join(releasesDir(home), to), home);
    const hr = await waitHealthy(base, to, healthTimeoutMs);
    if (hr.ok) {
      writeUpdateState(home, { current: to, lastGood: to, updatedAt: Date.now(), log: logEntry(state, { at: Date.now(), action: "apply", ok: true, from, to }) });
      return { ok: true, from, to, switched: true, health: hr, rolledBack: false, drained, warning };
    }

    // Health check failed: go back to the previous / last-known-good release.
    const back = state.current ?? state.lastGood;
    if (back && existsSync(join(releasesDir(home), back))) {
      switchCurrent(home, back);
      startDaemon(join(releasesDir(home), back), home);
      const old = await waitHealthy(base, back, healthTimeoutMs);
      writeUpdateState(home, {
        current: back,
        lastGood: state.lastGood ?? back,
        updatedAt: Date.now(),
        log: logEntry(state, { at: Date.now(), action: "apply", ok: false, from, to, error: hr.error }),
      });
      return { ok: false, from, to, switched: true, health: hr, rolledBack: true, drained, warning: old.ok ? warning : `${warning ?? ""} rollback health: ${old.error}`.trim() };
    }
    writeUpdateState(home, { ...state, pending: undefined, updatedAt: Date.now(), log: logEntry(state, { at: Date.now(), action: "apply", ok: false, from, to, error: hr.error }) });
    return { ok: false, from, to, switched: true, health: hr, rolledBack: false, drained, warning };
  } finally {
    closeSync(lock);
    rmSync(lockFile(home), { force: true });
  }
}

export async function rollbackUpdate(opts: { home: string; base: string; healthTimeoutMs?: number }): Promise<ApplyResult> {
  const { home, base, healthTimeoutMs = 30_000 } = opts;
  const state = readUpdateState(home);
  const back = state.lastGood;
  if (!back || !existsSync(join(releasesDir(home), back))) throw new Error("no last-known-good release to roll back to");
  const before = await health(base);
  if (before) await stopDaemon(base);
  switchCurrent(home, back);
  startDaemon(join(releasesDir(home), back), home);
  const hr = await waitHealthy(base, back, healthTimeoutMs);
  writeUpdateState(home, {
    current: back,
    lastGood: back,
    updatedAt: Date.now(),
    log: logEntry(state, { at: Date.now(), action: "rollback", ok: hr.ok, from: before?.version, to: back, error: hr.error }),
  });
  return { ok: hr.ok, from: before?.version, to: back, switched: true, health: hr, rolledBack: true };
}

export async function updateStatus(home: string, base: string) {
  const state = readUpdateState(home);
  const h = await health(base);
  return { ...state, currentTarget: currentTarget(home), running: h ? { version: h.version, pid: h.pid, draining: !!h.draining } : undefined };
}

export async function checkUpdate(base: string) {
  const h = await health(base);
  let latest: string | undefined;
  try {
    latest = execFileSync("npm", ["view", "@blrbiran/cafe", "version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    latest = undefined;
  }
  return { running: h?.version, latest, upToDate: !!latest && h?.version === latest };
}