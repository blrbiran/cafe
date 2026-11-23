import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { cafeHome, loadConfig } from "@cafe/daemon";

/** What `cafe connector` understands in `cafe-connector.json` (or package.json `cafe.connector`). */
export interface ConnectorManifest {
  name: string;
  kind: string;
  version?: string;
  entry: string;
  permissions?: string[];
  configSchema?: Record<string, ConnectorConfigField>;
  health?: { type?: string; heartbeatMs?: number };
}

export interface ConnectorConfigField {
  type?: string;
  items?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;
}

export type ConnectorRunStatus = "running" | "stopped" | "crashed";

export interface ConnectorRunState {
  pid?: number;
  /** Pid of the supervised connector process (when a supervisor is running). */
  childPid?: number;
  status: ConnectorRunStatus;
  startedAt?: number;
  stoppedAt?: number;
  restarts: number;
  lastError?: string;
}

export interface ConnectorStatus {
  name: string;
  status: ConnectorRunStatus;
  pid?: number;
  recordedPid?: number;
  restarts: number;
  lastHeartbeatAt?: number;
  lastError?: string;
  startedAt?: number;
  stoppedAt?: number;
  version?: string;
  dir: string;
  config: string;
  state: string;
  log: string;
  installedByCafe: boolean;
}

const MARKER = ".cafe-installed.json";
const LOG_TAIL_BYTES = 128 * 1024;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A positive integer from the environment, for the restart knobs (tests use small values). */
function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Config may hold secrets; always write it owner-only and atomically. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function connectorRoot(home: string): string {
  return join(home, "connectors");
}

export function installedDir(home: string, name: string): string {
  return join(connectorRoot(home), name);
}

/** Config + connector state, kept outside the code directory so reinstall preserves it. */
export function dataDir(home: string, name: string): string {
  return join(home, "connector-data", name);
}

export function connectorConfigPath(home: string, name: string): string {
  return join(dataDir(home, name), "config.json");
}

export function connectorStateDir(home: string, name: string): string {
  return join(dataDir(home, name), "state");
}

export function connectorRunPath(home: string, name: string): string {
  return join(dataDir(home, name), "run.json");
}

export function connectorLogPath(home: string, name: string): string {
  return join(home, "logs", `connector-${name}.log`);
}

function rawManifest(dir: string): unknown {
  const file = join(dir, "cafe-connector.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const pkgFile = join(dir, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = readJson<Record<string, any>>(pkgFile, {});
    const nested = pkg?.cafe?.connector;
    if (nested) return nested;
  }
  throw new Error(`no cafe-connector.json (or package.json#cafe.connector) in ${dir}`);
}

/** Read and validate a manifest; the entry path may not escape the connector directory. */
export function readManifest(dir: string): ConnectorManifest {
  const root = resolve(dir);
  const raw = rawManifest(root) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error(`invalid connector manifest in ${dir}`);

  const name = raw.name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`invalid connector name ${JSON.stringify(name)}; use [a-zA-Z0-9_.-]`);
  if (raw.kind !== "customer-connector") throw new Error(`connector '${name}': kind must be "customer-connector"`);

  const entry = raw.entry;
  if (typeof entry !== "string" || !entry) throw new Error(`connector '${name}': entry is required`);
  if (isAbsolute(entry)) throw new Error(`connector '${name}': entry must be relative`);
  const entryPath = resolve(root, entry);
  if (entryPath !== root && !entryPath.startsWith(`${root}${sep}`)) throw new Error(`connector '${name}': entry escapes the connector directory`);

  let configSchema: Record<string, ConnectorConfigField> | undefined;
  if (raw.configSchema !== undefined) {
    if (!raw.configSchema || typeof raw.configSchema !== "object" || Array.isArray(raw.configSchema)) throw new Error(`connector '${name}': configSchema must be an object`);
    configSchema = {};
    for (const [key, spec] of Object.entries(raw.configSchema as Record<string, unknown>)) {
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error(`connector '${name}': configSchema.${key} must be an object`);
      configSchema[key] = spec as ConnectorConfigField;
    }
  }

  let health: ConnectorManifest["health"];
  if (raw.health !== undefined) {
    if (!raw.health || typeof raw.health !== "object") throw new Error(`connector '${name}': health must be an object`);
    const h = raw.health as Record<string, unknown>;
    health = {
      ...(typeof h.type === "string" ? { type: h.type } : {}),
      ...(typeof h.heartbeatMs === "number" && h.heartbeatMs > 0 ? { heartbeatMs: h.heartbeatMs } : {}),
    };
  }

  return {
    name,
    kind: "customer-connector",
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    entry,
    ...(Array.isArray(raw.permissions) ? { permissions: raw.permissions.filter((p): p is string => typeof p === "string") } : {}),
    ...(configSchema ? { configSchema } : {}),
    ...(health ? { health } : {}),
  };
}

