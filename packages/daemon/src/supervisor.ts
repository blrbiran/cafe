import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadIdentity } from "@cafe/protocol/cafe-file";
import { TeamLaunchSpec, type TeamMember, type TeamSpec } from "@cafe/protocol";
import { canonicalPathOrMissing, effectiveMemberAccess, validateMemberPath } from "./team-paths.ts";
import { openWorkerLog, type CappedLineFile } from "./proc/cappedLog.ts";
import { probeGroup, readProcessStart, signalGroup } from "./proc/processStart.ts";

export interface BaristaSpec {
  /** Directory the headless pi runs in (its `.cafe` decides identity). */
  dir: string;
  /** Extra args for pi. */
  args?: string[];
  /** Agent executable for this Barista (`pi` by default; `omp` for oh-my-pi). */
  bin?: string;
  /** Native Codex / Claude Code Barista: runs `cafe barista run --agent …` instead of pi (v3-1). */
  agent?: "codex" | "claude";
  /** For `agent`: read-only (default) or workspace-write. Never full access. */
  access?: "read-only" | "workspace-write";
  /** For `agent`: model passed to codex / claude. */
  model?: string;
  /** codex only: answer in a running Codex session instead of a headless thread (one worker, whatever the concurrency). */
  tui?: boolean;
  /** With `tui`: the Codex thread to use. */
  thread?: string;
  /** v4-11: this spec starts one worker per roster member; `dir` is the roster directory. */
  team?: { rosterDir: string; spec: TeamSpec };
}

export interface Worker {
  spec: BaristaSpec;
  slot: number;
  /** Roster member this worker runs (team specs only). */
  member?: string;
  /** The member's own working directory (may differ from spec.dir). */
  cwd?: string;
  /** Canonical directory reserved at admission for a managed writer. */
  writeScope?: WriteScope;
  rosterDir?: string;
  child?: ChildProcess;
  /** `ps lstart` of the guard (process-group leader), recorded for reaping after a crash. */
  startedAt?: string;
  restarts: number;
  launchedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingProbe?: Promise<void>;
  stopping: boolean;
  /** Consecutive exits soon after launch; resets after a healthy run. */
  quickFailures: number;
  /** Gave up restarting (#82); `start()` again replaces it. */
  failed: boolean;
  /** A user-facing diagnostic attached to this worker's start result. */
  warning?: string;
  /** The worker's own explanation of its last failure (its last stderr lines). */
  lastError?: string;
  /** Recent output lines, to explain a failure. */
  tail: string[];
  logPath: string;
}

export interface WorkerInfo {
  dir: string;
  /** The member's working directory (team specs); `dir` is the roster directory. */
  cwd?: string;
  member?: string;
  /** Set for supervised team workers. */
  rosterDir?: string;
  /** pi, omp, codex or claude. */
  agent: string;
  slot: number;
  pid?: number;
  restarts: number;
  startedAt?: number;
  running: boolean;
  /** running, waiting (between restarts) or failed (gave up; see lastError). */
  state: "running" | "waiting" | "failed";
  warning?: string;
  /** Why the worker last exited, in its own words (e.g. "cafe: … / next: …"). */
  lastError?: string;
  /** The per-worker log with the full output. */
  log: string;
}

/** One live worker group as persisted in `baristas.runtime.json`. */
interface RuntimeEntry {
  dir: string;
  slot: number;
  /** Guard pid; also the process-group id. */
  pid: number;
  startedAt?: string;
  writeScope?: WriteScope;
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
  /** `bin/cafe.js` that runs `cafe barista run` for Codex / Claude Baristas (default: found next to this package). */
  cliBin?: string;
  /** Lifecycle lines for the daemon log (a worker that keeps failing, or gives up). */
  log?: (msg: string) => void;
  /** Remove a member from routing after its revocation intent is durable and before signaling its group. */
  onTeamMemberStopping?: (rosterDir: string, member: string) => void;
  /** Override the isolated Pi/OMP no-model isolation probe (tests only). */
  probeScript?: string;
  /** Give up after this many consecutive failed starts (default 3). */
  failAfter?: number;
  /** An exit this soon after launch counts as a failed start (default 30s). */
  quickExitMs?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, "proc", "guard.mjs");
/** After a worker's leader exits, give the pipes this long, then SIGKILL the group (grandchildren). */
const EXIT_DRAIN_MS = 1000;
const EXIT_NOT_FOUND = 127;
const PI_READONLY_TOOLS = "read,grep,find,ls,cafe_ask,cafe_agents,cafe_reply,cafe_decline";
const OMP_READONLY_TOOLS = "read,grep,glob,cafe_ask,cafe_agents,cafe_reply,cafe_decline";

export function readonlyToolArgs(agent: "pi" | "omp", cafeExtension: string): string[] {
  const tools = agent === "pi" ? PI_READONLY_TOOLS : OMP_READONLY_TOOLS;
  return ["--tools", tools, ...(agent === "pi" ? ["--no-mcp"] : []), "--no-extensions", "-e", cafeExtension];
}

export interface ProbeResult { supported: boolean; binaryHash: string; reason?: string; fromCache?: boolean; }

function hashFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function isPiRuntime(value: string): boolean { return /^pi[ @]/i.test(value.trim()); }
function isOmpRuntime(value: string): boolean { return /^omp\//i.test(value.trim()); }
type WriteScope = { path: string; ancestors: string[] };
type RosterWriteScope = { rosterDir: string; member: string; scope: WriteScope; tui?: { reservationId: string; stale: boolean } };
interface TeamSyncIntent {
  rosterRootId: string;
  fromPath: string;
  toPath?: string;
  committedHash: string;
  targetHash: string;
  phase: "stopping" | "stop-pending" | "committing" | "relocating";
  affectedGroups: Array<{ member: string; pid: number; startedAt?: string; scope?: WriteScope }>;
  staleTuiReservationIds: string[];
}
interface TeamSyncState {
  rosterRootId: string;
  rosterDir: string;
  committedHash: string;
  spec: TeamSpec;
  members: Record<string, { launchHash: string; wanted: boolean; restartWanted?: boolean }>;
  pendingSpec?: TeamSpec;
  intent?: TeamSyncIntent;
}
interface TeamSyncResult {
  committedHash: string;
  restarted: string[];
  stopped: string[];
  started: string[];
  pending: string[];
}

export interface TeamRelocation {
  id: string;
  rosterRootId: string;
  ownerKey: string;
  fromPath: string;
  toPath: string;
  committedHash: string;
  targetHash: string;
  targetSpec: TeamSpec;
  affectedGroups: Array<{ member: string; pid: number; startedAt?: string }>;
  staleTuiReservationIds: string[];
  phase: "relocating" | "stop-pending" | "committing";
}
interface TeamRelocationState {
  pending?: TeamRelocation;
  relocatedRoots: Record<string, string>;
}

function captureWriteScope(path: string): WriteScope {
  const ancestors: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    const { dev, ino } = statSync(dir, { bigint: true });
    ancestors.push(`${dev}:${ino}`);
    if (dirname(dir) === dir) break;
  }
  return { path, ancestors };
}

function writeScopesOverlap(a: WriteScope, b: WriteScope): boolean {
  const contains = (parent: WriteScope, child: WriteScope) => {
    const path = relative(parent.path, child.path);
    return (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) || child.ancestors.includes(parent.ancestors[0]!);
  };
  return contains(a, b) || contains(b, a);
}

function agentKind(bin: string): "pi" | "omp" | undefined {
  const name = basename(bin).toLowerCase();
  return name === "pi" ? "pi" : name === "omp" ? "omp" : undefined;
}
function compatibleRuntime(binary: string, agent: "pi" | "omp"): boolean {
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (version.error || version.status !== 0) return false;
  const reported = `${version.stdout}${version.stderr}`.trim();
  return agent === "pi" ? isPiRuntime(reported) || (!isOmpRuntime(reported) && /^\d+\.\d+\.\d+$/i.test(reported)) : isOmpRuntime(reported) || (!isPiRuntime(reported) && /^\d+\.\d+\.\d+$/i.test(reported));
}
/**
 * Hold a read-only launch until its exact executable and Cafe-extension hashes have passed an
 * isolated no-model probe. Tests inject probeScript; production uses the sibling helper.
 */