function defaultConfig(manifest: ConnectorManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.configSchema ?? {})) {
    if (spec && Object.prototype.hasOwnProperty.call(spec, "default")) out[key] = spec.default;
    else if (spec.type === "array") out[key] = [];
    else if (spec.type === "boolean") out[key] = false;
    else if (spec.type === "number" || spec.type === "integer") out[key] = 0;
    else if (spec.type === "object") out[key] = {};
    else out[key] = "";
  }
  return out;
}

function isCafeInstalled(dir: string): boolean {
  const marker = readJson<Record<string, unknown> | undefined>(join(dir, MARKER), undefined);
  return marker?.marker === "cafe-connector";
}

function writeMarker(dir: string, manifest: ConnectorManifest, source: string): void {
  writeJson(join(dir, MARKER), { marker: "cafe-connector", name: manifest.name, source, installedAt: Date.now() });
}

function ensureConfig(home: string, manifest: ConnectorManifest): Record<string, unknown> {
  const path = connectorConfigPath(home, manifest.name);
  if (!existsSync(path)) writeJson(path, defaultConfig(manifest));
  return readJson<Record<string, unknown>>(path, {});
}

/** Walk up from a resolved package entry to the directory whose package.json has this name. */
function packageRoot(name: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // Published package: the SDK is packed as connector/ next to dist/, not resolved as a dependency.
  if (name === "@cafe/connector") {
    const bundled = resolve(here, "..", "connector");
    if (existsSync(join(bundled, "package.json"))) {
      const pkg = readJson<{ name?: string }>(join(bundled, "package.json"), {});
      if (pkg.name === name) return bundled;
    }
  }
  let url: string;
  try {
    url = import.meta.resolve(name);
  } catch {
    return undefined;
  }
  let dir = dirname(fileURLToPath(url));
  for (let i = 0; i < 12; i++) {
    const pkgFile = join(dir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = readJson<{ name?: string }>(pkgFile, {});
      if (pkg.name === name) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Let a connector installed outside the repo still `import "@cafe/connector"`:
 * link the workspace packages into its own node_modules (Node resolves later
 * imports from the real package path, so their dependencies still work).
 */
function linkSdkPackages(dir: string): void {
  const nm = join(dir, "node_modules", "@cafe");
  for (const name of ["@cafe/connector", "@cafe/protocol"]) {
    const root = packageRoot(name);
    if (!root) continue;
    mkdirSync(nm, { recursive: true });
    const link = join(nm, name.slice(name.indexOf("/") + 1));
    if (existsSync(link)) continue;
    try {
      symlinkSync(root, link, "dir");
    } catch {
      // A connector may ship its own node_modules; leave it alone.
    }
  }
}

export interface InstallResult {
  name: string;
  dir: string;
  config: string;
  state: string;
  version?: string;
  manifest: ConnectorManifest;
  runtime?: string;
}

/** Install discord.js next to an installed Discord connector (not a cafe dependency). Best effort: prints a hint on failure. */
function ensureDiscordRuntime(dir: string, name: string): { installed: boolean; detail: string } {
  if (name !== "discord") return { installed: false, detail: "" };
  const nm = join(dir, "node_modules", "discord.js");
  if (existsSync(nm)) return { installed: true, detail: "discord.js already installed" };
  if (process.env.CAFE_CONNECTOR_SKIP_RUNTIME === "1") return { installed: false, detail: "skipped installing discord.js (CAFE_CONNECTOR_SKIP_RUNTIME=1)" };
  // A published connector gets discord.js; a source checkout may already resolve it from the repo root.
  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", "discord.js"], { cwd: dir, stdio: "pipe", timeout: 120_000 });
    return { installed: existsSync(nm), detail: existsSync(nm) ? "installed discord.js" : "discord.js install returned without node_modules" };
  } catch (err) {
    return { installed: false, detail: `could not install discord.js (${(err as Error).message.split("\n")[0]}); run: cd ${dir} && npm install discord.js` };
  }
}

/** Copy a connector into CAFE_HOME/connectors/<name>, validate it and create its default config. */
export function installConnector(home: string, source: string, opts: { force?: boolean } = {}): InstallResult {
  const src = resolve(source);
  if (!existsSync(src)) throw new Error(`connector source not found: ${src}`);
  const manifest = readManifest(src);
  if (!existsSync(resolve(src, manifest.entry))) throw new Error(`connector '${manifest.name}': entry ${manifest.entry} does not exist`);

  const dest = installedDir(home, manifest.name);
  if (existsSync(dest)) {
    if (!opts.force) throw new Error(`${dest} already exists; use --force to reinstall`);
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(connectorRoot(home), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  if (!existsSync(join(dest, manifest.entry))) throw new Error(`connector '${manifest.name}': copied entry ${manifest.entry} is missing`);
  linkSdkPackages(dest);
  writeMarker(dest, manifest, src);
  const config = ensureConfig(home, manifest);
  mkdirSync(connectorStateDir(home, manifest.name), { recursive: true });
  const runtime = ensureDiscordRuntime(dest, manifest.name);

  return {
    name: manifest.name,
    dir: dest,
    config: connectorConfigPath(home, manifest.name),
    state: connectorStateDir(home, manifest.name),
    ...(manifest.version ? { version: manifest.version } : {}),
    manifest,
    ...(runtime.detail ? { runtime: runtime.detail } : {}),
  };
}

function readRun(home: string, name: string): ConnectorRunState {
  return readJson<ConnectorRunState>(connectorRunPath(home, name), { status: "stopped", restarts: 0 });
}

function writeRun(home: string, name: string, state: ConnectorRunState): void {
  writeJson(connectorRunPath(home, name), state);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLogText(path: string, maxBytes = LOG_TAIL_BYTES): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function protocolLines(path: string): Array<Record<string, any>> {
  return readLogText(path, 64 * 1024)
    .split("\n")
    .flatMap((line) => {
      const text = line.trim();
      if (!text.startsWith("{")) return [];
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? [parsed as Record<string, any>] : [];
      } catch {
        return [];
      }
    });
}

export function statusConnector(home: string, name: string): ConnectorStatus {
  const dir = installedDir(home, name);
  const run = readRun(home, name);
  const manifest = existsSync(dir)
    ? (() => {
        try {
          return readManifest(dir);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const alive = run.pid !== undefined && processAlive(run.pid);
  const status: ConnectorRunStatus = alive ? "running" : run.status === "running" || run.status === "crashed" ? "crashed" : "stopped";
  const events = protocolLines(connectorLogPath(home, name));
  const heartbeat = [...events].reverse().find((e) => e.type === "heartbeat");
  const error = [...events].reverse().find((e) => e.type === "error");
  const lastError = error?.message ?? run.lastError ?? (status === "crashed" ? "process exited without a clean stop" : undefined);
  return {
    name,
    status,
    ...(alive && run.pid !== undefined ? { pid: run.pid } : {}),
    ...(run.pid !== undefined ? { recordedPid: run.pid } : {}),
    restarts: run.restarts ?? 0,
    ...(typeof heartbeat?.at === "number" ? { lastHeartbeatAt: heartbeat.at } : {}),
    ...(lastError ? { lastError } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.stoppedAt ? { stoppedAt: run.stoppedAt } : {}),
    ...(manifest?.version ? { version: manifest.version } : {}),
    dir,
    config: connectorConfigPath(home, name),
    state: connectorStateDir(home, name),
    log: connectorLogPath(home, name),
    installedByCafe: isCafeInstalled(dir),
  };
}

export interface ConnectorListRow {
  name: string;
  status: ConnectorRunStatus;
  pid?: number;
  version?: string;
  dir: string;
  installedByCafe: boolean;
}

export function listConnectors(home: string): ConnectorListRow[] {
  const root = connectorRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name);
      let version: string | undefined;
      try {
        version = readManifest(dir).version;
      } catch {
        version = undefined;
      }
      const s = statusConnector(home, entry.name);
      return { name: entry.name, status: s.status, ...(s.pid ? { pid: s.pid } : {}), ...(version ? { version } : {}), dir, installedByCafe: s.installedByCafe };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface StartOptions {
  /** host:port injected as CAFE_DAEMON (default: env, then this CAFE_HOME's config). */
  daemon?: string;
  token?: string;
  /** How long to wait for an immediate crash before reporting success. */
  waitMs?: number;
  /** The command that runs `cafe connector supervise <name>` (defaults to this CLI). */
  supervisorArgv?: string[];
}

export interface StartResult {
  name: string;
  pid: number;
  dir: string;
  log: string;
  alreadyRunning: boolean;
}

/** The environment a connector (and its supervisor) runs with. */
function connectorEnv(home: string, name: string, manifest: ConnectorManifest, opts: StartOptions): NodeJS.ProcessEnv {
  const configPath = connectorConfigPath(home, name);
  const statePath = connectorStateDir(home, name);
  const local = loadConfig(home);
  const daemon = opts.daemon || process.env.CAFE_DAEMON || `127.0.0.1:${local.port}`;
  const token = opts.token || process.env.CAFE_TOKEN || local.token;
  return {
    ...process.env,
    CAFE_DAEMON: daemon.replace(/^https?:\/\//, ""),
    CAFE_TOKEN: token,
    CAFE_CONNECTOR_NAME: name,
    CAFE_CONNECTOR_CONFIG: configPath,
    CAFE_CONNECTOR_STATE: statePath,
    ...(manifest.health?.heartbeatMs ? { CAFE_CONNECTOR_HEARTBEAT_MS: String(manifest.health.heartbeatMs) } : {}),
  };
}

export interface SuperviseOptions extends StartOptions {
  /** Restarts allowed inside `windowMs` before giving up (crash loop). */
  maxRestarts?: number;
  windowMs?: number;
  /** First backoff delay; doubles per restart up to 30 s. */
  baseDelayMs?: number;
  /** Stop after the child exits (tests). */
  once?: boolean;
}

/**
 * The foreground supervisor behind `cafe connector start`: runs the connector, restarts it when it exits
 * unexpectedly, and gives up (status `crashed`) after a crash loop. Started detached by `startConnector`;
 * `run.json` carries this process's pid (`pid`) and the connector's (`childPid`).
 */
export async function superviseConnector(home: string, name: string, opts: SuperviseOptions = {}): Promise<void> {
  const dir = installedDir(home, name);
  if (!existsSync(dir)) throw new Error(`connector '${name}' is not installed; cafe connector install <path>`);
  const manifest = readManifest(dir);
  const entry = resolve(dir, manifest.entry);
  if (!existsSync(entry)) throw new Error(`connector '${name}': entry ${manifest.entry} does not exist`);
  ensureConfig(home, manifest);
  mkdirSync(connectorStateDir(home, name), { recursive: true });
  const logPath = connectorLogPath(home, name);
  mkdirSync(dirname(logPath), { recursive: true });
  const env = connectorEnv(home, name, manifest, opts);

  const maxRestarts = opts.maxRestarts ?? numEnv("CAFE_CONNECTOR_MAX_RESTARTS", 5);
  const windowMs = opts.windowMs ?? numEnv("CAFE_CONNECTOR_WINDOW_MS", 60_000);
  const baseDelayMs = opts.baseDelayMs ?? numEnv("CAFE_CONNECTOR_BACKOFF_MS", 500);
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  let recent: number[] = [];

  const writeRunState = (patch: Partial<ConnectorRunState>) => {
    const prev = readJson<ConnectorRunState>(connectorRunPath(home, name), { status: "stopped", restarts: 0 });
    writeJson(connectorRunPath(home, name), { ...prev, ...patch });
  };

  const stopChild = async () => {
    const c = child;
    if (!c?.pid || c.exitCode !== null) return;
    try {
      c.kill("SIGTERM");
    } catch {
      // gone
    }
    for (let i = 0; i < 60 && c.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    if (c.exitCode === null) {
      try {
        c.kill("SIGKILL");
      } catch {
        // gone
      }
    }
  };

  const onSignal = () => {
    stopping = true;
    void stopChild().then(() => {
      writeRunState({ status: "stopped", pid: undefined, childPid: undefined, stoppedAt: Date.now() });
      process.exit(0);
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  writeRunState({ status: "running", pid: process.pid, startedAt: Date.now() });

  for (;;) {
    const fd = openSync(logPath, "a");
    try {
      child = spawn(process.execPath, ["--no-warnings", entry], { cwd: dir, stdio: ["ignore", fd, fd], env });
    } finally {
      closeSync(fd);
    }
    const current = child;
    writeRunState({ childPid: current.pid, status: "running" });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((r) => {
      current.once("exit", (code, signal) => r({ code, signal }));
      current.once("error", (err) => r({ code: 127, signal: err.message }));
    });
    if (stopping) return;
    if (opts.once) {
      writeRunState({ status: exit.code === 0 ? "stopped" : "crashed", pid: undefined, childPid: undefined, stoppedAt: Date.now(), ...(exit.code ? { lastError: `exited ${exit.code}` } : {}) });
      return;
    }

    const now = Date.now();
    recent = recent.filter((t) => now - t < windowMs);
    recent.push(now);
    if (recent.length > maxRestarts) {
      const lastError = `crash loop: ${recent.length} exits within ${Math.round(windowMs / 1000)}s (last: ${exit.code ?? exit.signal ?? "unknown"}); not restarting. See ${logPath}`;
      writeRunState({ status: "crashed", pid: undefined, childPid: undefined, stoppedAt: now, lastError });
      process.stderr.write(`[cafe connector ${name}] ${lastError}\n`);
      process.exitCode = 1;
      return;
    }
    const delay = Math.min(30_000, baseDelayMs * 2 ** (recent.length - 1));
    const restarts = (readJson<ConnectorRunState>(connectorRunPath(home, name), { status: "stopped", restarts: 0 }).restarts ?? 0) + 1;
    writeRunState({ status: "crashed", restarts, lastError: `exited ${exit.code ?? exit.signal ?? "unknown"}; restarting in ${delay}ms` });
    await new Promise((r) => setTimeout(r, delay));
    if (stopping) return;
  }
}

/** Detached supervisor that auto-restarts the connector (`cafe connector supervise <name>`). */
export async function startConnector(home: string, name: string, opts: StartOptions = {}): Promise<StartResult> {
  const dir = installedDir(home, name);
  if (!existsSync(dir)) throw new Error(`connector '${name}' is not installed; cafe connector install <path>`);
  const manifest = readManifest(dir);
  if (manifest.name !== name) throw new Error(`connector directory '${name}' declares name '${manifest.name}'`);
  const entry = resolve(dir, manifest.entry);
  if (!existsSync(entry)) throw new Error(`connector '${name}': entry ${manifest.entry} does not exist`);

  const previous = readRun(home, name);
  if (previous.pid !== undefined && processAlive(previous.pid)) {
    return { name, pid: previous.pid, dir, log: connectorLogPath(home, name), alreadyRunning: true };
  }

  ensureConfig(home, manifest);
  mkdirSync(connectorStateDir(home, name), { recursive: true });
  const logPath = connectorLogPath(home, name);
  mkdirSync(dirname(logPath), { recursive: true });
  const env = connectorEnv(home, name, manifest, opts);

  // Run the connector under a supervisor so an unexpected exit restarts it instead of leaving it dead (#28).
  const cliJs = process.argv[1] || resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cafe.js");
  const supervisor = opts.supervisorArgv ?? [process.execPath, cliJs, "connector", "supervise", name];
  const fd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(supervisor[0]!, supervisor.slice(1), { cwd: dir, detached: true, stdio: ["ignore", fd, fd], env });
  } finally {
    closeSync(fd);
  }
  if (!child.pid) throw new Error(`could not start connector '${name}'`);
  child.unref();

  const restarts = previous.startedAt ? (previous.restarts ?? 0) + 1 : (previous.restarts ?? 0);
  writeRun(home, name, { pid: child.pid, status: "running", startedAt: Date.now(), restarts });

  await new Promise((r) => setTimeout(r, opts.waitMs ?? 150));
  if (!processAlive(child.pid)) {
    const why = readRun(home, name).lastError;
    writeRun(home, name, { pid: undefined, status: "crashed", startedAt: Date.now(), lastError: why ?? "process exited immediately", restarts });
    throw new Error(`connector '${name}' exited immediately${why ? `: ${why}` : ""}; see ${logPath}`);
  }
  return { name, pid: child.pid, dir, log: logPath, alreadyRunning: false };
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !processAlive(pid);
}

export interface StopResult {
  stopped: boolean;
  killed: boolean;
  pid?: number;
}

/** SIGTERM, wait, then SIGKILL if the connector ignores it. `pid` is the supervisor: signal its whole group. */
export async function stopConnector(home: string, name: string, opts: { timeoutMs?: number } = {}): Promise<StopResult> {
  const run = readRun(home, name);
  if (run.pid === undefined || !processAlive(run.pid)) {
    writeRun(home, name, { ...run, status: "stopped", pid: undefined, childPid: undefined, stoppedAt: Date.now() });
    return { stopped: false, killed: false, ...(run.pid !== undefined ? { pid: run.pid } : {}) };
  }
  const pid = run.pid;
  // The supervisor is a process-group leader (started detached), so -pid reaches it and the connector child;
  // it then records `stopped` and exits instead of treating the exit as a crash to restart.
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    }
  };
  signalGroup("SIGTERM");
  let exited = await waitExit(pid, opts.timeoutMs ?? 5_000);
  let killed = false;
  if (!exited) {
    killed = true;
    signalGroup("SIGKILL");
    exited = await waitExit(pid, 1_000);
  }
  writeRun(home, name, { ...run, status: exited ? "stopped" : "crashed", pid: undefined, childPid: undefined, stoppedAt: Date.now() });
  return { stopped: true, killed, pid };
}

export async function restartConnector(home: string, name: string, opts: StartOptions = {}): Promise<StartResult> {
  await stopConnector(home, name);
  return startConnector(home, name, opts);
}

export function logsConnector(home: string, name: string): string {
  return readLogText(connectorLogPath(home, name));
}

/** `logs --follow`: print appended bytes until Ctrl-C. */
export async function followConnectorLogs(home: string, name: string): Promise<void> {
  const path = connectorLogPath(home, name);
  let offset = existsSync(path) ? statSync(path).size : 0;
  await new Promise<void>((resolveP) => {
    const timer = setInterval(() => {
      try {
        if (!existsSync(path)) return;
        const size = statSync(path).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const fd = openSync(path, "r");
        try {
          const len = size - offset;
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, offset);
          process.stdout.write(buf);
          offset = size;
        } finally {
          closeSync(fd);
        }
      } catch {
        // The log may rotate or be removed; keep following the same path.
      }
    }, 250);
    timer.unref?.();
    const done = () => {
      clearInterval(timer);
      resolveP();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

export interface ConnectorConfigView {
  path: string;
  config: Record<string, unknown>;
  shown: Record<string, unknown>;
  manifest: ConnectorManifest;
}

function redact(manifest: ConnectorManifest, config: Record<string, unknown>, reveal: boolean): Record<string, unknown> {
  if (reveal) return { ...config };
  const shown = { ...config };
  for (const [key, spec] of Object.entries(manifest.configSchema ?? {})) {
    if (spec.secret && key in shown) shown[key] = "<redacted>";
  }
  return shown;
}

export function readConnectorConfig(home: string, name: string, opts: { reveal?: boolean } = {}): ConnectorConfigView {
  const dir = installedDir(home, name);
  if (!existsSync(dir)) throw new Error(`connector '${name}' is not installed`);
  const manifest = readManifest(dir);
  const config = ensureConfig(home, manifest);
  return { path: connectorConfigPath(home, name), config, shown: redact(manifest, config, !!opts.reveal), manifest };
}

function parseValue(value: string): unknown {
  const text = value.trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/** CLI values are strings; coerce them to the manifest's declared type. */
function coerceValue(field: ConnectorConfigField | undefined, value: string): unknown {
  if (!field) return parseValue(value);
  const text = value.trim();
  if (field.type === "array") {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: accept "c1,c2" as a convenience.
    }
    return text ? text.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  if (field.type === "number" || field.type === "integer") {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`'${value}' is not a number`);
    return field.type === "integer" ? Math.trunc(n) : n;
  }
  if (field.type === "boolean") return text === "true" || text === "1";
  if (field.type === "object") {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`'${value}' is not a JSON object`);
    }
  }
  return parseValue(value);
}

export function setConnectorConfig(home: string, name: string, key: string, value: string): ConnectorConfigView {
  const current = readConnectorConfig(home, name, { reveal: true });
  if (current.manifest.configSchema && !(key in current.manifest.configSchema)) {
    throw new Error(`unknown config key '${key}'; known: ${Object.keys(current.manifest.configSchema).join(", ") || "(none)"}`);
  }
  const next = { ...current.config, [key]: coerceValue(current.manifest.configSchema?.[key], value) };
  writeJson(current.path, next);
  return { ...current, config: next, shown: redact(current.manifest, next, false) };
}

export interface RemoveResult {
  removed: boolean;
  forced: boolean;
  stopped: boolean;
  dir: string;
}

/**
 * Remove only a directory cafe installed (marker + manifest); anything else needs --force.
 * The code directory and cafe-owned config/state go; logs are left for inspection.
 */
export async function removeConnector(home: string, name: string, opts: { force?: boolean } = {}): Promise<RemoveResult> {
  const dir = installedDir(home, name);
  const data = dataDir(home, name);
  const hasDir = existsSync(dir);
  const hasData = existsSync(data);
  if (!hasDir && !hasData) return { removed: false, forced: false, stopped: false, dir };

  const ours = (hasDir && isCafeInstalled(dir)) || (!hasDir && hasData);
  if (!ours && !opts.force) throw new Error(`${dir} was not installed by cafe; use --force to remove it`);
  const stopped = (await stopConnector(home, name)).stopped;
  if (hasDir) rmSync(dir, { recursive: true, force: true });
  if (hasData) rmSync(data, { recursive: true, force: true });
  return { removed: true, forced: !ours, stopped, dir };
}

// ---------------------------------------------------------------------------
// `cafe connector ...`
// ---------------------------------------------------------------------------

type OutFn = (human: string, data: unknown) => void;

export function addConnectorCommands(program: Command, out: OutFn, base: () => string): void {
  const connector = program.command("connector").description("out-of-process Customer connectors (v4-3; Discord first)");

  connector
    .command("install")
    .argument("<path>", "connector directory (cafe-connector.json, or package.json#cafe.connector)")
    .description("copy a connector into CAFE_HOME/connectors/<name>, validate its manifest and create config")
    .option("--force", "reinstall over an existing copy")
    .action((path: string, o) => {
      const r = installConnector(cafeHome(), path, { force: !!o.force });
      out(
        [
          `installed ${r.name}${r.version ? ` ${r.version}` : ""} in ${r.dir}`,
          ...(r.runtime ? [`runtime: ${r.runtime}`] : []),
          `config: ${r.config}`,
          `state:  ${r.state}`,
          ...(r.name === "discord" ? ["next:   cafe connector config discord token <bot token>   (needs the Message Content intent)"] : []),
          `next:   cafe connector config ${r.name} <key> <value>`,
          `        cafe connector start ${r.name}`,
        ].join("\n"),
        r,
      );
    });

  connector
    .command("list")
    .description("installed connectors and whether their process is running")
    .action(() => {
      const rows = listConnectors(cafeHome());
      const lines = rows.map((r) => `${r.status.padEnd(8)} ${r.name.padEnd(20)} ${(r.version ?? "-").padEnd(8)} ${r.dir}`);
      out(lines.join("\n") || "(no connectors installed; run cafe connector install <path>)", rows);
    });

  connector
    .command("status")
    .argument("<name>")
    .description("running / stopped / crashed, pid, last heartbeat, last error and restart count")
    .action((name: string) => {
      const s = statusConnector(cafeHome(), name);
      const lines = [
        `name:      ${s.name}`,
        `status:    ${s.status}`,
        `pid:       ${s.pid ?? "-"}`,
        `version:   ${s.version ?? "-"}`,
        `restarts:  ${s.restarts}`,
        `heartbeat: ${s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt).toLocaleString() : "(none)"}`,
        ...(s.lastError ? [`error:     ${s.lastError}`] : []),
        `installed: ${s.dir}${s.installedByCafe ? "" : " (not installed by cafe)"}`,
        `config:    ${s.config}`,
        `state:     ${s.state}`,
        `log:       ${s.log}`,
      ];
      out(lines.join("\n"), s);
    });

  connector
    .command("start")
    .argument("<name>")
    .description("start the connector detached; logs go to CAFE_HOME/logs/connector-<name>.log")
    .action(async (name: string) => {
      const r = await startConnector(cafeHome(), name, { daemon: base().replace(/^https?:\/\//, "") });
      out(r.alreadyRunning ? `${r.name} is already running (pid ${r.pid})` : `started ${r.name} (pid ${r.pid}, running)\nlog: ${r.log}`, r);
    });

  connector
    .command("stop")
    .argument("<name>")
    .description("SIGTERM the connector and wait for it to exit")
    .action(async (name: string) => {
      const r = await stopConnector(cafeHome(), name);
      out(r.stopped ? `stopped ${name} (pid ${r.pid}${r.killed ? ", SIGKILL after SIGTERM timeout" : ""})` : `${name} is not running`, r);
    });

  connector
    .command("restart")
    .argument("<name>")
    .description("stop and start the connector")
    .action(async (name: string) => {
      const r = await restartConnector(cafeHome(), name, { daemon: base().replace(/^https?:\/\//, "") });
      out(`restarted ${name} (pid ${r.pid})\nlog: ${r.log}`, r);
    });

  connector
    .command("logs")
    .argument("<name>")
    .description("print the connector log, or follow it")
    .option("--follow", "keep printing appended log lines")
    .action(async (name: string, o) => {
      const text = logsConnector(cafeHome(), name);
      out(text.trimEnd() || `(no log yet: ${connectorLogPath(cafeHome(), name)})`, { name, log: connectorLogPath(cafeHome(), name), text });
      if (o.follow) await followConnectorLogs(cafeHome(), name);
    });

  connector
    .command("config")
    .argument("<name>")
    .argument("[key]")
    .argument("[value]")
    .description("show or set a connector config value (secrets are redacted unless --reveal)")
    .option("--reveal", "show secret values")
    .action((name: string, key: string | undefined, value: string | undefined, o) => {
      const home = cafeHome();
      if (!key) {
        const view = readConnectorConfig(home, name, { reveal: !!o.reveal });
        out(JSON.stringify(view.shown, null, 2), view.shown);
        return;
      }
      if (value === undefined) {
        const view = readConnectorConfig(home, name, { reveal: !!o.reveal });
        const v = view.shown[key];
        out(v === undefined ? "(not set)" : typeof v === "string" ? v : JSON.stringify(v), v);
        return;
      }
      const view = setConnectorConfig(home, name, key, value);
      const v = view.shown[key];
      const shown = typeof v === "string" ? v : JSON.stringify(v);
      out(`${key} = ${shown}\n(saved; takes effect on the next start: cafe connector restart ${name})`, { ...view.shown, [key]: view.config[key] });
    });

  connector
    .command("supervise", { hidden: true })
    .argument("<name>")
    .description("run a connector in the foreground, restarting it after crashes (used by `cafe connector start`)")
    .action(async (name: string) => {
      await superviseConnector(cafeHome(), name);
    });

  connector
    .command("remove")
    .argument("<name>")
    .description("remove a cafe-installed connector (refuses unknown directories unless --force)")
    .option("--force", "remove even a directory cafe did not install")
    .action(async (name: string, o) => {
      try {
        const r = await removeConnector(cafeHome(), name, { force: !!o.force });
        out(r.removed ? `removed ${name}${r.stopped ? " (stopped the running process)" : ""}` : `${name} is not installed`, r);
      } catch (err) {
        const message = messageOf(err);
        // Route the refusal through the same error shape as other commands.
        throw new Error(`${message} (use cafe connector remove ${name} --force)`);
      }
    });
}