export async function probeReadonlyRuntime(binary: string, agent: "pi" | "omp", cafeExtension: string, opts: { home: string; probeScript?: string; path?: string }): Promise<ProbeResult> {
  const candidates = isAbsolute(binary) ? [binary] : /[\\/]/.test(binary) ? [] : (opts.path ?? process.env.PATH ?? "").split(delimiter)
    .filter(isAbsolute).map((dir) => join(dir, binary));
  let realBinary: string | undefined;
  for (const candidate of candidates) {
    try {
      const actual = realpathSync(candidate);
      if (!statSync(actual).isFile()) continue;
      accessSync(actual, constants.X_OK);
      realBinary = actual;
      break;
    } catch { /* keep looking on PATH */ }
  }
  if (!realBinary) return { supported: false, binaryHash: "", reason: `executable '${binary}' not found. Install ${agent} and add it to the daemon's PATH, or configure an absolute executable path.` };
  let realExtension: string;
  try { realExtension = realpathSync(resolve(cafeExtension)); }
  catch { return { supported: false, binaryHash: hashFile(realBinary), reason: `Cafe extension not found: ${cafeExtension}` }; }
  if (!existsSync(realExtension)) return { supported: false, binaryHash: hashFile(realBinary), reason: `Cafe extension not found: ${cafeExtension}` };
  const binaryHash = hashFile(realBinary);
  if (!opts.probeScript) return { supported: false, binaryHash, reason: `Cafe found ${agent} at ${realBinary} but cannot verify read-only isolation for this runtime. Use a supported read-only runtime or review this worker's access settings.` };
  const extensionHash = hashFile(realExtension);
  const cacheFile = join(opts.home, "runtime-probes.json");
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  const cache: Record<string, ProbeResult> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const key = `${realBinary}:${binaryHash}:${extensionHash}`;
  if (cache[key]?.supported) return { ...cache[key], fromCache: true };
  if (!compatibleRuntime(realBinary, agent)) return { supported: false, binaryHash, reason: "runtime version is not in Cafe's tested read-only table" };
  const flags = readonlyToolArgs(agent, realExtension);
  const result = spawnSync(process.execPath, [opts.probeScript, realBinary, agent, realExtension, ...flags], {
    cwd: tmpdir(), env: { ...process.env, HOME: opts.home, XDG_CONFIG_HOME: join(opts.home, "xdg"), CAFE_DAEMON: "", CAFE_TOKEN: "", PI_OFFLINE: "1" },
    encoding: "utf8", timeout: 5000,
  });
  let outcome: { supported?: boolean; reason?: string };
  try { outcome = JSON.parse(result.stdout.trim().split(/\n/).pop()!); }
  catch { outcome = { supported: false, reason: result.error?.message ?? `probe exited ${result.status}` }; }
  const response = { supported: !!outcome.supported, binaryHash, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  if (response.supported) cache[key] = response; else delete cache[key];
  writeAtomic(cacheFile, JSON.stringify(cache, null, 2));
  return response;
}

export function defaultExtensionPath(): string {
  if (process.env.CAFE_PI_EXTENSION) return process.env.CAFE_PI_EXTENSION;
  // Published package: dist/cli.js sits next to dist/pi-extension.js.
  const bundled = join(here, "pi-extension.js");
  if (existsSync(bundled)) return bundled;
  try {
    return fileURLToPath(import.meta.resolve("@cafe/pi-extension"));
  } catch {
    return resolve(here, "../../pi-extension/src/index.ts");
  }
}

/** The `cafe` entry script: `bin/cafe.js` next to dist/ in the published package, else the workspace CLI package. */
export function defaultCliBin(): string {
  if (process.env.CAFE_CLI_BIN) return process.env.CAFE_CLI_BIN;
  const bundled = resolve(here, "../bin/cafe.js");
  if (existsSync(bundled)) return bundled;
  return resolve(here, "../../cli/bin/cafe.js");
}

/**
 * Keeps headless Baristas alive: one `pi --mode rpc` (or one `cafe barista run --agent codex|claude`) per concurrency slot, restarted with exponential
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
  private readonly rosterWriteFile: string;
  private readonly teamSyncFile: string;
  private readonly relocationFile: string;
  private relocationState: TeamRelocationState;
  private rosterWriteScopes: RosterWriteScope[];
  private readonly logDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly piBin: string;
  private readonly extension: string;
  private readonly graceMs: number;
  private readonly backoffBaseMs: number;
  private readonly cliBin: string;
  private readonly log: (msg: string) => void;
  private readonly failAfter: number;
  private readonly quickExitMs: number;
  private readonly onTeamMemberStopping?: (rosterDir: string, member: string) => void;
  private readonly home: string;
  private readonly probeScript?: string;

  constructor(opts: SupervisorOptions) {
    this.file = join(opts.home, "baristas.json");
    this.runtimeFile = join(opts.home, "baristas.runtime.json");
    this.rosterWriteFile = join(opts.home, "team-write-scopes.json");
    this.teamSyncFile = join(opts.home, "team-sync.json");
    this.relocationFile = join(opts.home, "team-relocations.json");
    this.relocationState = existsSync(this.relocationFile)
      ? JSON.parse(readFileSync(this.relocationFile, "utf8")) as TeamRelocationState
      : { relocatedRoots: {} };
    if (!this.relocationState || typeof this.relocationState.relocatedRoots !== "object" || Array.isArray(this.relocationState.relocatedRoots)) {
      throw new Error(`invalid team relocation state in ${this.relocationFile}`);
    }
    this.rosterWriteScopes = existsSync(this.rosterWriteFile) ? JSON.parse(readFileSync(this.rosterWriteFile, "utf8")) as RosterWriteScope[] : [];
    if (!Array.isArray(this.rosterWriteScopes) || this.rosterWriteScopes.some((entry) =>
      typeof entry?.rosterDir !== "string" || typeof entry.member !== "string" ||
      typeof entry.scope?.path !== "string" || !Array.isArray(entry.scope.ancestors) || entry.scope.ancestors.length === 0)) {
      throw new Error(`invalid committed write scopes in ${this.rosterWriteFile}`);
    }
    this.logDir = join(opts.home, "logs");
    this.piBin = opts.piBin ?? process.env.CAFE_PI_BIN ?? "pi";
    this.extension = opts.extension ?? defaultExtensionPath();
    this.graceMs = opts.graceMs ?? 5000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.cliBin = opts.cliBin ?? defaultCliBin();
    this.log = opts.log ?? (() => {});
    this.failAfter = opts.failAfter ?? 3;
    this.quickExitMs = opts.quickExitMs ?? 30_000;
    this.onTeamMemberStopping = opts.onTeamMemberStopping;
    this.home = opts.home;
    this.probeScript = opts.probeScript;
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
  async restore(validateRoster?: (rosterDir: string, team: TeamSpec) => void): Promise<{ reaped: number; skipped: string[] }> {
    const result = await this.reapStale();
    const states = this.syncStates();
    for (const [dir, state] of Object.entries(states)) {
      if (!state.intent || this.isRelocatedRoot(dir)) continue;
      const remaining = state.intent.affectedGroups.filter((group) => probeGroup(group.pid) !== "gone");
      if (remaining.length) continue;
      const pendingSpec = state.pendingSpec;
      if (pendingSpec || state.intent.phase === "committing") {
        try { validateRoster?.(dir, pendingSpec ?? state.spec); }
        catch (error) {
          result.skipped.push(`${dir}: ${String((error as Error).message)}`);
          continue;
        }
      }
      if (state.intent.phase === "committing") {
        const target = pendingSpec ?? state.spec;
        try {
          this.commitRosterWriteScopes(dir, target);
          const latest = this.syncStates();
          const current = latest[dir]!;
          const wanted = target.members.filter((member) => current.members[member.name]?.wanted);
          if (wanted.length) this.startTeam(dir, { ...target, members: wanted }, false);
          this.save();
          current.intent = undefined;
          current.pendingSpec = undefined;
          latest[dir] = current;
          this.writeSyncStates(latest);
          states[dir] = current;
        } catch (error) {
          result.skipped.push(`${dir}: commit recovery failed: ${(error as Error).message}`);
          states[dir] = this.syncStates()[dir] ?? state;
        }
      } else if (pendingSpec) {
        const outcome = await this.syncTeam(dir, pendingSpec, () => validateRoster?.(dir, pendingSpec)).catch(() => undefined);
        if (!outcome || outcome.pending.length) result.skipped.push(`${dir}: team reconciliation still stopping`);
        states[dir] = this.syncStates()[dir] ?? state;
      } else {
        for (const group of state.intent.affectedGroups) if (state.members[group.member]) state.members[group.member]!.wanted = false;
        state.intent = undefined;
        state.pendingSpec = undefined;
        states[dir] = state;
        this.writeSyncStates(states);
      }
    }
    this.writeSyncStates(states);
    if (this.relocationState.pending) {
      const pending = this.relocationState.pending;
      const live = pending.affectedGroups.filter((group) => probeGroup(group.pid) !== "gone");
      if (live.length) {
        for (const group of live) result.skipped.push(`${pending.fromPath}#${group.member}: relocation stop pending`);
      } else {
        try {
          this.finishRelocationScopes(pending);
          pending.phase = "committing";
          this.saveRelocationState();
        } catch (error) {
          result.skipped.push(`${pending.fromPath}: relocation recovery failed: ${(error as Error).message}`);
        }
      }
    }
    if (existsSync(this.file)) {
      try {
        const savedStates = this.syncStates();
        const fenced = new Set(Object.values(savedStates).filter((state) => state.intent).map((state) => state.rosterDir));
        for (const spec of JSON.parse(readFileSync(this.file, "utf8")) as BaristaSpec[]) {
          if (spec.team && fenced.has(spec.team.rosterDir)) continue;
          if (spec.team && savedStates[spec.team.rosterDir]) {
            const state = savedStates[spec.team.rosterDir]!;
            try { validateRoster?.(spec.team.rosterDir, state.spec); }
            catch (error) {
              result.skipped.push(`${spec.team.rosterDir}: ${String((error as Error).message)}`);
              continue;
            }
            const wanted = state.spec.members.filter((member) => state.members[member.name]?.wanted);
            if (!wanted.length) continue;
            spec.team.spec = { ...state.spec, members: wanted };
          }
          if (spec.team && this.isRelocatedRoot(resolve(spec.team.rosterDir))) continue;
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

  private readonly retiringWriters = new Map<number, RuntimeEntry & { writeScope: WriteScope }>();

  private retainWriter(w: Worker, pid: number): void {
    if (!w.writeScope || probeGroup(pid) === "gone") return;
    this.retiringWriters.set(pid, { dir: w.spec.dir, slot: w.slot, pid, startedAt: w.startedAt, writeScope: w.writeScope });
  }

  private reservedWriter(scope: WriteScope): WriteScope | undefined {
    for (const [pgid, retiring] of this.retiringWriters) {
      if (probeGroup(pgid) === "gone") this.retiringWriters.delete(pgid);
      else if (writeScopesOverlap(scope, retiring.writeScope)) return retiring.writeScope;
    }
  }

  /** Migrate all saved authoritative local rosters before restoring or admitting workers. */
  bootstrapRosterWriteScopes(rosters: Array<{ directory: string; team: TeamSpec }>): void {
    if (existsSync(this.rosterWriteFile)) return;
    let scopes: RosterWriteScope[] = [];
    for (const { directory, team } of rosters) scopes = this.prepareRosterWriteScopes(directory, team, scopes);
    writeAtomic(this.rosterWriteFile, JSON.stringify(scopes, null, 2), true);
    this.rosterWriteScopes = scopes;
  }

  /** Keep all configured managed write scopes, including members omitted from a partial start. */
  commitRosterWriteScopes(rosterDir: string, team: TeamSpec): void {
    const next = this.prepareRosterWriteScopes(rosterDir, team, this.rosterWriteScopes);
    writeAtomic(this.rosterWriteFile, JSON.stringify(next, null, 2), true);
    this.rosterWriteScopes = next;
  }

  private prepareRosterWriteScopes(rosterDir: string, team: TeamSpec, current: RosterWriteScope[]): RosterWriteScope[] {
    const root = realpathSync(rosterDir);
    const otherRosters = current.filter((entry) => entry.rosterDir !== root || entry.tui?.stale);
    const scopes: RosterWriteScope[] = [];
    const retainedTerminals = new Set<string>();
    const frontDoor = team.members.find((member) => member.duty?.trim().toLowerCase() === "orchestrator")?.name;
    const allowedTuiNesting = (a: RosterWriteScope, b: RosterWriteScope): boolean => {
      if (!a.tui || !b.tui) return false;
      const [front, child] = a.member === frontDoor ? [a, b] : [b, a];
      return front.member === frontDoor && front.scope.path === root &&
        child.scope.ancestors.slice(1).includes(front.scope.ancestors[0]!);
    };
    for (const member of team.members) {
      if (member.mode !== "tui" && effectiveMemberAccess(member) !== "write") continue;
      const scope = captureWriteScope(validateMemberPath(this.home, root, member.name, member.dir).realPath);
      const prior = member.mode === "tui" ? current.find((entry) => entry.rosterDir === root && entry.member === member.name &&
        entry.tui && !entry.tui.stale && entry.scope.path === scope.path && entry.scope.ancestors[0] === scope.ancestors[0])?.tui : undefined;
      const tui = member.mode === "tui" ? prior ?? { reservationId: randomUUID(), stale: false } : undefined;
      const candidate = { rosterDir: root, member: member.name, scope, ...(tui ? { tui } : {}) };
      const conflict = otherRosters.find((entry) => writeScopesOverlap(entry.scope, scope) &&
        !(prior && entry.rosterDir === root && entry.tui?.stale)) ??
        scopes.find((entry) => writeScopesOverlap(entry.scope, scope) && !allowedTuiNesting(entry, candidate));
      if (conflict) throw new Error(`${member.name} would overlap a ${conflict.tui ? "terminal directory" : "write scope"} reserved by ${conflict.member} in ${conflict.scope.path}`);
      const retiring = this.reservedWriter(scope);
      if (retiring) throw new Error(`${member.name} would overlap a write-enabled worker still stopping in ${retiring.path}`);
      const active = this.workers.find((worker) => !(worker.rosterDir === root && worker.member === member.name) &&
        worker.writeScope && writeScopesOverlap(worker.writeScope, scope));
      if (active) throw new Error(`${member.name} would overlap an existing write-enabled worker in ${active.writeScope!.path}`);
      if (prior) retainedTerminals.add(prior.reservationId);
      scopes.push(candidate);
    }
    const stale = current.flatMap((entry) => {
      if (entry.rosterDir !== root || !entry.tui || entry.tui.stale) return [];
      if (scopes.some((scope) => scope.tui?.reservationId === entry.tui!.reservationId)) return [];
      return [{ ...entry, tui: { ...entry.tui, stale: true } }];
    });
    // Removing a terminal preserves its reservation. An unchanged TUI scope can
    // keep an overlap that was already committed, so the removal itself can succeed.
    for (const entry of stale) {
      const conflict = scopes.find((scope) => !(scope.tui && retainedTerminals.has(scope.tui.reservationId)) &&
        writeScopesOverlap(scope.scope, entry.scope));
      if (conflict) throw new Error(`${conflict.member} overlaps a terminal reserved by ${entry.member} in ${entry.scope.path}`);
    }
    return [...otherRosters, ...scopes, ...stale];
  }

  staleTuiReservations(): Array<{ reservationId: string; rosterDir: string; member: string; path: string }> {
    return this.rosterWriteScopes.flatMap(({ rosterDir, member, scope, tui }) =>
      tui?.stale ? [{ reservationId: tui.reservationId, rosterDir, member, path: scope.path }] : []);
  }

  markRosterTuiReservationsStale(rosterDir: string): string[] {
    const root = canonicalPathOrMissing(rosterDir);
    const reservations: string[] = [];
    const next = this.rosterWriteScopes.map((entry) => {
      if (entry.rosterDir !== root || !entry.tui || entry.tui.stale) return entry;
      reservations.push(entry.tui.reservationId);
      return { ...entry, tui: { ...entry.tui, stale: true } };
    });
    if (reservations.length) {
      writeAtomic(this.rosterWriteFile, JSON.stringify(next, null, 2), true);
      this.rosterWriteScopes = next;
    }
    return reservations;
  }

  releaseTuiReservation(reservationId: string): boolean {
    const next = this.rosterWriteScopes.filter((entry) => !(entry.tui?.stale && entry.tui.reservationId === reservationId));
    if (next.length === this.rosterWriteScopes.length) return false;
    writeAtomic(this.rosterWriteFile, JSON.stringify(next, null, 2), true);
    this.rosterWriteScopes = next;
    return true;
  }

  start(spec: BaristaSpec, persist = true): WorkerInfo[] {
    const dir = resolve(spec.dir);
    if (spec.team) return this.startTeam(dir, spec.team.spec, persist);
    const existing = this.workers.filter((w) => w.spec.dir === dir && !w.rosterDir);
    // A Barista that gave up (#82) is replaced by a new start; a live one is not.
    if (existing.length && !existing.every((w) => w.failed)) throw new Error(`barista already running in ${dir}`);
    const writeScope = !spec.tui && spec.access === "workspace-write" ? captureWriteScope(realpathSync(dir)) : undefined;
    const configured = writeScope && this.rosterWriteScopes.find((entry) => writeScopesOverlap(writeScope, entry.scope));
    if (configured) throw new Error(`${dir} overlaps a write scope reserved by ${configured.member} in ${configured.scope.path}`);
    const retiring = writeScope && this.reservedWriter(writeScope);
    if (retiring) throw new Error(`${dir} would overlap a write-enabled worker still stopping in ${retiring.path}`);
    const active = writeScope ? this.workers.find((worker) => !existing.includes(worker) && worker.writeScope && writeScopesOverlap(writeScope, worker.writeScope)) : undefined;
    if (active) throw new Error(`${dir} would overlap an existing write-enabled worker in ${active.writeScope!.path}`);
    const { cafe } = loadIdentity(writeScope?.path ?? dir);
    if (existing.length) this.workers = this.workers.filter((w) => w.spec.dir !== dir || w.rosterDir);
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? "barista";
    // The leaf name alone collided for /a/work and /b/work (#102): keep it for readability and add a
    // short hash of the full path so two workers never interleave in one log.
    const tag = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    const warning = cafe.concurrency > 1
      ? `configured concurrency ${cafe.concurrency}; Cafe sessions are serial, so only one worker is running`
      : undefined;
    if (warning) this.log(warning);
    // One process owns one Cafe identity and one serial session. Distinct workers need distinct identities and directories.
    for (let slot = 1; slot <= 1; slot++) {
      const w: Worker = { spec: { ...spec, dir }, writeScope, slot, ...(warning ? { warning } : {}), restarts: 0, stopping: false, quickFailures: 0, failed: false, tail: [], logPath: join(this.logDir, `barista-${name}-${tag}-${slot}.log`) };
      this.workers.push(w);
      this.launch(w);
    }
    if (persist) this.save();
    return this.list().filter((w) => w.dir === dir && !w.member);
  }

  private syncStates(): Record<string, TeamSyncState> {
    if (!existsSync(this.teamSyncFile)) return {};
    const states = JSON.parse(readFileSync(this.teamSyncFile, "utf8")) as Record<string, TeamSyncState>;
    if (!states || typeof states !== "object" || Array.isArray(states)) throw new Error(`invalid team sync state in ${this.teamSyncFile}`);
    return states;
  }

  private writeSyncStates(states: Record<string, TeamSyncState>): void {
    writeAtomic(this.teamSyncFile, JSON.stringify(states, null, 2), true);
  }

  private launchHash(team: TeamSpec, member: TeamMember, canonicalDir: string): string {
    const identity = statSync(canonicalDir, { bigint: true });
    return createHash("sha256").update(JSON.stringify({
      agent: member.agent ?? team.agent ?? "pi",
      bin: member.bin,
      model: (member as TeamMember & { model?: string }).model,
      mode: member.mode,
      dir: canonicalDir,
      dev: String(identity.dev),
      ino: String(identity.ino),
      access: effectiveMemberAccess(member),
      environment: (member as TeamMember & { environment?: Record<string, string> }).environment,
    })).digest("hex");
  }

  private persistExplicitStarts(rosterDir: string, team: TeamSpec): void {
    const states = this.syncStates();
    const prior = states[rosterDir];
    const merged = new Map((prior?.spec.members ?? []).map((member) => [member.name, member]));
    for (const member of team.members) merged.set(member.name, member);
    const members = { ...(prior?.members ?? {}) };
    for (const member of team.members) {
      let launchHash = this.launchHash(team, member, validateMemberPath(this.home, rosterDir, member.name, member.dir).realPath);
      members[member.name] = { launchHash, wanted: member.mode !== "tui", restartWanted: false };
    }
    const spec = { ...prior?.spec, ...team, members: [...merged.values()] } as TeamSpec;
    const committedHash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    states[rosterDir] = { rosterRootId: prior?.rosterRootId ?? createHash("sha256").update(rosterDir).digest("hex"), rosterDir, committedHash, spec, members };
    this.writeSyncStates(states);
  }

  /**
   * One worker per headless roster member (v4-11). Idempotent per `(rosterDir, member)`: an existing
   * live worker or a worker in restart backoff is left alone, so `team start` can fill gaps.
   * TUI members are never started here (the person owns that terminal).
   */
  startTeam(rosterDir: string, team: TeamSpec, persist = true): WorkerInfo[] {
    team = TeamLaunchSpec.parse(team);
    const dir = realpathSync(resolve(rosterDir));
    if (this.isRelocatedRoot(dir) || this.relocationState.pending?.toPath === dir) {
      throw new Error(`team directory ${dir} is fenced by a roster relocation`);
    }
    const syncState = this.syncStates()[dir];
    if (persist && syncState?.intent) throw new Error(`team ${dir} has a pending reconciliation; retry cafe team sync before starting members`);
    const rosterTag = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    const validatedPaths = new Map(team.members.map((member) => [member.name, validateMemberPath(this.home, dir, member.name, member.dir).realPath]));
    for (const member of team.members) {
      const running = this.workers.find((worker) => worker.rosterDir === dir && worker.member === member.name && !worker.failed);
      if (!running) continue;
      const previousTeam = running.spec.team?.spec;
      const previousMember = previousTeam?.members.find((entry) => entry.name === member.name);
      if (previousTeam && previousMember && this.launchHash(previousTeam, previousMember, running.cwd ?? dir) !== this.launchHash(team, member, validatedPaths.get(member.name)!)) {
        throw new Error(`${member.name}'s launch settings changed while its worker is running; run cafe team sync`);
      }
    }
    const writes = team.members.filter((member) => effectiveMemberAccess(member) === "write");
    const writeScopes = new Map(writes.map((member) => [member.name, captureWriteScope(validatedPaths.get(member.name)!)]));
    for (const [index, member] of writes.entries()) {
      const target = writeScopes.get(member.name)!;
      const committed = this.rosterWriteScopes.find((entry) => entry.rosterDir === dir && entry.member === member.name);
      if (committed && (committed.scope.path !== target.path || committed.scope.ancestors[0] !== target.ancestors[0])) {
        throw new Error(`${member.name}'s write directory changed since the roster was committed. Run cafe team sync.`);
      }
      const reserved = this.rosterWriteScopes.find((entry) => !(entry.rosterDir === dir && entry.member === member.name) && writeScopesOverlap(target, entry.scope));
      if (reserved) throw new Error(`${member.name} would overlap a write scope reserved by ${reserved.member} in ${reserved.scope.path}`);
      const conflict = writes.slice(0, index).find((other) => writeScopesOverlap(target, writeScopes.get(other.name)!));
      if (conflict) throw new Error(`${member.name} and ${conflict.name} would write to overlapping directories`);
      const retiring = this.reservedWriter(target);
      if (retiring) throw new Error(`${member.name} would overlap a write-enabled worker still stopping in ${retiring.path}`);
      const active = this.workers.find((other) => !(other.rosterDir === dir && other.member === member.name) &&
        other.writeScope && writeScopesOverlap(target, other.writeScope));
      if (active) throw new Error(`${member.name} would overlap an existing write-enabled worker in ${active.writeScope!.path}`);
    }
    if (persist) this.persistExplicitStarts(dir, team);
    // Each worker keeps only its own member definition; save() unions them per roster. A partial
    // `team start` must never overwrite the set that a later restart restores (v4-11 review).
    for (const w of this.workers) {
      if (w.rosterDir !== dir) continue;
      const own = team.members.find((m) => m.name === w.member) ?? w.spec.team?.spec.members.find((m) => m.name === w.member);
      w.spec = { ...w.spec, team: { rosterDir: dir, spec: { ...team, members: own ? [own] : [] } } };
    }
    for (const member of team.members) {
      if (member.mode === "tui") continue;
      const already = this.workers.find((w) => w.rosterDir === dir && w.member === member.name && !w.failed);
      if (already) continue;
      this.workers = this.workers.filter((w) => !(w.rosterDir === dir && w.member === member.name));
      const memberDir = validatedPaths.get(member.name)!;
      const runner = member.agent ?? team.agent ?? "pi";
      const native = runner === "codex" || runner === "claude";
      const flavor = member.bin ?? runner;
      const base: BaristaSpec = {
        dir,
        team: { rosterDir: dir, spec: { ...team, members: [member] } },
        ...(native ? { agent: runner } : flavor === "omp" ? { bin: "omp" } : {}),
        access: member.access === "write" ? "workspace-write" : "read-only",
      };
      const w: Worker = {
        spec: base,
        slot: 1,
        member: member.name,
        cwd: memberDir,
        writeScope: writeScopes.get(member.name),
        rosterDir: dir,
        restarts: 0,
        stopping: false,
        quickFailures: 0,
        failed: false,
        tail: [],
        logPath: join(this.logDir, `barista-${member.name}-${createHash("sha256").update(memberDir).digest("hex").slice(0, 8)}-${rosterTag.slice(0, 4)}-1.log`),
      };
      this.workers.push(w);
      this.launch(w);
    }
    if (persist) this.save();
    return this.list().filter((w) => w.rosterDir === dir);
  }

  async syncTeam(rosterDir: string, requested: TeamSpec, validateCommit?: () => void): Promise<TeamSyncResult> {
    const team = TeamLaunchSpec.parse(requested);
    const dir = realpathSync(resolve(rosterDir));
    if (this.isRelocatedRoot(dir) || this.relocationState.pending?.toPath === dir) {
      throw new Error(`team directory ${dir} is fenced by a roster relocation`);
    }
    const states = this.syncStates();
    const prior = states[dir];
    const oldMembers = new Map((prior?.spec.members ?? []).map((member) => [member.name, member]));
    const priorWanted = Object.fromEntries(Object.entries(prior?.members ?? {}).map(([name, value]) => [name, value.wanted || value.restartWanted === true]));
    const desired = new Map(team.members.map((member) => [member.name, member]));
    const revoked = new Set<string>();
    const blocked = new Set<string>();
    if (prior?.intent) {
      const pending: string[] = [];
      await Promise.all(prior.intent.affectedGroups.map(async (group) => {
        if (!(await waitGone(group.pid, this.graceMs + 500))) pending.push(group.member);
      }));
      if (pending.length) return { committedHash: prior.committedHash, restarted: [], stopped: [], started: [], pending };
    }
    for (const worker of this.workers.filter((entry) => entry.rosterDir === dir)) {
      const name = worker.member!;
      const next = desired.get(name);
      const oldMember = oldMembers.get(name) ?? worker.spec.team?.spec.members.find((member) => member.name === name);
      if (!next) { revoked.add(name); blocked.add(name); }
      else if (worker.writeScope && effectiveMemberAccess(next) !== "write") revoked.add(name);
      try {
        if (!oldMember) throw new Error("missing committed member");
        const oldPath = validateMemberPath(this.home, dir, name, oldMember.dir);
        if (oldPath.realPath !== worker.cwd || (prior?.members[name]?.launchHash && prior.members[name]!.launchHash !== this.launchHash(prior.spec, oldMember, oldPath.realPath))) {
          revoked.add(name);
          blocked.add(name);
        }
      } catch { revoked.add(name); blocked.add(name); }
      if (next) {
        try { validateMemberPath(this.home, dir, next.name, next.dir); }
        catch { revoked.add(name); blocked.add(name); }
      }
    }

    const stopMembers = async (names: Set<string>, targetSpec: TeamSpec, phase: TeamSyncIntent["phase"]): Promise<string[]> => {
      const selected = this.workers.filter((worker) => worker.rosterDir === dir && names.has(worker.member!));
      const affectedGroups = selected.flatMap((worker) => worker.child?.pid ? [{
        member: worker.member!, pid: worker.child.pid, startedAt: worker.startedAt, scope: worker.writeScope,
      }] : []);
      const oldHash = prior?.committedHash ?? createHash("sha256").update(JSON.stringify(prior?.spec ?? { members: [] })).digest("hex");
      const targetHash = createHash("sha256").update(JSON.stringify(targetSpec)).digest("hex");
      const latestStates = this.syncStates();
      const state: TeamSyncState = latestStates[dir] ?? prior ?? {
        rosterRootId: createHash("sha256").update(dir).digest("hex"), rosterDir: dir, committedHash: oldHash,
        spec: { members: [] }, members: {},
      };
      for (const name of names) if (revoked.has(name) && state.members[name]) {
        state.members[name]!.wanted = false;
        state.members[name]!.restartWanted = !blocked.has(name) && priorWanted[name] === true;
      }
      latestStates[dir] = { ...state, intent: {
        rosterRootId: state.rosterRootId, fromPath: dir, committedHash: oldHash, targetHash,
        phase, affectedGroups, staleTuiReservationIds: [],
      }, pendingSpec: targetSpec };
      this.writeSyncStates(latestStates);
      for (const worker of selected) this.onTeamMemberStopping?.(dir, worker.member!);
      for (const worker of selected) this.kill(worker);
      this.workers = this.workers.filter((worker) => !selected.includes(worker));
      this.save();
      this.saveRuntime();
      const pending: string[] = [];
      await Promise.all(affectedGroups.map(async (group) => {
        if (!(await waitGone(group.pid, this.graceMs + 500))) pending.push(group.member);
      }));
      return pending;
    };

    const safetyStopped: string[] = [];
    if (revoked.size) {
      const pending = await stopMembers(revoked, team, "stopping");
      safetyStopped.push(...revoked);
      if (pending.length) {
        const current = this.syncStates();
        const state = current[dir]!;
        state.intent!.phase = "stop-pending";
        current[dir] = state;
        this.writeSyncStates(current);
        return { committedHash: prior?.committedHash ?? "", restarted: [], stopped: safetyStopped, started: [], pending };
      }
    }

    // Validate the complete target before ordinary stop/restart work. Safety revocations above are
    // intentionally already durable if an unrelated member fails this preflight.
    let resolved: Map<string, string>;
    try {
      resolved = new Map(team.members.map((member) => [member.name, validateMemberPath(this.home, dir, member.name, member.dir).realPath]));
      const writers = team.members.filter((member) => member.mode !== "tui" && effectiveMemberAccess(member) === "write");
      for (const [index, member] of writers.entries()) {
        const scope = captureWriteScope(resolved.get(member.name)!);
        const conflict = writers.slice(0, index).find((other) => writeScopesOverlap(scope, captureWriteScope(resolved.get(other.name)!)));
        if (conflict) throw new Error(`${member.name} and ${conflict.name} would write to overlapping directories`);
      }
    } catch (error) {
      if (revoked.size && this.syncStates()[dir]?.intent) {
        const latest = this.syncStates();
        const state = latest[dir]!;
        state.intent = undefined;
        state.pendingSpec = undefined;
        latest[dir] = state;
        this.writeSyncStates(latest);
      }
      throw error;
    }

    const retiring = [...this.retiringWriters.entries()].filter(([, entry]) => entry.dir === dir);
    const stoppingPaths: string[] = [];
    await Promise.all(retiring.map(async ([pid, entry]) => {
      if (!(await waitGone(pid, this.graceMs + 500))) stoppingPaths.push(entry.writeScope.path);
      else this.retiringWriters.delete(pid);
    }));
    if (stoppingPaths.length) return { committedHash: prior?.committedHash ?? "", restarted: [], stopped: safetyStopped, started: [], pending: stoppingPaths };
    this.prepareRosterWriteScopes(dir, team, this.rosterWriteScopes);
    let currentState = this.syncStates()[dir] ?? prior;
    let oldStateMembers = currentState?.members ?? {};
    const changedWanted = new Set<string>();
    const stopped = new Set(safetyStopped);
    const existingWorkers = this.workers.filter((worker) => worker.rosterDir === dir);
    for (const member of team.members) {
      const priorMember = oldMembers.get(member.name);
      if (priorMember && priorWanted[member.name] && !blocked.has(member.name)) {
        const previousHash = oldStateMembers[member.name]?.launchHash ?? this.launchHash(prior?.spec ?? team, priorMember, resolved.get(member.name)!);
        if (previousHash !== this.launchHash(team, member, resolved.get(member.name)!)) changedWanted.add(member.name);
      }
    }
    for (const worker of existingWorkers) {
      const member = desired.get(worker.member!);
      const priorMember = oldMembers.get(worker.member!);
      const previousHash = oldStateMembers[worker.member!]?.launchHash ?? (priorMember ? this.launchHash(prior?.spec ?? team, priorMember, worker.cwd ?? dir) : "");
      const nextHash = member ? this.launchHash(team, member, resolved.get(member.name)!) : "";
      if (!member || (member && previousHash !== nextHash)) {
        if (member && oldStateMembers[worker.member!]?.wanted !== false) changedWanted.add(worker.member!);
        stopped.add(worker.member!);
      }
    }
    const ordinaryStopNames = new Set([...stopped].filter((name) => !safetyStopped.includes(name)));
    let pending: string[] = [];
    if (ordinaryStopNames.size) pending = await stopMembers(ordinaryStopNames, team, "stopping");
    if (pending.length) {
      const current = this.syncStates();
      const state = current[dir]!;
      state.intent!.phase = "stop-pending";
      current[dir] = state;
      this.writeSyncStates(current);
      return { committedHash: prior?.committedHash ?? "", restarted: [], stopped: [...stopped], started: [], pending };
    }
    try { validateCommit?.(); }
    catch (error) {
      const latest = this.syncStates();
      const state = latest[dir];
      if (state?.intent) {
        for (const group of state.intent.affectedGroups) if (state.members[group.member]) {
          state.members[group.member]!.wanted = false;
          state.members[group.member]!.restartWanted = false;
        }
        state.intent.phase = "stop-pending";
        state.pendingSpec = undefined;
        latest[dir] = state;
        this.writeSyncStates(latest);
      }
      throw error;
    }

    currentState = this.syncStates()[dir] ?? currentState;
    oldStateMembers = currentState?.members ?? {};
    const members: Record<string, { launchHash: string; wanted: boolean; restartWanted?: boolean }> = {};
    for (const member of team.members) {
      const previous = oldStateMembers[member.name];
      const runningBefore = existingWorkers.some((worker) => worker.member === member.name);
      members[member.name] = {
        launchHash: this.launchHash(team, member, resolved.get(member.name)!),
        wanted: blocked.has(member.name) || (previous?.wanted === false && !previous.restartWanted)
          ? false
          : changedWanted.has(member.name) || (runningBefore && previous?.wanted !== false) || (previous?.wanted ?? false) || (previous?.restartWanted ?? false),
        restartWanted: false,
      };
    }
    const committedHash = createHash("sha256").update(JSON.stringify(team)).digest("hex");
    const state: TeamSyncState = {
      rosterRootId: currentState?.rosterRootId ?? createHash("sha256").update(dir).digest("hex"),
      rosterDir: dir, committedHash, spec: team, members,
    };
    const commitStates = this.syncStates();
    commitStates[dir] = { ...state, intent: {
      rosterRootId: state.rosterRootId, fromPath: dir, committedHash: currentState?.committedHash ?? "",
      targetHash: committedHash, phase: "committing", affectedGroups: [], staleTuiReservationIds: [],
    }, pendingSpec: team };
    this.writeSyncStates(commitStates);
    this.commitRosterWriteScopes(dir, team);
    const wantedNow = this.syncStates()[dir]?.members ?? members;
    const restart = team.members.filter((member) => changedWanted.has(member.name) && wantedNow[member.name]?.wanted && members[member.name]?.wanted);
    if (restart.length) this.startTeam(dir, { ...team, members: restart }, false);
    this.save();
    const committedStates = this.syncStates();
    const committedState = committedStates[dir]!;
    committedState.intent = undefined;
    committedState.pendingSpec = undefined;
    committedStates[dir] = committedState;
    this.writeSyncStates(committedStates);
    const started = restart.map((member) => member.name);
    return { committedHash, restarted: started, stopped: [...stopped], started: [], pending: [] };
  }

  async stopUnsafeTeamWorkers(rosterDir: string, team?: TeamSpec): Promise<{ stopped: string[]; pending: string[] }> {
    const canonical = canonicalPathOrMissing(rosterDir);
    const unsafe = this.workers.filter((worker) => {
      if (worker.rosterDir !== canonical) return false;
      const member = team?.members.find((entry) => entry.name === worker.member);
      if (!member || member.mode !== "headless") return true;
      if (worker.writeScope && effectiveMemberAccess(member) !== "write") return true;
      try {
        const path = validateMemberPath(this.home, canonical, member.name, member.dir).realPath;
        if (path !== worker.cwd) return true;
        return !!worker.writeScope && captureWriteScope(path).ancestors[0] !== worker.writeScope.ancestors[0];
      } catch { return true; }
    });
    const groups = unsafe.flatMap((worker) => worker.child?.pid ? [{ pid: worker.child.pid, member: worker.member!, startedAt: worker.startedAt, scope: worker.writeScope }] : []);
    const states = this.syncStates();
    const prior = states[canonical];
    if (unsafe.length) {
      const targetHash = team ? createHash("sha256").update(JSON.stringify(team)).digest("hex") : "invalid-roster";
      const nextState = prior ?? { rosterRootId: createHash("sha256").update(canonical).digest("hex"), rosterDir: canonical, committedHash: "", spec: { members: [] }, members: {} };
      for (const worker of unsafe) if (worker.member && nextState.members[worker.member]) nextState.members[worker.member]!.wanted = false;
      states[canonical] = {
        ...nextState,
        intent: {
          rosterRootId: prior?.rosterRootId ?? createHash("sha256").update(canonical).digest("hex"),
          fromPath: canonical, committedHash: prior?.committedHash ?? "", targetHash, phase: "stopping",
          affectedGroups: groups, staleTuiReservationIds: [],
        },
        pendingSpec: undefined,
      };
      this.writeSyncStates(states);
      for (const worker of unsafe) if (worker.member) this.onTeamMemberStopping?.(canonical, worker.member);
    }
    for (const worker of unsafe) this.kill(worker);
    this.workers = this.workers.filter((worker) => !unsafe.includes(worker));
    if (unsafe.length) { this.save(); this.saveRuntime(); }
    const pending: string[] = [];
    await Promise.all(groups.map(async ({ pid, member }) => {
      if (!(await waitGone(pid, this.graceMs + 500))) pending.push(member);
    }));
    for (const [pid, entry] of this.retiringWriters) {
      if (entry.dir === canonical && probeGroup(pid) !== "gone" && !groups.some((group) => group.pid === pid)) pending.push(entry.writeScope.path);
    }
    if (unsafe.length) {
      const updated = this.syncStates();
      const state = updated[canonical]!;
      if (pending.length) state.intent!.phase = "stop-pending";
      else {
        for (const worker of unsafe) if (worker.member && state.members[worker.member]) state.members[worker.member]!.wanted = false;
        state.intent = undefined;
      }
      updated[canonical] = state;
      this.writeSyncStates(updated);
    }
    return { stopped: unsafe.map((worker) => worker.member!), pending };
  }

  /** Stop supervised workers of one team, optionally one member. Never touches a TUI or plain Barista. */
  async relocateTeam(input: {
    rosterRootId: string;
    ownerKey: string;
    fromPath: string;
    toPath: string;
    committedHash: string;
    targetHash: string;
    targetSpec: TeamSpec;
    quarantineSource?: () => void;
  }): Promise<{ pending: string[]; relocation: TeamRelocation }> {
    const fromPath = canonicalPathOrMissing(input.fromPath);
    const toPath = realpathSync(input.toPath);
    const targetSpec = TeamLaunchSpec.parse(input.targetSpec);
    const sync = this.syncStates();
    if (sync[fromPath]?.intent || sync[toPath]?.intent) throw new Error("retry cafe team sync before relocating either roster root");
    let relocation = this.relocationState.pending;
    if (relocation) {
      if (relocation.fromPath !== fromPath || relocation.toPath !== toPath || relocation.rosterRootId !== input.rosterRootId || relocation.ownerKey !== input.ownerKey) {
        throw new Error("another team relocation is already pending");
      }
    } else {
      if (this.isRelocatedRoot(fromPath)) throw new Error(`roster root ${fromPath} was relocated to ${this.relocationState.relocatedRoots[fromPath]}`);
      const selected = this.workers.filter((worker) => worker.rosterDir === fromPath);
      const affectedGroups = selected.flatMap((worker) => worker.child?.pid ? [{ member: worker.member ?? "", pid: worker.child.pid, startedAt: worker.startedAt }] : []);
      for (const [pid, entry] of this.retiringWriters) {
        if (entry.dir === fromPath && !affectedGroups.some((group) => group.pid === pid)) affectedGroups.push({ member: "retiring process group", pid, startedAt: entry.startedAt });
      }
      const staleTuiReservationIds = this.rosterWriteScopes.filter((entry) => entry.rosterDir === fromPath && entry.tui && !entry.tui.stale).map((entry) => entry.tui!.reservationId);
      relocation = {
        id: randomUUID(), rosterRootId: input.rosterRootId, ownerKey: input.ownerKey, fromPath, toPath,
        committedHash: input.committedHash, targetHash: input.targetHash, targetSpec,
        affectedGroups, staleTuiReservationIds, phase: "relocating",
      };
      this.relocationState.pending = relocation;
      this.saveRelocationState();
    }
    input.quarantineSource?.();
    const selected = this.workers.filter((worker) => worker.rosterDir === fromPath);
    for (const worker of selected) this.kill(worker);
    this.workers = this.workers.filter((worker) => !selected.includes(worker));
    this.save();
    this.saveRuntime();
    const pending: string[] = [];
    await Promise.all(relocation.affectedGroups.map(async (group) => {
      if (!(await waitGone(group.pid, this.graceMs + 500))) pending.push(group.member);
    }));
    if (pending.length) {
      relocation.phase = "stop-pending";
      this.saveRelocationState();
      return { pending, relocation };
    }
    this.finishRelocationScopes(relocation);
    relocation.phase = "committing";
    this.saveRelocationState();
    return { pending, relocation };
  }

  pendingTeamRelocation(): TeamRelocation | undefined { return this.relocationState.pending; }

  completeTeamRelocation(id: string): void {
    const relocation = this.relocationState.pending;
    if (!relocation || relocation.id !== id || relocation.phase !== "committing") throw new Error("team relocation is not ready to commit");
    this.relocationState.relocatedRoots[relocation.fromPath] = relocation.toPath;
    delete this.relocationState.pending;
    this.saveRelocationState();
  }

  relocationFenceBlocks(path: string): boolean {
    return this.isRelocatedRoot(path) || this.relocationState.pending?.toPath === path;
  }

  private isRelocatedRoot(path: string): boolean {
    return Object.hasOwn(this.relocationState.relocatedRoots, path) || this.relocationState.pending?.fromPath === path;
  }

  private finishRelocationScopes(relocation: TeamRelocation): void {
    const stale = this.rosterWriteScopes.flatMap((entry) => {
      if (entry.rosterDir !== relocation.fromPath) return [entry];
      return entry.tui ? [{ ...entry, tui: { ...entry.tui, stale: true } }] : [];
    });
    const next = this.prepareRosterWriteScopes(relocation.toPath, relocation.targetSpec, stale);
    writeAtomic(this.rosterWriteFile, JSON.stringify(next, null, 2), true);
    this.rosterWriteScopes = next;
  }

  private saveRelocationState(): void {
    writeAtomic(this.relocationFile, JSON.stringify(this.relocationState, null, 2), true);
  }

  stopTeam(rosterDir: string, member?: string, exactPath?: string): number {
    const target = resolve(rosterDir);
    let canonical = canonicalPathOrMissing(target);
    const matching = (dir: string) => this.workers.filter((w) => w.rosterDir === dir && (!member || w.member === member) && (!exactPath || w.cwd === exactPath));
    let ws = matching(target);
    // A recorded path still identifies the team if the directory is no longer accessible.
    if (ws.length === 0) {
      try {
        ws = matching(realpathSync(target));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      }
    }
    canonical = ws[0]?.rosterDir ?? canonical;
    const states = this.syncStates();
    const state = states[canonical];
    if (state) {
      for (const name of Object.keys(state.members)) {
        if (!member || name === member) {
          state.members[name]!.wanted = false;
          state.members[name]!.restartWanted = false;
        }
      }
      this.writeSyncStates(states);
    }
    for (const w of ws) this.kill(w);
    this.workers = this.workers.filter((w) => !ws.includes(w));
    this.save();
    return ws.length;
  }

  isStoppingTeamPath(rosterDir: string, path: string): boolean {
    for (const [pid, entry] of this.retiringWriters) {
      if (probeGroup(pid) === "gone") this.retiringWriters.delete(pid);
      else if (entry.dir === rosterDir && entry.writeScope.path === path) return true;
    }
    return false;
  }

  stop(dir: string): number {
    const target = resolve(dir);
    const ws = this.workers.filter((w) => w.spec.dir === target && !w.rosterDir);
    for (const w of ws) this.kill(w);
    this.workers = this.workers.filter((w) => w.spec.dir !== target || w.rosterDir);
    this.save();
    return ws.length;
  }

  list(): WorkerInfo[] {
    return this.workers.map((w) => ({
      dir: w.spec.dir,
      ...(w.cwd || w.writeScope ? { cwd: w.cwd ?? w.writeScope?.path } : {}),
      ...(w.member ? { member: w.member } : {}),
      ...(w.rosterDir ? { rosterDir: w.rosterDir } : {}),
      agent: w.spec.agent ?? (w.spec.bin ?? this.piBin).split(/[\\/]/).pop()!,
      slot: w.slot,
      pid: w.child?.pid,
      restarts: w.restarts,
      startedAt: w.launchedAt,
      running: !!w.child && w.child.exitCode === null && w.child.signalCode === null,
      state: w.failed ? ("failed" as const) : w.child && w.child.exitCode === null && w.child.signalCode === null ? ("running" as const) : ("waiting" as const),
      ...(w.warning ? { warning: w.warning } : {}),
      ...(w.lastError ? { lastError: w.lastError } : {}),
      log: w.logPath,
    }));
  }

  /** Signal every worker group (SIGTERM, SIGKILL after the grace) and resolve once they are gone or the grace passed. */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.pendingProbe).filter((p): p is Promise<void> => !!p));
    const groups = this.workers.map((w) => w.child?.pid).filter((p): p is number => !!p);
    for (const w of this.workers) this.kill(w);
    const deadline = Date.now() + this.graceMs + 500;
    while (groups.some((g) => probeGroup(g) === "present") && Date.now() < deadline) await sleep(50);
  }

  // ---------------------------------------------------------------------------

  private launch(w: Worker): void {
    if (w.writeScope) {
      const scope = w.writeScope;
      const retiring = this.reservedWriter(scope);
      if (retiring) {
        w.timer = setTimeout(() => { if (!w.stopping) this.launch(w); }, EXIT_DRAIN_MS);
        return;
      }
      try {
        const current = captureWriteScope(realpathSync(scope.path));
        if (current.path !== scope.path || current.ancestors[0] !== scope.ancestors[0] ||
          this.workers.some((other) => other !== w && other.writeScope && writeScopesOverlap(current, other.writeScope))) {
          throw new Error("the write-enabled worker's directory changed or overlaps another writer");
        }
      } catch (err) {
        w.failed = true;
        w.lastError = `${(err as Error).message}. Check ${scope.path} and start the worker again.`;
        return;
      }
    }
    const agent = agentKind(w.spec.bin ?? this.piBin);
    if (!w.spec.agent && w.spec.access !== "workspace-write" && agent) {
      w.pendingProbe = probeReadonlyRuntime(w.spec.bin ?? this.piBin, agent, this.extension, { home: this.home, probeScript: this.probeScript, path: this.env.PATH }).catch((error: unknown): ProbeResult => ({
        supported: false, binaryHash: "", reason: `isolation preflight failed: ${(error as Error).message}`,
      })).then((probe) => {
        if (w.stopping || w.child || w.failed) return;
        if (!probe.supported) {
          w.failed = true;
          w.lastError = `read-only ${agent} runtime is unsupported: ${probe.reason ?? "isolation probe failed"}`;
          this.save();
          return;
        }
        this.spawn(w);
      }).finally(() => { if (w.pendingProbe) delete w.pendingProbe; });
      return;
    }
    this.spawn(w);
  }

  private spawn(w: Worker): void {
    mkdirSync(this.logDir, { recursive: true });
    let log: CappedLineFile | undefined;
    w.tail = [];
    try {
      log = openWorkerLog(w.logPath);
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
    const workDir = w.writeScope?.path ?? w.cwd ?? w.spec.dir;
    const bin = w.spec.agent ? process.execPath : (w.spec.bin ?? this.piBin);
    const args = w.spec.agent
      ? [
          GUARD,
          bin,
          this.cliBin,
          "barista",
          "run",
          "--agent",
          w.spec.agent,
          "--dir",
          workDir,
          ...(w.member ? ["--member", w.member, "--team-dir", w.rosterDir!] : []),
          ...(w.spec.access === "workspace-write" ? ["--write"] : []),
          ...(w.spec.model ? ["--model", w.spec.model] : []),
          ...(w.spec.tui ? ["--tui"] : []),
          ...(w.spec.thread ? ["--thread", w.spec.thread] : []),
        ]
      : [GUARD, bin, "--mode", "rpc", "--no-session", ...(
          w.spec.access === "workspace-write" || !agentKind(bin)
            ? ["-e", this.extension]
            : readonlyToolArgs(agentKind(bin)!, this.extension)
        ), ...(w.spec.args ?? [])];
    const scope = createHash("sha256").update(JSON.stringify([w.rosterDir ?? null, w.member ?? null, workDir, w.slot, w.spec.agent ?? w.spec.bin ?? this.piBin, w.spec.access ?? "read-only", Boolean(w.spec.tui)])).digest("hex");
    const env = {
      ...this.env,
      ...(w.member ? { CAFE_TEAM_MEMBER: w.member, CAFE_TEAM_DIR: w.rosterDir! } : {}),
      CAFE_AGENT_RESUME_FILE: join(this.home, "agent-identities", `${scope}.json`),
    };
    // fd 3 is the guard's parent-death pipe: we keep our end open and never write to it.
    const child = spawn(process.execPath, args, { cwd: workDir, env, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true });
    w.child = child;
    w.launchedAt = Date.now();
    w.startedAt = undefined;
    const sink = (chunk: Buffer) => {
      // Keep the last lines in memory: they are the worker's own account of why it stopped.
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) w.tail.push(line.trimEnd());
      if (w.tail.length > 20) w.tail.splice(0, w.tail.length - 20);
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
      if (w.writeScope) this.saveRuntime();
      void readProcessStart(pid).then((lstart) => {
        if (lstart && w.child === child && child.exitCode === null) {
          w.startedAt = lstart;
          this.saveRuntime();
        }
      });
    }
    let settled = false;
    const retire = (code: number | null, signal: NodeJS.Signals | null, message?: string) => {
      if (settled || w.child !== child) return;
      settled = true;
      note(message ?? (code === EXIT_NOT_FOUND ? `agent executable not found: ${bin} (set CAFE_PI_BIN or --agent)` : `exited code=${code} signal=${signal}`));
      const pgid = child.pid;
      // Grandchildren may still hold the group's pipes: give them a moment, then SIGKILL the group.
      if (pgid) {
        this.retainWriter(w, pgid);
        const startedAt = w.startedAt;
        setTimeout(() => { void killVerifiedGroup(pgid, startedAt); }, EXIT_DRAIN_MS).unref?.();
      }
      setTimeout(() => log?.close(), EXIT_DRAIN_MS + 100).unref?.();
      w.child = undefined;
      w.startedAt = undefined;
      this.saveRuntime();
      if (w.stopping) return;
      const failedStart = (code ?? 1) !== 0 && !!w.launchedAt && Date.now() - w.launchedAt < this.quickExitMs;
      if (message) w.lastError = message;
      else if (code !== 0 || signal) {
        w.lastError = explain(w.tail, code === EXIT_NOT_FOUND ? `agent executable not found: ${bin}` : `exited code=${code} signal=${signal}`);
      }
      w.quickFailures = failedStart ? w.quickFailures + 1 : 0;
      if (w.quickFailures >= this.failAfter) {
        // Same failure every time: retrying forever only hides it (#82).
        w.failed = true;
        note(`gave up after ${w.quickFailures} failed starts`);
        this.log(`barista ${w.spec.dir}#${w.slot} gave up after ${w.quickFailures} failed starts: ${w.lastError?.split("\n")[0] ?? "no output"} (log: ${w.logPath})`);
        return;
      }
      if (failedStart && w.quickFailures === 1) this.log(`barista ${w.spec.dir}#${w.slot} failed to start: ${w.lastError?.split("\n")[0] ?? "no output"}; retrying (log: ${w.logPath})`);
      // Reset backoff after a healthy minute; never hot-loop (a missing binary backs off like any crash).
      if (w.launchedAt && Date.now() - w.launchedAt > 60_000) w.restarts = 0;
      const delay = Math.min(60_000, this.backoffBaseMs * 2 ** w.restarts++);
      w.timer = setTimeout(() => !w.stopping && this.launch(w), delay);
    };
    // A spawn error (missing binary, bad cwd) has no `exit`; without this path the record stayed
    // "waiting" forever and later `team start` calls considered the member present (v4-11 review).
    child.on("error", (err) => retire(null, null, `spawn error: ${err.message}`));
    child.on("exit", (code, signal) => retire(code, signal));
  }

  private kill(w: Worker): void {
    w.stopping = true;
    clearTimeout(w.timer);
    const child = w.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const pgid = child.pid;
    this.retainWriter(w, pgid);
    if (w.writeScope) this.saveRuntime();
    signalGroup(pgid, "SIGTERM");
    const startedAt = w.startedAt;
    setTimeout(() => { void killVerifiedGroup(pgid, startedAt); }, this.graceMs).unref?.();
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
    try {
      for (const state of Object.values(this.syncStates())) for (const group of state.intent?.affectedGroups ?? []) {
        if (!entries.some((entry) => entry.pid === group.pid)) entries.push({ dir: state.intent!.fromPath, slot: 1, pid: group.pid, startedAt: group.startedAt, writeScope: group.scope });
      }
    } catch {
      skipped.push(`${this.teamSyncFile}: unreadable`);
    }
    for (const entry of entries) {
      if (Number.isSafeInteger(entry.pid) && entry.pid > 0 && entry.writeScope &&
          typeof entry.writeScope.path === "string" && Array.isArray(entry.writeScope.ancestors) && probeGroup(entry.pid) !== "gone") {
        this.retiringWriters.set(entry.pid, { ...entry, writeScope: entry.writeScope });
      }
    }
    for (const e of entries) {
      if (!Number.isSafeInteger(e.pid) || e.pid <= 0) continue;
      const status = probeGroup(e.pid);
      if (status === "gone") continue;
      if (status !== "present" || typeof e.startedAt !== "string") {
        skipped.push(`pid ${e.pid}: process identity unavailable`);
        continue;
      }
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
        if (await killVerifiedGroup(e.pid, e.startedAt)) await waitGone(e.pid, 5000);
        if (probeGroup(e.pid) !== "gone") {
          skipped.push(`pid ${e.pid}: process group still present after stop`);
          continue;
        }
      }
      reaped++;
    }
    this.saveRuntime();
    return { reaped, skipped };
  }

  private saveRuntime(): void {
    const entries = new Map<number, RuntimeEntry>();
    for (const w of this.workers) {
      const pid = w.child?.pid;
      if (!pid || (!w.startedAt && !w.writeScope)) continue;
      entries.set(pid, { dir: w.spec.dir, slot: w.slot, pid, startedAt: w.startedAt, writeScope: w.writeScope });
    }
    for (const [pid, entry] of this.retiringWriters) {
      if (probeGroup(pid) === "gone") this.retiringWriters.delete(pid);
      else entries.set(pid, entry);
    }
    writeAtomic(this.runtimeFile, JSON.stringify([...entries.values()], null, 2));
  }

  private save(): void {
    // Plain workers keep one spec per directory. Team workers collapse to one spec per roster whose
    // members are exactly the workers this supervisor owns right now: stopping dev1 must not leave
    // dev1 in dev2's saved spec, and a partial `team start` must not shrink the restored set.
    const plain = new Map<string, BaristaSpec>();
    const teams = new Map<string, { meta: TeamSpec; members: TeamMember[] }>();
    for (const w of this.workers) {
      if (!w.rosterDir) {
        plain.set(w.spec.dir, w.spec);
        continue;
      }
      const meta = w.spec.team?.spec ?? { members: [] };
      const entry = teams.get(w.rosterDir) ?? { meta, members: [] };
      const own = w.spec.team?.spec.members.find((m) => m.name === w.member);
      if (own && !entry.members.some((m) => m.name === own.name)) entry.members.push(own);
      teams.set(w.rosterDir, entry);
    }
    const specs: BaristaSpec[] = [...plain.values()];
    for (const [dir, t] of teams) specs.push({ dir, team: { rosterDir: dir, spec: { ...t.meta, members: t.members } } });
    writeAtomic(this.file, JSON.stringify(specs, null, 2));
  }
}

function writeAtomic(path: string, text: string, required = false): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    if (required) throw err;
  }
}

/**
 * The worker's own explanation: from its last `cafe:` line to the end (that is where `cafe barista
 * run` prints the problem and the `next:` step), else its last few lines, else the exit status.
 */
function explain(tail: string[], fallback: string): string {
  const lines = tail.filter((l) => !l.startsWith("[cafe] "));
  const at = lines.map((l) => l.startsWith("cafe:")).lastIndexOf(true);
  const picked = at >= 0 ? lines.slice(at) : lines.slice(-3);
  return picked.length ? picked.join("\n").slice(0, 800) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function killVerifiedGroup(pid: number, startedAt?: string): Promise<boolean> {
  if (!startedAt || probeGroup(pid) !== "present" || await readProcessStart(pid) !== startedAt.trim()) return false;
  signalGroup(pid, "SIGKILL");
  return true;
}

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() <= deadline) {
    if (probeGroup(pgid) === "gone") return true;
    await sleep(50);
  }
  return probeGroup(pgid) === "gone";
}
