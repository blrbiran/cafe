#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { onlineVersions, type AgentRecord, type DaemonRecord, type RoutingHint, type ThreadEnvelope, type ThreadMeta } from "@cafe/protocol";
import { PROTOCOL_VERSION } from "@cafe/protocol/version";
import { assertDaemonAddress, cafeHome, CONFIG_KEYS, configApplyMode, configKeyPath, isConfigKey, configInitialized, homeId, defaultExtensionPath, diffConfig, discoverRoots, formatRoutingStats, listRouterModels, loadConfig, runDaemon, saveConfig, setConfigValue, type RoutingStats } from "@cafe/daemon";
import { fingerprintOf, issueLeaf, localAddresses, sanList } from "../../daemon/src/tls/certs.ts";
import { readLeaf, tlsPaths, writeLeaf } from "../../daemon/src/tls/store.ts";
import { normalizeFingerprint, readTlsConfig } from "../../daemon/src/tls/trust.ts";
import { trustCaForClient } from "../../daemon/src/tls/bootstrap.ts";
import { daemonHttpUrl } from "@cafe/protocol/urls";
import { readCafeFile } from "@cafe/protocol/cafe-file";
import { joinAddresses } from "@cafe/daemon";
import { joinText } from "./join-text.ts";
import { tlsLine } from "./tls-line.ts";
import { webLine } from "./web-line.ts";
import { formatApiError } from "./errors.ts";
import { uploadAttachment as uploadArtifact } from "./artifacts.ts";
import { PRESETS, presetCommand, serve } from "./serve.ts";
import { BRIDGED_AGENTS, runBridge, type AgentKind } from "./bridge/barista.ts";
import { runSessionHost, type HostMessage } from "./bridge/session-host.ts";
import { CodexTuiEngine } from "./bridge/codex-tui.ts";
import { runInit } from "./init.ts";
import { extensionPackageDir, installPiExtension, ompExtensionCommand, ompExtensionState, piExtensionState, removePiExtension, summarizeProcessError } from "./extension.ts";
import { runDoctor } from "./doctor.ts";
import { claudeCommandPath, claudeCommandState, commandsStatus, installClaudeCommand, uninstallClaudeCommand } from "./commands.ts";
import { claudePluginPlan, claudePluginState, MARKETPLACE as CLAUDE_MARKETPLACE, PLUGIN as CLAUDE_PLUGIN, pluginSource, writeClaudePlugin } from "./claude-plugin.ts";
import { mcpInstallCommands, runMcp } from "./mcp.ts";
import { installService, serviceFile, servicePath, startInstalledService, uninstallService } from "./service.ts";
import { applyUpdate, checkUpdate, rollbackUpdate, updateStatus } from "./update.ts";
import { addConnectorCommands } from "./connector.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Daemon access
// ---------------------------------------------------------------------------

function base(): string {
  if (process.env.CAFE_DAEMON) return `http://${process.env.CAFE_DAEMON}`;
  return `http://127.0.0.1:${loadConfig().port}`;
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.CAFE_TOKEN) headers.authorization = `Bearer ${process.env.CAFE_TOKEN}`;
  const res = await fetch(`${base()}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatApiError(body, res.status));
  return body as T;
}

/** Why the last `healthy()` check failed, as an error code (ECONNREFUSED = nothing is listening). */
let lastHealthCode: string | undefined;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(800) });
    lastHealthCode = r.ok ? undefined : `HTTP_${r.status}`;
    return r.ok;
  } catch (err) {
    const c = (err as any)?.cause;
    lastHealthCode = (err as any)?.name === "TimeoutError" ? "ETIMEDOUT" : (c?.code ?? c?.errors?.[0]?.code ?? (err as any)?.code ?? "UNKNOWN");
    return false;
  }
}

/**
 * Refuse to act on a daemon that is not this CAFE_HOME's (#88). Without this, an empty or
 * deleted CAFE_HOME falls back to the default port and `cafe daemon stop` shuts down whichever
 * daemon answers there — usually the person's real Root. An explicit CAFE_DAEMON target is the
 * caller's choice and is not second-guessed.
 * Returns false when nothing is listening.
 */
async function ownDaemonRunning(): Promise<boolean> {
  if (process.env.CAFE_DAEMON) return healthy();
  const home = cafeHome();
  if (!configInitialized(home)) {
    throw new Error(`this CAFE_HOME (${home}) is not initialized: there is no config.yml, so it has no daemon to stop.\nnext: check CAFE_HOME, or run \`cafe daemon start\` to create one`);
  }
  return assertNotForeign(home);
}

/** True when a daemon answers on this home's port; throws if it belongs to another home. */
async function assertNotForeign(home: string): Promise<boolean> {
  let h: { host?: string; homeId?: string; pid?: number };
  try {
    const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    h = await r.json();
  } catch {
    return false;
  }
  const mine = h.homeId ? h.homeId === homeId(home) : h.host === loadConfig().host;
  if (!mine) {
    throw new Error(
      `the daemon on ${base()} (host ${h.host ?? "?"}, pid ${h.pid ?? "?"}) belongs to another CAFE_HOME, not ${home}; refusing to touch it.\n` +
        `next: check CAFE_HOME and the port in ${join(home, "config.yml")}`,
    );
  }
  return true;
}

/** The daemon is on this machine (its directories are ours), not a remote CAFE_DAEMON. */
function localDaemon(): boolean {
  const target = process.env.CAFE_DAEMON;
  if (!target) return true;
  const host = target.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * After `barista start`: wait until an Agent from `dir` registers, or a worker for it exits with an
 * error. A worker that fails at once is reported instead of being called "started" (#82).
 */
async function awaitBarista(dir: string, timeoutMs = Number(process.env.CAFE_BARISTA_START_WAIT_MS) || 15_000): Promise<{ agent?: string; failed?: { lastError?: string; log?: string } }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = await api<any[]>("/api/baristas").catch(() => []);
    const failed = ws.find((w) => w.dir === dir && !w.running && (w.state === "failed" || w.lastError));
    if (failed) return { failed };
    const agents = await api<any[]>("/api/agents").catch(() => []);
    const mine = agents.find((a) => a.cwd === dir && a.status !== "offline");
    if (mine) return { agent: mine.address ?? mine.name };
    await new Promise((r) => setTimeout(r, 250));
  }
  return {};
}

/** Upload one file to the local daemon; the returned metadata goes on the Order. */
async function uploadAttachment(file: string) {
  return uploadArtifact(base(), file, process.env.CAFE_TOKEN);
}

/**
 * Write a config value and apply it. A value the running daemon rejects (an
 * unknown router model) is rolled back, so config and running state stay equal.
 */
/** `config get` and `config set` accept the same keys; a misspelt one fails with suggestions (#94). */
function assertConfigKey(key: string): void {
  if (isConfigKey(key)) return;
  const suggestions = similar(key, [...CONFIG_KEYS]).slice(0, 3);
  throw new Error(`unknown config key '${key}'${suggestions.length ? `; did you mean ${suggestions.join(", ")}?` : ""}`);
}

async function setAndApply(key: string, value: string): Promise<{ human: string; data: any }> {
  assertConfigKey(key);
  const before = loadConfig() as Record<string, any>;
  const old = configKeyPath(key).reduce((o, k) => o?.[k], before);
  setConfigValue(key, value);
  // Only hot keys can be applied to a running daemon; say which mode a key has instead of pretending.
  if (configApplyMode(key) !== "hot") {
    return { human: `${key} = ${value}\n(saved; restart required: cafe daemon restart)`, data: { [key]: value, applied: false, restartRequired: true } };
  }
  if (!(await healthy())) return { human: `${key} = ${value}`, data: { [key]: value, applied: false } };
  const res = await api<any>("/api/reload", { method: "POST" });
  if (!res.ok) {
    setConfigValue(key, old === undefined ? "" : String(old));
    throw new Error(`${key} was not applied: ${res.error ?? "reload failed"} (still using ${res.router}${res.model ? ` ${res.model}` : ""})`);
  }
  const running = `router: ${res.router}${res.model ? ` (${res.model})` : ""}`;
  return { human: `${key} = ${value}\n${running}`, data: { [key]: value, applied: true, ...res } };
}

/** Start the local daemon in the background if it is not running (lock in the daemon prevents duplicates). */
async function ensureDaemon(opts: { root?: boolean } = {}): Promise<void> {
  if (await healthy()) return;
  if (process.env.CAFE_DAEMON) throw new Error(`cafe daemon at ${process.env.CAFE_DAEMON} is not reachable`);
  // Only "nothing is listening" means there is no daemon to talk to. Anything else (a sandbox that
  // blocks loopback, a reset, a timeout) means one may well be running: starting a second one would
  // fail confusingly (EPERM on its log inside a read-only sandbox) or fight over the port.
  if (lastHealthCode !== "ECONNREFUSED") {
    throw new Error(
      `cannot reach the cafe daemon at ${base()} (${lastHealthCode}), and it is not simply stopped, so a new one was not started.\n` +
        "next: if this runs inside a sandbox (e.g. Codex read-only), allow network access to localhost or run the command outside it; otherwise check `cafe daemon status` from a normal shell",
    );
  }
  const home = cafeHome();
  mkdirSync(home, { recursive: true });
  const waitMs = Number(process.env.CAFE_DAEMON_START_WAIT_MS) || 60_000;
  // A daemon for this home holds the lock but does not answer yet: it is still starting (the LLM router
  // can take tens of seconds to load). Wait for it; a second daemon would only die with "already running".
  const starting = lockHolder(home);
  if (starting) {
    if (await untilHealthy(waitMs, () => alivePid(starting))) return;
    // It exited while we waited (it was stopping, not starting): start a new one below.
    if (alivePid(starting)) throw new Error(
      `a cafe daemon (pid ${starting}) holds ${join(home, "daemon.lock")} but is not answering on ${base()}; it may still be starting.\n` +
        `next: wait a moment and run \`cafe daemon status\`; see ${join(home, "daemon.log")}`,
    );
  }
  // Autostart installed for this home: let launchd/systemd run it so it stays supervised.
  if (startInstalledService(home)) {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await healthy()) return;
    }
  }
  // Raw startup output (before the daemon's own logger opens) goes to daemon.stdout.log; daemon.log
  // is written by the daemon with timestamps and a cap (#66).
  const stdoutLog = join(home, "daemon.stdout.log");
  const out = openSync(stdoutLog, "a");
  const from = fstatSync(out).size;
  const args = ["--no-warnings", MAIN, "daemon", "run", ...(opts.root ? ["--root"] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  let exited = false;
  child.once("exit", () => (exited = true));
  child.unref();
  // Wait while the daemon is alive: a slow start is not a failed one.
  if (await untilHealthy(waitMs, () => !exited, child.pid)) return;
  if (!exited) {
    throw new Error(
      `the cafe daemon (pid ${child.pid}) is still starting after ${Math.round(waitMs / 1000)} s and not answering on ${base()}.\n` +
        `next: run \`cafe daemon status\` in a moment; see ${join(home, "daemon.log")}`,
    );
  }
  // Lost a race: another starter (a Claude Code session-host auto-starts the daemon too) took the lock
  // first, so ours exited with "already running". Wait for the winner instead of failing.
  const winner = lockHolder(home);
  if (winner && winner !== child.pid) {
    if (await untilHealthy(waitMs, () => alivePid(winner), winner)) return;
  }
  // A daemon that exits at once (port in use, bad config) printed its reason; show it here instead of
  // only pointing at the log.
  const reason = startupReason(stdoutLog, from);
  throw new Error(`cafe daemon did not start${reason ? `: ${reason}` : ""}\nsee ${join(home, "daemon.log")} and ${stdoutLog}`);
}

/** Poll health every 100 ms for up to `ms` while `alive()`; after 5 s, say once that it is still starting. */
async function untilHealthy(ms: number, alive: () => boolean, pid?: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let told = false;
  const started = Date.now();
  while (Date.now() < deadline && alive()) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthy()) return true;
    if (!told && Date.now() - started > 5_000) {
      told = true;
      process.stderr.write(`cafe daemon${pid ? ` (pid ${pid})` : ""} is still starting…\n`);
    }
  }
  return false;
}

/** The live pid holding this home's daemon.lock, if any. */
function lockHolder(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, "daemon.lock"), "utf8").trim());
    return pid && alivePid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The daemon's own `cafe: …` error line written to daemon.stdout.log since byte `from`, if any. */
function startupReason(file: string, from: number): string | undefined {
  try {
    const text = readFileSync(file).subarray(from).toString("utf8");
    const line = text.split("\n").reverse().find((l) => l.startsWith("cafe: "));
    return line?.slice("cafe: ".length).trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

let JSON_OUT = false;
function out(human: string, data: unknown): void {
  console.log(JSON_OUT ? JSON.stringify(data, null, 2) : human);
}

const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : "-");

function describe(env: ThreadEnvelope, agents: Map<string, AgentRecord>): string | undefined {
  const who = (id?: string) => (id ? (agents.get(id)?.address ?? id) : "?");
  const e = env.event;
  switch (e.type) {
    case "order.routed":
      return `→ routed (${e.decision.router}, ${e.decision.mode}) to ${e.decision.targets.map(who).join(", ") || "nobody"}: ${e.decision.reason}`;
    case "order.acked":
      return `… ${who(e.agentId)} is working on it`;
    case "order.replied":
      return `\n## ${who(e.agentId)}${e.final ? "" : " (interim)"}\n${e.text}\n`;
    case "order.declined":
      return `✗ ${who(e.agentId)} declined: ${e.reason}`;
    case "order.failed":
      return `! ${e.agentId ? who(e.agentId) : "order"} failed: ${e.reason}`;
    case "order.cancelled":
      return `✗ cancelled by ${e.by}`;
    case "order.created":
      return e.order.turn > 1 ? `\n> follow-up from ${e.order.from.address}: ${e.order.body}` : undefined;
    case "order.closed":
      return `— ${e.status}`;
    default:
      return undefined;
  }
}

/** Follow a Thread over SSE until it closes. Returns the final status. */
async function follow(threadId: string, opts: { quiet?: boolean; orderId?: string; timeoutMs?: number } = {}): Promise<string> {
  const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
  // Abort the local stream on timeout or Ctrl-C. Cancelling the Order too is the caller's job: a
  // follow-up should not kill an answer that is just slow, but leaving `thread_busy` behind is worse (#60).
  const abort = new AbortController();
  let reason: "timeout" | "intr" | undefined;
  const onInt = () => {
    reason = "intr";
    abort.abort();
  };
  process.once("SIGINT", onInt);
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        reason = "timeout";
        abort.abort();
      }, opts.timeoutMs)
    : undefined;
  try {
    return await followStream(threadId, opts, agents, abort.signal);
  } catch (err) {
    if (!reason) throw err;
    // The daemon already closed the Order on its own deadline, so this is often just the local
    // stream ending late; say what happened and never leave the person without the thread id. A
    // cancel that fails must be reported as such: claiming "cancelled" hides a question still open.
    const cancelled = await api(`/api/threads/${threadId}/cancel`, { method: "POST" }).then(
      () => true,
      (e: Error) => e,
    );
    const state =
      cancelled === true
        ? "it is cancelled now"
        : `could not cancel it (${(cancelled as Error).message}) — it may still be running`;
    if (reason === "timeout") {
      throw new Error(`gave up waiting on thread ${threadId} after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s; ${state} — check \`cafe thread ${threadId}\``);
    }
    console.error(`\nthread ${threadId}: ${state} — it stays readable with \`cafe thread ${threadId}\``);
    return cancelled === true ? "cancelled" : "unknown";
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onInt);
  }
}

async function followStream(threadId: string, opts: { quiet?: boolean; orderId?: string }, agents: Map<string, AgentRecord>, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${base()}/api/threads/${threadId}/stream${opts.orderId ? `?orderId=${opts.orderId}` : ""}`, {
    headers: process.env.CAFE_TOKEN ? { authorization: `Bearer ${process.env.CAFE_TOKEN}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`cannot stream thread ${threadId}: ${res.status}`);
  const decoder = new TextDecoder();
  let buf = "";
  let status = "unknown";
  const replies: unknown[] = [];
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const env = JSON.parse(data.slice(6)) as ThreadEnvelope;
      // Earlier turns are replayed; only report on the Order being followed.
      if (opts.orderId && env.orderId !== opts.orderId) continue;
      if (env.event.type === "order.replied") replies.push({ from: agents.get(env.event.agentId)?.address ?? env.event.agentId, text: env.event.text, final: env.event.final });
      if (env.event.type === "order.closed") status = env.event.status;
      if (!JSON_OUT && !opts.quiet) {
        const line = describe(env, agents);
        if (line) console.log(line);
      }
    }
  }
  if (JSON_OUT) console.log(JSON.stringify({ threadId, status, replies }, null, 2));
  return status;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Published package: release/package.json next to dist/; repo: the root package.json. */
function cafeVersion(): string {
  for (const f of [resolve(here, "../package.json"), resolve(here, "../../../package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(f, "utf8"));
      if (pkg.name !== "@cafe/cli" && pkg.version) return pkg.version;
    } catch {}
  }
  return "0.0.0";
}

/** Per-Host versions when the network runs more than one cafe release. */
function versionLines(daemons: DaemonRecord[]): string[] {
  if (onlineVersions(daemons).length <= 1) return [];
  return [
    "warning:   machines run different cafe versions; install the same release everywhere",
    ...daemons.filter((d) => d.online).map((d) => `           ${d.host}${d.isRoot ? " (root)" : ""}: ${d.version ?? "unknown (older than 0.1.0)"}`),
  ];
}

const program = new Command("cafe")
  .description("cafe: route a message to the agent(s) on the network that can answer it")
  .version(cafeVersion(), "-V, --version")
  .option("--json", "machine-readable output")
  .hook("preAction", (cmd) => {
    JSON_OUT = !!cmd.opts().json;
  });

program.addHelpText(
  "after",
  `
Quick start:
  cafe init                                  create a .cafe identity in this directory
  cafe daemon start --root                   run this machine as the Root daemon
  cafe extension install                     load the cafe extension in new pi / omp sessions
  cafe skill install                         register the cafe skill for Claude Code / Codex
  cafe mcp install                           let Claude Code / Codex ask questions as a Customer
  cafe barista start --dir <dir>             a pi/omp Barista for that directory
  cafe config set router.model <provider/model>   optional: LLM routing
  open http://127.0.0.1:4777/                the web UI
`,
);

program
  .command("init")
  .argument("[dir]", "directory to initialise (default: the current directory)")
  .description("create a .cafe identity file and print the next step")
  .option("--name <name>", "agent name (default: the directory name)")
  .option("--description <text>", "what this agent owns and can answer")
  .option("--tags <list>", "comma-separated tags")
  .option("--scope <list>", "comma-separated paths this agent covers")
  .option("--role <role>", "barista or customer", "barista")
  .option("--concurrency <n>", "headless worker processes", "1")
  .option("-y, --yes", "use the defaults without asking")
  .option("--force", "overwrite an existing .cafe")
  .action(async (dir: string | undefined, o) => {
    const res = await runInit({ dir, name: o.name, description: o.description, tags: o.tags, scope: o.scope, role: o.role, concurrency: o.concurrency, yes: o.yes, force: o.force });
    out(`created ${res.file}\n\nnext:\n${res.next.map((s) => `  ${s}`).join("\n")}`, res);
  });

program
  .command("status")
  .description("one screen: daemon, version, router, root, traffic, pending config and the next command")
  .action(async () => {
    if (!(await healthy())) {
      out(`cafe daemon is not running\nnext: cafe daemon start`, { running: false, base: base() });
      process.exitCode = 1;
      return;
    }
    const [h, snap, cfg] = await Promise.all([api<any>("/api/health"), api<any>("/api/snapshot"), api<any>("/api/config").catch(() => undefined)]);
    const pending: Array<{ key: string; mode: string }> = cfg?.pending ?? [];
    const lines = [
      `daemon:  ${h.host}${h.isRoot ? " (root)" : ""} at ${base()}, cafe ${h.version}`,
      `router:  ${h.routerLoading ? "loading (Orders wait for it)" : `${h.router}${h.model ? ` (${h.model})` : ""}`}${h.error ? ` — ${h.error}` : ""}`,
      `root:    ${h.isRoot ? "this machine is the hub" : rootLine(h)}`,
      `tls:     ${tlsLine(h.tls)}`,
      `traffic: ${snap.threads.length} recent thread(s), ${snap.agents.length} agent(s), ${snap.daemons.length} machine(s)`,
    ];
    if (pending.length) {
      lines.push(`pending: ${pending.map((p) => `${p.key} (${p.mode})`).join(", ")}`);
      lines.push("next:    cafe config apply (hot keys) or cafe daemon restart");
    } else {
      lines.push("pending: none; config.yml and the running daemon agree");
    }
    if (snap.webStale) lines.push("web:     the built UI on disk is newer; cafe daemon restart");
    out(lines.join("\n"), { running: true, health: h, threads: snap.threads.length, agents: snap.agents.length, machines: snap.daemons.length, pending, webStale: !!snap.webStale });
  });

/** `configured (online via <addr>)` / `(offline, last heard Ns ago)`; the connected address may differ after a move (#104). */
function rootLine(h: { root?: string; rootOnline?: boolean; rootConnected?: string; rootLastSeenAt?: number }): string {
  if (!h.root) return "mDNS discovery";
  if (!h.rootOnline) {
    const ago = h.rootLastSeenAt ? Math.round((Date.now() - h.rootLastSeenAt) / 1000) : undefined;
    return `${h.root} (offline${ago !== undefined ? `, last heard ${ago}s ago` : ""})`;
  }
  return h.rootConnected && h.rootConnected !== h.root ? `${h.root} (online via ${h.rootConnected})` : `${h.root} (online)`;
}

const update = program.command("update").description("controlled upgrade and rollback of this machine's cafe (v4-2)");
update
  .command("status")
  .description("current / lastGood / pending release and the running daemon")
  .action(async () => {
    const s = await updateStatus(cafeHome(), base());
    const lines = [
      `current:  ${s.current ?? "(none)"}${s.currentTarget ? ` -> ${s.currentTarget}` : ""}`,
      `lastGood: ${s.lastGood ?? "(none)"}`,
      `pending:  ${s.pending ?? "(none)"}`,
      `running:  ${s.running ? `${s.running.version} (pid ${s.running.pid})${s.running.draining ? " [draining]" : ""}` : "not running"}`,
      ...(s.log.length ? [`last:     ${s.log.at(-1)!.action} ${s.log.at(-1)!.ok ? "ok" : `failed: ${s.log.at(-1)!.error ?? ""}`}`] : []),
    ];
    out(lines.join("\n"), s);
  });
update
  .command("check")
  .description("running version vs the latest published version")
  .action(async () => {
    const c = await checkUpdate(base());
    out(`running: ${c.running ?? "not running"}\nlatest:  ${c.latest ?? "(npm unreachable)"}\n${c.upToDate ? "up to date" : c.latest ? "an update is available: cafe update apply --version " + c.latest : ""}`, c);
  });
update
  .command("apply")
  .description("stage a release, drain, switch current, start and health-check; rolls back on failure")
  .option("--file <tgz>", "local release tarball (offline)")
  .option("--version <version>", "download this version from npm, then apply it")
  .option("--sha256 <hex>", "expected sha256 of the tarball (optional; warns when absent)")
  .option("--timeout <s>", "drain timeout in seconds", Number, 30)
  .action(async (o) => {
    let file: string | undefined = o.file;
    let tmp: string | undefined;
    if (!file && o.version) {
      tmp = mkdtempSync(join(tmpdir(), "cafe-update-"));
      execFileSync("npm", ["pack", `@blrbiran/cafe@${o.version}`, "--pack-destination", tmp], { stdio: "pipe" });
      const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error(`npm pack produced no tarball for ${o.version}`);
      file = join(tmp, tgz);
    }
    if (!file) throw new Error("give --file <tgz> or --version <x>");
    try {
      const r = await applyUpdate({ home: cafeHome(), base: base(), file, sha256: o.sha256, drainTimeoutMs: Math.max(0, o.timeout) * 1000 });
      const svc = serviceFile({ platform: process.platform, node: process.execPath, bin: "", cafeHome: cafeHome(), path: "" });
      const serviceNote =
        r.ok && existsSync(svc.file) && !readFileSync(svc.file, "utf8").includes(join(cafeHome(), "current", "bin", "cafe.js"))
          ? "\nautostart still points at the old entry; run `cafe daemon install` to point it at current"
          : "";
      out(
        `update ${r.ok ? "ok" : "FAILED"}: ${r.from ?? "?"} → ${r.to}${r.rolledBack ? " (rolled back)" : ""}\nhealth: ${r.health.ok ? r.health.version : r.health.error}${r.warning ? `\n${r.warning}` : ""}${serviceNote}`,
        r,
      );
      if (!r.ok) process.exitCode = 1;
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });
update
  .command("rollback")
  .description("switch back to the last-known-good release and restart")
  .action(async () => {
    const r = await rollbackUpdate({ home: cafeHome(), base: base() });
    out(`rollback ${r.ok ? "ok" : "FAILED"}: → ${r.to}\nhealth: ${r.health.ok ? r.health.version : r.health.error}`, r);
    if (!r.ok) process.exitCode = 1;
  });

program
  .command("protocol-version")
  .description("print the wire protocol version (used by the updater's compatibility check)")
  .action(() => {
    out(String(PROTOCOL_VERSION), { protocolVersion: PROTOCOL_VERSION });
  });

const daemon = program.command("daemon").description("manage the local daemon");
daemon
  .command("run")
  .description("run the daemon in the foreground")
  .option("--root", "run as the Root Daemon")
  .option("--port <port>", "listen port", Number)
  .action(async (o) => {
    const running = await runDaemon({ mode: o.root ? "root" : undefined, port: o.port, version: cafeVersion() });
    const stop = async () => {
      await running.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
daemon
  .command("start")
  .description("start the daemon in the background if not running")
  .option("--root", "run as the Root Daemon (also persisted to config)")
  .action(async (o) => {
    // Never report another CAFE_HOME's daemon on this port as "running" (#88).
    if (!process.env.CAFE_DAEMON) await assertNotForeign(cafeHome());
    if (o.root) setConfigValue("mode", "root");
    await ensureDaemon({ root: o.root });
    const h = await api("/api/health");
    out(`cafe daemon running on ${base()} (host ${h.host}${h.isRoot ? ", root" : ""}, pid ${h.pid})`, h);
  });
daemon
  .command("stop")
  .description("stop the background daemon")
  .action(async () => {
    if (!(await ownDaemonRunning())) return out("cafe daemon is not running", { running: false });
    await api("/api/shutdown", { method: "POST" });
    out("cafe daemon stopping", { stopping: true });
  });
daemon
  .command("restart")
  .description("stop and start the daemon (config changes marked restart required)")
  .action(async () => {
    const cfg = loadConfig();
    if (await ownDaemonRunning()) {
      await api("/api/shutdown", { method: "POST" });
      for (let i = 0; i < 50 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 100));
    }
    await ensureDaemon({ root: cfg.mode === "root" });
    const h = await api("/api/health");
    out(`cafe daemon restarted on ${base()} (host ${h.host}${h.isRoot ? ", root" : ""}, pid ${h.pid})`, h);
  });
daemon
  .command("renew-cert")
  .description("reissue this Host's TLS leaf for every address it has (a running daemon swaps it in place)")
  .option("--san <name>", "also name this address or DNS name (kept in security.tls.sans); repeatable", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .action(async (o: { san: string[] }) => {
    const cfg = loadConfig();
    const tls = readTlsConfig(cfg);
    if (tls.mode !== "tls") throw new Error("TLS is off (security.mode: plaintext); set security.mode: tls and restart first");
    // Extra names are remembered, so the next automatic renewal keeps them (#91).
    const added = o.san.map((s) => s.trim()).filter((s) => s && !cfg.security.tls.sans.includes(s));
    if (added.length) {
      cfg.security.tls.sans = [...cfg.security.tls.sans, ...added];
      saveConfig(cfg, cafeHome());
    }
    const sans = sanList({ host: cfg.host, advertise: cfg.advertise, lan: localAddresses(), extra: cfg.security.tls.sans });
    if (await healthy()) {
      // The running daemon reissues in place and swaps the leaf for new connections; on a child it
      // asks the Root for the leaf.
      const r = await api<{ fingerprint256: string }>("/api/tls/renew", { method: "POST", body: JSON.stringify({ sans, extra: cfg.security.tls.sans }) });
      out(`reissued leaf for ${cfg.host} naming ${sans.join(", ")} (fingerprint ${r.fingerprint256}); new connections use it, no restart needed`, { ...r, sans });
      return;
    }
    const caPath = tls.ca ?? tlsPaths(cafeHome(), cfg.host).caPath;
    const caKeyPath = caPath.endsWith(".crt") ? `${caPath.slice(0, -4)}.key` : `${caPath}.key`;
    if (!existsSync(caPath)) throw new Error(`no CA at ${caPath}; copy the Root's ca.crt here (\`cafe root show\` on the Root prints it) and start the daemon once`);
    const ca = { cert: readFileSync(caPath, "utf8"), key: existsSync(caKeyPath) ? readFileSync(caKeyPath, "utf8") : "", fingerprint256: fingerprintOf(readFileSync(caPath, "utf8")) };
    if (!ca.key) {
      throw new Error(
        `this Host has no CA key (only the Root signs certificates) and its daemon is not running; start it (cafe daemon start) — it asks the Root for a leaf naming ${sans.join(", ")}`,
      );
    }
    // Re-sign the key that is already on disk. A fresh key would change this Host's identity, and a
    // peer that pinned the old key would then refuse it — fail-closed, with no way back but a manual
    // `cafe host pin --clear` on every peer.
    const leaf = await issueLeaf(ca, sans, 90, readLeaf(cafeHome(), cfg.host)?.key);
    writeLeaf(cafeHome(), cfg.host, { cert: leaf.cert, key: leaf.key || readLeaf(cafeHome(), cfg.host)?.key || "" });
    out(`reissued leaf for ${cfg.host} naming ${sans.join(", ")} (fingerprint ${leaf.fingerprint256}); written to ${tlsPaths(cafeHome(), cfg.host).leafCertPath}`, { ...leaf, key: undefined, sans });
  });
daemon
  .command("drain")
  .description("stop accepting new Orders and wait for open ones (for a controlled update); stays drained until restart")
  .option("--timeout <s>", "how long to wait for open Orders", Number, 30)
  .action(async (o) => {
    await ensureDaemon();
    const r = await api<{ waitedMs: number; openThreads: number; retryable: string[] }>("/api/drain", {
      method: "POST",
      body: JSON.stringify({ timeoutMs: Math.max(0, o.timeout) * 1000 }),
    });
    out(
      `drained in ${r.waitedMs}ms; ${r.openThreads} open thread(s)${r.retryable.length ? `; retryable: ${r.retryable.join(", ")}` : ""}\nnext: cafe daemon restart (or cafe update apply) to accept Orders again`,
      r,
    );
  });
daemon
  .command("rename")
  .argument("<host>")
  .argument("<name>")
  .description("Root: change another Daemon's display name (works while it is offline)")
  .action(async (hostName: string, name: string) => {
    const rec = await api<DaemonRecord>("/api/hosts/rename", { method: "POST", body: JSON.stringify({ host: hostName, displayName: name }) });
    out(`renamed ${rec.host} to ${rec.displayName}`, rec);
  });
daemon
  .command("install")
  .description("start the daemon at login and restart it if it crashes (launchd on macOS, systemd --user on Linux)")
  .option("--root", "run as the Root Daemon (persisted to config)")
  .option("--dry-run", "print the service file and commands without installing")
  .action(async (o) => {
    // After a controlled update, `current` is the release the service should run;
    // before any update there is no `current`, so use this CLI's own entry.
    const currentBin = join(cafeHome(), "current", "bin", "cafe.js");
    const f = serviceFile({
      platform: process.platform,
      node: process.execPath,
      bin: existsSync(currentBin) ? currentBin : join(here, "..", "bin", "cafe.js"),
      cafeHome: cafeHome(),
      path: servicePath(process.env.PATH),
    });
    if (o.dryRun) return out(`# ${f.file}\n${f.content}\n# then: ${f.load.map((c) => c.join(" ")).join(" && ")}`, f);
    if (o.root) setConfigValue("mode", "root");
    // A daemon started by hand would hold the lock; hand over to the service.
    if (await healthy()) {
      await api("/api/shutdown", { method: "POST" });
      for (let i = 0; i < 50 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 100));
    }
    installService(f);
    for (let i = 0; i < 50 && !(await healthy()); i++) await new Promise((r) => setTimeout(r, 100));
    out(`installed ${f.file}; daemon ${(await healthy()) ? "running" : "not answering yet, see ~/.cafe/daemon.log"}`, { file: f.file });
  });
daemon
  .command("uninstall")
  .description("stop starting the daemon at login (also stops it)")
  .action(() => {
    const f = serviceFile({ platform: process.platform, node: process.execPath, bin: "", cafeHome: cafeHome(), path: "" });
    out(uninstallService(f) ? `removed ${f.file}` : "autostart was not installed", { file: f.file });
  });
daemon
  .command("status")
  .description("show daemon status")
  .action(async () => {
    if (!(await healthy())) return out("cafe daemon is not running", { running: false });
    const s = await api("/api/snapshot");
    const h = await api("/api/health");
    const cfg = await api<{ pending?: { key: string; file: unknown; running: unknown; mode: "hot" | "restart-required" }[] }>("/api/config");
    const pending = cfg.pending ?? [];
    const settings = await api<{ web?: { https: string[] } }>("/api/settings").catch(() => ({}) as { web?: { https: string[] } });
    const fmt = (v: unknown) => (v === undefined ? "(not set)" : typeof v === "string" ? v : JSON.stringify(v));
    out(
      [
        `host:      ${s.host}${s.isRoot ? " (root)" : ""}`,
        `mode:      ${s.isRoot ? "root" : "daemon"}`,
        `version:   ${h.version ?? "unknown"}`,
        `url:       ${base()}`,
        `web:       ${webLine(base(), settings.web?.https)}`,
        `advertise: ${loadConfig().advertise ?? "(not set; other machines use any local address)"}`,
        `root:      ${s.isRoot ? "self" : rootLine(h)}`,
        `tls:       ${tlsLine(h.tls)}`,
        `router:    ${h.routerLoading ? "loading (Orders wait for it)" : `${h.router}${h.model ? ` (${h.model})` : ""}`}`,
        `agents:    ${s.agents.length} (registry v${s.registryVersion})`,
        `threads:   ${s.threads.length}`,
        ...(pending.length
          ? [`pending:   ${pending.map((p) => `${p.key}: ${fmt(p.running)} -> ${fmt(p.file)} (${p.mode})`).join(", ")}; ${pending.some((p) => p.mode === "hot") ? "run `cafe config apply` and/or `cafe daemon restart`" : "run `cafe daemon restart`"}`]
          : []),
        ...versionLines(s.daemons),
      ].join("\n"),
      { running: true, ...s, threads: s.threads.length, routerModel: h.model, routerError: h.error, pendingConfig: pending },
    );
  });

program
  .command("ask")
  .description("send an Order and wait for replies")
  .argument("<body...>", "the question or task")
  .option("--to <address>", "explicit Address (name, name@host, name#n@host); skips routing")
  .option("--broadcast", "ask every eligible Barista (skips routing; only when you mean it)")
  .option("--thread <threadId>", "follow-up in an existing thread (goes to whoever answered there)")
  .option("--parent <orderId>", "the Order this question is a sub-Order of")
  .option("--parent-thread <threadId>", "the Thread holding --parent (needed when it is no longer in memory)")
  .option("--escalate", "with --parent: ask the parent Order's sender (creates a sub-thread; skips routing)")
  .option("--channel <name>", "message scope (default: this agent's home channel, else default)")
  .option("--collect <mode>", "any (first answer wins) or all (wait for every target)", "any")
  .option("--replace", "with --thread: cancel the thread's still-open question and ask this one instead")
  .option("--async", "return the thread id immediately")
  .option("--notice", "send a Notice (no reply expected)")
  .option("--deadline <ms>", "broadcast collection deadline", Number)
  .option("--timeout <s>", "stop waiting after this many seconds and cancel the question (0 = no limit)", Number, 0)
  .option("--as <name>", "customer name shown to others", "cli")
  .option("--origin <kind>", "human (default) or agent: who actually asked", "human")
  .option("--via <address>", "with --origin agent: the Agent relaying the request")
  .option("--attach <file>", "attach a file (repeatable; uploaded before the Order)", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .action(async (words: string[], o) => {
    if (o.origin !== "human" && o.origin !== "agent") throw new Error("--origin must be human or agent");
    await ensureDaemon();
    const attachments = [];
    for (const file of o.attach as string[]) attachments.push(await uploadAttachment(file));
    const res = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        body: words.join(" "),
        to: o.to,
        broadcast: o.broadcast || undefined,
        threadId: o.thread,
        ...(o.parent ? { parentOrderId: o.parent } : {}),
        ...(o.parentThread ? { parentThreadId: o.parentThread } : {}),
        ...(o.escalate ? { escalate: true } : {}),
        ...(o.channel ? { channel: o.channel } : {}),
        ...(o.collect !== "any" ? { collect: o.collect } : {}),
        kind: o.notice ? "notice" : "order",
        deadlineMs: o.deadline,
        ...(o.replace ? { replace: true } : {}),
        as: o.as,
        origin: o.origin,
        ...(o.via ? { via: { address: o.via } } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    if (res.decision?.targets?.length === 0) {
      // An immediate routing failure is not "thread created"; say so and exit non-zero (#39 review).
      throw new Error(`not delivered${res.decision.failure ? ` (${res.decision.failure})` : ""}: ${res.decision.reason}`);
    }
    if (o.async || o.notice) return out(`thread ${res.threadId} (order ${res.orderId}) → ${res.decision?.mode ?? "?"}: ${res.decision?.reason ?? ""}`, res);
    if (!JSON_OUT) console.log(`thread ${res.threadId}`);
    const status = await follow(res.threadId, { orderId: res.orderId, ...(o.timeout > 0 ? { timeoutMs: o.timeout * 1000 } : {}) });
    process.exitCode = status === "done" ? 0 : 1;
  });

program
  .command("wait")
  .description("follow a thread until it closes")
  .argument("<threadId>")
  .action(async (id: string) => {
    const status = await follow(id);
    process.exitCode = status === "done" ? 0 : 1;
  });

program
  .command("reply")
  .description("reply to an open Order as one of its target Baristas (for scripts and external processes)")
  .argument("<threadId>")
  .argument("<text...>", "the reply text")
  .requiredOption("--agent <address>", "the target Barista's address (name@host)")
  .option("--order <orderId>", "a specific Order in the Thread (default: the open one)")
  .option("--interim", "send a non-final reply; the Order stays open")
  .option("--attach <file>", "attach a file (repeatable; uploaded before the reply)", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .action(async (id: string, words: string[], o) => {
    await ensureDaemon();
    const attachments = [];
    for (const file of o.attach as string[]) attachments.push(await uploadAttachment(file));
    const res = await api(`/api/threads/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({
        agent: o.agent,
        orderId: o.order,
        text: words.join(" "),
        final: !o.interim,
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    out(`replied to ${id}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}`, res);
  });

program
  .command("tail")
  .description("follow routed / delivered / acked / replied / closed events across the network")
  .option("--host <host>", "only events originating on this Host")
  .option("--type <types>", "comma-separated event types, e.g. order.routed,order.replied")
  .option("--thread <threadId>", "only this Thread")
  .option("--verbose", "include heartbeats")
  .action(async (o) => {
    await ensureDaemon();
    const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
    const params = new URLSearchParams();
    if (o.host) params.set("host", o.host);
    if (o.type) params.set("type", o.type);
    if (o.thread) params.set("thread", o.thread);
    if (o.verbose) params.set("verbose", "1");
    let lastId: string | undefined;
    for (;;) {
      const headers: Record<string, string> = {};
      if (process.env.CAFE_TOKEN) headers.authorization = `Bearer ${process.env.CAFE_TOKEN}`;
      // Ask the daemon to replay what we missed after a dropped connection.
      if (lastId) headers["last-event-id"] = lastId;
      let res: Response;
      try {
        res = await fetch(`${base()}/api/events?${params}`, { headers });
      } catch {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      if (!res.ok || !res.body) {
        if (res.status === 401) throw new Error(`cannot stream events: ${res.status}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = block.split("\n").find((l) => l.startsWith("id: "));
          if (id) lastId = id.slice(4);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const env = JSON.parse(data.slice(6)) as ThreadEnvelope;
          if (JSON_OUT) {
            console.log(JSON.stringify(env));
            continue;
          }
          const line = describe(env, agents);
          if (line) console.log(`${time(env.at)} ${env.threadId.slice(-6)} ${line}`);
        }
      }
      // The stream ended (daemon restart or network drop): reconnect with the last id.
      await new Promise((r) => setTimeout(r, 400));
    }
  });

program
  .command("cancel")
  .description("cancel an active thread you started")
  .argument("<threadId>")
  .action(async (id: string) => out(`cancelled ${id}`, await api(`/api/threads/${id}/cancel`, { method: "POST" })));

/** User-added aliases only (legacy names and the stable id are not display candidates). */
function explicitAliases(aliases: string[] | undefined, hide: Array<string | undefined>): string[] {
  const blocked = new Set(hide.filter(Boolean) as string[]);
  return (aliases ?? []).filter((a) => a && !blocked.has(a));
}

/** `name#n@<host label>`: stable name/ordinal, current Host label (alias-first). */
function displayAddress(a: AgentRecord, daemons: DaemonRecord[]): string {
  const d = daemons.find((x) => x.host === a.host);
  const host = d ? (explicitAliases(d.aliases, [d.host, d.displayName]).at(-1) ?? d.displayName ?? d.host) : a.host;
  const at = a.address.indexOf("@");
  const namePart = at >= 0 ? a.address.slice(0, at) : a.name;
  return `${namePart}@${host}`;
}

program
  .command("agents")
  .description("list registered agents")
  .action(async () => {
    await ensureDaemon();
    const [list, snap] = await Promise.all([api<AgentRecord[]>("/api/agents"), api<{ daemons: DaemonRecord[] }>("/api/snapshot")]);
    const lines = list
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((a) => `${a.status.padEnd(7)} ${a.role.padEnd(8)} ${runsAs(a).padEnd(12)} ${displayAddress(a, snap.daemons).padEnd(28)} ${a.description}${a.scope.length ? ` [${a.scope.join(", ")}]` : ""}`);
    out(lines.join("\n") || "(no agents)", list);
  });

/** Short "what runs it" column for `cafe agents`: the agent kind (pi, omp, codex, claude, command), `·tui` when
 * someone is using it in a terminal (`·bg` when that session runs in the background with no terminal),
 * `·ro` / `·rw` for Bridges. Falls back to the mode for agents that do not report a kind. */
function runsAs(a: Pick<AgentRecord, "mode" | "agent" | "access" | "background">): string {
  if (!a.agent) return a.mode;
  return [a.agent, a.mode === "tui" ? (a.background ? "bg" : "tui") : undefined, a.access === "read-only" ? "ro" : a.access === "write" ? "rw" : undefined].filter(Boolean).join("·");
}

const printThreads = (list: ThreadMeta[], agents: Map<string, AgentRecord>) =>
  list
    .map((t) => `${t.status.padEnd(9)} ${t.threadId}  ${time(t.createdAt)}  ${(t.channel ?? "default") === "default" ? "" : `#${t.channel} `}${t.from.address} → ${t.targets.map((id) => agents.get(id)?.address ?? id).join(",") || "-"}  ${t.summary.replace(/\s+/g, " ").slice(0, 60)}`)
    .join("\n") || "(no threads)";

program
  .command("channel")
  .description("channel-scoped views (v4-11)")
  .addCommand(
    new Command("list")
      .description("list channels with Thread counts and teams")
      .action(async () => {
        await ensureDaemon();
        const list = await api<{ name: string; threads: number; teams: { team: string; host: string }[] }[]>("/api/channels");
        out(
          list.map((c) => `#${c.name.padEnd(24)} ${String(c.threads).padStart(4)} thread(s)${c.teams.length ? `  teams: ${c.teams.map((t) => `${t.team}@${t.host}`).join(", ")}` : ""}`).join("\n") || "(no channels)",
          list,
        );
      }),
  )
  .addCommand(
    new Command("threads")
      .argument("<name>")
      .option("--after <ms>", "only Threads with activity after this timestamp", Number)
      .option("--limit <n>", "", Number, 30)
      .action(async (name: string, o) => {
        await ensureDaemon();
        const q = new URLSearchParams({ limit: String(o.limit), ...(o.after ? { after: String(o.after) } : {}) });
        const res = await api<{ threads: ThreadMeta[]; hasMore: boolean; exists: boolean }>(`/api/channels/${encodeURIComponent(name)}/threads?${q}`);
        if (!res.exists) return out(`channel #${name}: no Threads and no team uses it`, res);
        const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
        out(printThreads(res.threads, agents) + (res.hasMore ? "\n(older Threads remain; page with --after/--limit)" : ""), res);
      }),
  );

program
  .command("stats")
  .description("how each barista did in the last 7 days (used as a weak routing hint)")
  .action(async () => {
    await ensureDaemon();
    const { learn, hints } = await api<{ learn: boolean; hints: Record<string, RoutingHint> }>("/api/routing/hints");
    const routing = await api<RoutingStats>("/api/routing/stats");
    const rows = Object.values(hints).sort((a, b) => b.answered + b.declined - (a.answered + a.declined) || a.identity.localeCompare(b.identity));
    const lines = rows.map((h) => {
      const topics = Object.keys(h.declinedTopics).slice(0, 6).join(", ");
      return `${h.identity.padEnd(28)} answered ${String(h.answered).padStart(3)}  declined ${String(h.declined).padStart(3)}  failed ${String(h.failed).padStart(3)}${topics ? `  declined topics: ${topics}` : ""}`;
    });
    const footer = learn ? "" : "\n(router.learn is off: routing ignores this history)";
    out((lines.join("\n") || "(no answers or declines in the last 7 days)") + footer + `\n\n${formatRoutingStats(routing)}`, { learn, hints, routing });
  });

program
  .command("search")
  .description("find past questions and answers containing some text")
  .argument("<text...>")
  .option("--limit <n>", "max threads", Number, 20)
  .action(async (words: string[], o) => {
    await ensureDaemon();
    const q = words.join(" ");
    const found = await api<{ meta: ThreadMeta; hits: { who: string; text: string; at: number }[] }[]>(`/api/search?${new URLSearchParams({ q, limit: String(o.limit) })}`);
    const lines = found.flatMap((f) => [
      `${f.meta.threadId}  ${time(f.meta.createdAt)}  ${f.meta.summary.replace(/\s+/g, " ").slice(0, 70)}`,
      ...f.hits.slice(0, 3).map((h) => `    ${h.who}: ${h.text.replace(/\s+/g, " ")}`),
    ]);
    out(lines.join("\n") || `(nothing matches "${q}")`, found);
  });

program
  .command("prune")
  .description("delete finished threads and stats older than N days (shows what would go unless --yes)")
  .requiredOption("--older-than <days>", "age in days", Number)
  .option("--yes", "really delete")
  .action(async (o) => {
    await ensureDaemon();
    const r = await api<{ dryRun: boolean; threads: number; bytes: number; agentEvents: number; oldest?: number }>("/api/prune", {
      method: "POST",
      body: JSON.stringify({ olderThanDays: o.olderThan, dryRun: !o.yes }),
    });
    const what = `${r.threads} finished thread(s) (${(r.bytes / 1024).toFixed(1)} KiB${r.oldest ? `, oldest ${new Date(r.oldest).toLocaleDateString()}` : ""}) and ${r.agentEvents} stat row(s) older than ${o.olderThan} day(s)`;
    out(r.dryRun ? `would delete ${what}\nrun again with --yes to delete` : `deleted ${what}`, r);
  });

program
  .command("threads")
  .description("list recent threads")
  .option("--status <status>")
  .option("--channel <name>", "only this channel")
  .option("--limit <n>", "", Number, 30)
  .action(async (o) => {
    await ensureDaemon();
    const q = new URLSearchParams({ limit: String(o.limit), ...(o.status ? { status: o.status } : {}), ...(o.channel ? { channel: o.channel } : {}) });
    const list = await api<ThreadMeta[]>(`/api/threads?${q}`);
    const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
    out(printThreads(list, agents), list);
  });

program
  .command("inbox")
  .description("threads started from the CLI and their status")
  .option("--as <name>", "customer name", "cli")
  .action(async (o) => {
    await ensureDaemon();
    const list = (await api<ThreadMeta[]>("/api/threads?limit=200")).filter((t) => t.from.address.startsWith(`${o.as}@`));
    const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
    out(printThreads(list, agents), list);
  });

program
  .command("thread")
  .description("show a thread's full event log, or download one of its attachments")
  .argument("<threadId>")
  .option("--download <attachmentId>", "download this attachment")
  .option("--out <dir>", "download directory", ".")
  .action(async (id: string, o) => {
    if (o.download) {
      const headers: Record<string, string> = {};
      if (process.env.CAFE_TOKEN) headers.authorization = `Bearer ${process.env.CAFE_TOKEN}`;
      const res = await fetch(`${base()}/api/artifacts/${encodeURIComponent(o.download)}`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`download failed: ${formatApiError(body, res.status)}`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = res.headers.get("x-cafe-sha256");
      if (sha && createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("downloaded file failed its sha256 check");
      const cd = res.headers.get("content-disposition") ?? "";
      const name = (/filename="([^"]+)"/.exec(cd)?.[1] ?? `${o.download}.bin`).replace(/[/\\]/g, "_");
      const dir = resolve(o.out);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, basename(name));
      writeFileSync(path, bytes);
      out(`downloaded ${path} (${bytes.length} bytes${sha ? `, sha256 ${sha}` : ""})`, { path, size: bytes.length, sha256: sha });
      return;
    }
    const t = await api<{ meta: ThreadMeta; events: ThreadEnvelope[] }>(`/api/threads/${id}`);
    const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
    const att = t.meta.attachments?.map((a) => `📎 ${a.name} (${a.size} bytes, id ${a.id})`) ?? [];
    const lines = [`${t.meta.from.address}: ${t.meta.summary}`, ...((t.meta.channel ?? "default") !== "default" ? [`channel: #${t.meta.channel}`] : []), ...att, ...t.events.map((e) => describe(e, agents)).filter(Boolean)];
    out(lines.join("\n"), t);
  });

program
  .command("connect")
  .argument("<host:port>")
  .description("join another machine's Root: saves mode, root and token")
  .option("--token <token>", "the Root's token (cafe config get token on the Root)")
  .option("--ca-fingerprint <sha256>", "the Root's CA fingerprint (`cafe root show` on the Root); pins the trust anchor")
  .action((addr: string, o) => {
    if (!o.token) throw new Error("--token is required (cafe config get token on the Root)");
    const clean = assertDaemonAddress(addr);
    // Validate the pin before writing anything: a bad pin must not leave a half-configured Host.
    let pin: string | undefined;
    if (o.caFingerprint !== undefined) {
      pin = normalizeFingerprint(String(o.caFingerprint));
      if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(pin)) {
        throw new Error("--ca-fingerprint must be a SHA-256 fingerprint (64 hex digits, e.g. from `cafe root show` on the Root)");
      }
    }
    setConfigValue("mode", "daemon");
    setConfigValue("root", clean);
    setConfigValue("token", o.token);
    if (pin) setConfigValue("security.tls.caFingerprint", pin);
    out(
      `saved root ${clean}${pin ? ` with CA pin ${pin}` : ""}; restart required: cafe daemon restart`,
      { mode: "daemon", root: clean, restartRequired: true, ...(pin ? { caFingerprint: pin } : {}) },
    );
  });

const host = program.command("host").description("this Host's display name and aliases (internal ids and Addresses stay stable)");
host
  .command("rename")
  .argument("<name>")
  .description("change the name shown in the UI and CLI (hot; no restart)")
  .action(async (name: string) => {
    if (await healthy()) {
      const rec = await api<DaemonRecord>("/api/host", { method: "POST", body: JSON.stringify({ displayName: name }) });
      out(`renamed ${rec.host} to ${rec.displayName}`, rec);
    } else {
      setConfigValue("displayName", name);
      out(`${name} (saved; takes effect when the daemon starts)`, { displayName: name });
    }
  });
host
  .command("alias")
  .argument("<alias>")
  .description("add a name that still identifies this Host in addresses")
  .action(async (alias: string) => {
    if (await healthy()) {
      const rec = await api<DaemonRecord>("/api/host", { method: "POST", body: JSON.stringify({ aliases: [alias] }) });
      out(`aliases: ${rec.aliases.join(", ") || "(none)"}`, rec);
    } else {
      const c = loadConfig();
      saveConfig({ ...c, aliases: [...new Set([...c.aliases, alias])] }, cafeHome());
      out(`${alias} (saved; takes effect when the daemon starts)`, { alias });
    }
  });

host
  .command("unalias")
  .argument("<alias>")
  .description("remove a user-added Host alias (legacy names stay routable)")
  .action(async (alias: string) => {
    if (!(await healthy())) throw new Error("cafe daemon is not running");
    const rec = await api<DaemonRecord>("/api/host", { method: "POST", body: JSON.stringify({ removeAliases: [alias] }) });
    out(`aliases: ${rec.aliases.join(", ") || "(none)"}`, rec);
  });

host
  .command("address")
  .argument("<host>")
  .argument("[url]")
  .description("Root only: set (or with --clear, forget) the host:port other Hosts use to reach <host>")
  .option("--clear", "forget the pinned address and go back to what the Host reports")
  .action(async (hostName: string, url: string | undefined, o: { clear?: boolean }) => {
    if (!(await healthy())) throw new Error("cafe daemon is not running");
    if (!o.clear && !url) throw new Error("give a host:port address, or pass --clear");
    const rec = await api<DaemonRecord>("/api/hosts/address", { method: "POST", body: JSON.stringify({ host: hostName, url: o.clear ? null : url }) });
    out(`${rec.host}: ${rec.url || "(no address)"}`, rec);
  });

host
  .command("forget")
  .argument("<host>")
  .description("Root only: remove an offline machine and its agents from the network (conversations are kept; it reappears if it connects again)")
  .action(async (hostName: string) => {
    if (!(await healthy())) throw new Error("cafe daemon is not running");
    const r = await api<{ host: string; agents: number; config: string[] }>("/api/hosts/forget", { method: "POST", body: JSON.stringify({ host: hostName }) });
    out(
      `removed ${r.host} (${r.agents} agent${r.agents === 1 ? "" : "s"}); conversations are kept, and it reappears if it connects again.\n` +
        "to keep it out for good, change the network token (cafe config set token <new>); every machine then reconnects with it",
      r,
    );
  });

host
  .command("pin")
  .argument("[peer]")
  .description("list the per-peer leaf-key pins another Host is held to (host:port); with --clear, forget one")
  .option("--clear", "forget this peer's pin so the next connection pins its current key (TOFU again)")
  .action(async (peer: string | undefined, o: { clear?: boolean }) => {
    const pins = loadConfig().security.tls.pins;
    if (!peer) {
      const rows = Object.entries(pins);
      out(rows.length ? rows.map(([k, v]) => `${k}  ${v}`).join("\n") : "(no peer pins yet; each is recorded on first contact)", rows);
      if (o.clear) throw new Error("name the peer to clear (e.g. cafe host pin hub:4778 --clear)");
      return;
    }
    if (!o.clear) {
      const v = pins[peer];
      out(v ? `${peer}  ${v}` : `${peer} is not pinned`, { peer, pin: v ?? null });
      return;
    }
    // A running daemon reads the pins from its own config object, so it must clear them in memory too;
    // otherwise the next connection would still compare against the stale pin until a restart.
    if (await healthy()) {
      await api("/api/tls/pins", { method: "POST", body: JSON.stringify({ peer, clear: true }) });
    }
    if (peer in pins) {
      const next = loadConfig();
      delete next.security.tls.pins[peer];
      saveConfig(next, cafeHome());
    }
    out(`cleared the pin for ${peer}; the next connection pins its current key`, { peer, cleared: true });
  });

const agent = program.command("agent").description("display names and aliases for Agents (agentId and Address stay stable)");
agent
  .command("rename")
  .argument("<address>")
  .argument("<name>")
  .description("change an Agent's display name; the old name keeps resolving")
  .action(async (address: string, name: string) => {
    const rec = await api<AgentRecord>("/api/agents/rename", { method: "POST", body: JSON.stringify({ address, displayName: name }) });
    out(`${rec.address} is now ${rec.displayName}`, rec);
  });
agent
  .command("alias")
  .argument("<address>")
  .argument("<alias>")
  .description("add another name that resolves to this Agent")
  .action(async (address: string, alias: string) => {
    const rec = await api<AgentRecord>("/api/agents/rename", { method: "POST", body: JSON.stringify({ address, alias }) });
    out(`aliases: ${rec.aliases.join(", ") || "(none)"}`, rec);
  });
agent
  .command("unalias")
  .argument("<address>")
  .argument("<alias>")
  .description("remove a user-added Agent alias (legacy names stay routable)")
  .action(async (address: string, alias: string) => {
    const rec = await api<AgentRecord>("/api/agents/rename", { method: "POST", body: JSON.stringify({ address, removeAlias: alias }) });
    out(`aliases: ${rec.aliases.join(", ") || "(none)"}`, rec);
  });

const root = program.command("root").description("Root Daemon address");
root
  .command("set")
  .argument("<host:port>")
  .description("point this daemon at a (moved) Root; updates config.yml and the live connection")
  .action(async (addr: string) => {
    // Validate before writing: a bad address used to land in config.yml first and only the live API
    // (when one was running) refused it, leaving a stopped daemon pointed at an unparsable Root (#76).
    const clean = assertDaemonAddress(addr);
    setConfigValue("root", clean);
    if (await healthy()) await api("/api/root", { method: "POST", body: JSON.stringify({ root: clean }) });
    out(`root set to ${clean}`, { root: clean });
  });
root
  .command("discover")
  .description("look for Root Daemons on the local network (mDNS)")
  .option("--timeout <ms>", "how long to listen", Number, 2000)
  .action(async (o) => {
    const found = await discoverRoots(o.timeout);
    out(
      found.length ? found.map((r) => `${r.host.padEnd(20)} ${r.addr}    cafe root set ${r.addr}`).join("\n") : "(no root found on the local network)",
      found,
    );
  });
root
  .command("show")
  .description("print the Root this Daemon uses and the TLS CA fingerprint to enrol other Hosts")
  .action(() => {
    const c = loadConfig();
    const tls = readTlsConfig(c);
    const caPath = tls.ca ?? join(cafeHome(), "tls", "ca.crt");
    const haveCa = existsSync(caPath);
    const where = c.mode === "root" ? "this host is the root" : (c.root ?? "(no root configured)");
    if (!haveCa && tls.mode === "tls" && tls.caFingerprint) {
      // A child that has not joined yet: the fingerprint it will accept is the one to compare with the
      // Root's `cafe root show` (doctor's "compare the CA fingerprint", #94).
      out(`${where}\nsha256:${tls.caFingerprint} (expected; this Host has not joined the network yet, so it has no CA — compare with \`cafe root show\` on the Root)`, {
        mode: c.mode,
        root: c.root,
        security: tls.mode,
        ca: null,
        expectedFingerprint: tls.caFingerprint,
      });
      return;
    }
    if (!haveCa) {
      out(`${where}\nsha256: (no CA on this Host — TLS is ${tls.mode}${tls.mode === "tls" ? " but the CA is not written yet; start the daemon once" : ""})`, {
        mode: c.mode,
        root: c.root,
        security: tls.mode,
        ca: null,
      });
      return;
    }
    const fingerprint = fingerprintOf(readFileSync(caPath, "utf8"));
    // On the Root: the command another machine runs to join (the token is read here, never printed).
    // Every candidate address unless `advertise` pins one (#95).
    const joinInfo = c.mode === "root" ? joinText({ ...joinAddresses({ advertise: c.advertise, port: c.port, lan: localAddresses() }), fingerprint }) : undefined;
    const howTo = joinInfo ? `\n${joinInfo.text}` : "";
    out(`${where}\nsha256:${fingerprint}${howTo}`, {
      mode: c.mode,
      root: c.root,
      security: tls.mode,
      ca: caPath,
      fingerprint256: fingerprint,
      ...(joinInfo ? { join: joinInfo.commands[0], joinCommands: joinInfo.commands } : {}),
    });
  });
root
  .command("test")
  .description("do a token-authenticated handshake with the configured Root")
  .action(async () => {
    const c = loadConfig();
    if (!c.root) throw new Error("no root configured; use `cafe root discover` or `cafe connect <host:port> --token <token>`");
    const tls = readTlsConfig(c);
    try {
      // A TLS Root is reached over https; the CA is applied so the probe verifies rather than skips.
      if (tls.mode === "tls" && tls.caFingerprint) {
        const caPath = tls.ca ?? join(cafeHome(), "tls", "ca.crt");
        if (existsSync(caPath)) trustCaForClient(readFileSync(caPath, "utf8"));
      }
      const res = await fetch(`${daemonHttpUrl(c.root, { tls: tls.mode === "tls" })}/api/health`, {
        headers: { authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 401) throw new Error("unauthorized: the token differs from the Root's (`cafe config get token` on both hosts)");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info: any = await res.json();
      out(`root ${c.root} online (${info.host}${info.isRoot ? ", root" : ""}${info.version ? `, cafe ${info.version}` : ""})`, info);
    } catch (err) {
      throw new Error(`root ${c.root}: ${(err as Error).message}`);
    }
  });

const config = program.command("config").description("~/.cafe/config.yml");
config
  .command("get")
  .argument("[key]")
  .option("--reveal", "with no key: print the whole file, including the token")
  .description("print one value (no key: the whole file, token redacted); an unset value prints (not set)")
  .action((key: string | undefined, o: { reveal?: boolean }) => {
    const c = loadConfig() as Record<string, any>;
    if (!key) {
      // The token is a full-access credential: showing the whole config must not leak it by default.
      const shown = o.reveal ? c : { ...c, ...(typeof c.token === "string" ? { token: "<redacted; `cafe config get token` or --reveal to show>" } : {}) };
      out(JSON.stringify(shown, null, 2), shown);
      return;
    }
    assertConfigKey(key);
    const v = configKeyPath(key).reduce((o, k) => o?.[k], c);
    if (v === undefined) {
      out("(not set)", null);
      return;
    }
    out(typeof v === "string" ? v : JSON.stringify(v, null, 2), v);
  });
config
  .command("set")
  .argument("<key>")
  .argument("<value>")
  .description("set a value (e.g. router.model anthropic/claude-haiku-4-5) and reload the running daemon")
  .action(async (key: string, value: string) => {
    const r = await setAndApply(key, value);
    out(r.human, r.data);
  });
config
  .command("diff")
  .description("compare config.yml with the running daemon; mark each change hot or restart-required")
  .action(async () => {
    const file = loadConfig();
    if (!(await healthy())) {
      out("daemon is not running; config.yml will be used on the next start", { running: false });
      return;
    }
    const running = await api<any>("/api/config");
    const rows = diffConfig(file, running);
    if (!rows.length) {
      out("no differences: the running daemon uses config.yml", rows);
      return;
    }
    const fmt = (v: unknown) => (v === undefined ? "(not set)" : typeof v === "string" ? v : JSON.stringify(v));
    out(rows.map((r) => `${r.key}: ${fmt(r.file)} -> ${fmt(r.running)} (${r.mode})`).join("\n"), rows);
  });
config
  .command("apply")
  .description("apply hot changes (router/root) to the running daemon and list what still needs a restart")
  .action(async () => {
    if (!(await healthy())) throw new Error("daemon is not running; start it with `cafe daemon start`");
    const res = await api<any>("/api/reload", { method: "POST" });
    const running = await api<any>("/api/config");
    const pending = diffConfig(loadConfig(), running).filter((r) => r.mode === "restart-required");
    const lines = [`router: ${res.router}${res.model ? ` (${res.model})` : ""}`];
    lines.push(pending.length ? `restart required for: ${pending.map((r) => r.key).join(", ")}; run \`cafe daemon restart\`` : "no restart-required changes");
    out(lines.join("\n"), { ...res, pending });
  });

const router = program.command("router").description("LLM routing: pick a model and see what is actually running");
router
  .command("models")
  .argument("[search]")
  .description("list the provider/model ids pi knows (optionally filtered)")
  .action(async (search?: string) => {
    const models = await listRouterModels(search);
    out(models.join("\n") || "(no models found)", models);
  });
router
  .command("set")
  .argument("<model>")
  .description("validate and apply a model; a failure leaves the old router in place")
  .action(async (model: string) => {
    const r = await setAndApply("router.model", model);
    out(r.human, r.data);
  });
router
  .command("status")
  .description("show the configured router and the one actually running")
  .action(async () => {
    const c = loadConfig();
    const running: any = (await healthy()) ? await api("/api/health") : { router: "daemon not running" };
    const lines = [
      `configured: ${c.router.model ? `llm (${c.router.model})` : "rules"}`,
      `running:    ${running.routerLoading ? "loading (Orders wait for it)" : `${running.router}${running.model ? ` (${running.model})` : ""}`}`,
      ...(running.error ? [`last error: ${running.error}`] : []),
    ];
    out(lines.join("\n"), { configured: c.router.model ?? null, running });
  });
router
  .command("apply")
  .description("apply the configured router to the running daemon")
  .action(async () => {
    const res = await api<any>("/api/reload", { method: "POST" });
    out(`router: ${res.router}${res.model ? ` (${res.model})` : ""}${res.error ? `\nlast error: ${res.error}` : ""}`, res);
    if (!res.ok) process.exitCode = 1;
  });

const barista = program.command("barista").description("headless Baristas supervised by the daemon (pi, omp, codex, claude)");
barista
  .command("start")
  .description("start a Barista for a directory and let the daemon supervise it")
  .option("--dir <dir>", "directory to run in (its .cafe defines identity)", process.cwd())
  .option("--member <name>", "start this roster member (reads the team .cafe)")
  .option("--team-dir <dir>", "directory holding the roster .cafe (with --member)")
  .option("--agent <name>", "pi (default), omp (oh-my-pi), codex (codex app-server) or claude (claude -p)")
  .option("--write", "codex / claude only: allow editing files in --dir (default: read-only)")
  .option("--model <model>", "codex / claude only: model to use")
  .option("--tui", "codex only: attach to the Codex TUI session already running in --dir (this command does not open a UI)")
  .option("--thread <id>", "with --tui: the Codex thread to use (required when --dir has more than one idle session)")
  .action(async (o) => {
    const native = BRIDGED_AGENTS.includes(o.agent);
    if ((o.write || o.model) && !native) throw new Error("--write and --model are for --agent codex or claude");
    if (o.tui && o.agent !== "codex") throw new Error("--tui is for --agent codex; for Claude Code run `cafe claude install`");
    if (o.thread && !o.tui) throw new Error("--thread needs --tui");
    if (o.tui && (o.write || o.model)) throw new Error("--tui uses the session's own model and permissions; drop --write / --model");
    await ensureDaemon();
    const dir = resolve(o.dir);
    // A TUI Barista is only useful next to a running Codex session. Check here, where the person is
    // looking, instead of only inside the supervised worker whose error nobody sees (#82). A remote
    // daemon's directory is not on this machine, so only a local daemon is checked here.
    if (o.tui && localDaemon()) {
      const engine = new CodexTuiEngine({ dir, thread: o.thread, access: "read-only" });
      const probe = await engine.probe();
      await engine.close().catch(() => {});
      if (!probe.ok) throw new Error(`cannot start a Codex TUI barista: ${probe.error}\nnext: start codex in ${dir} (or pass --thread <id>) and run this command again`);
    }
    // The daemon accepts only cafe's own agents (#65), so the agent name is what it gets — never a
    // free-form executable path.
    const spec = {
      ...(o.agent ? { agent: o.agent } : {}),
      ...(native && o.write ? { access: "workspace-write" } : {}),
      ...(native && o.model ? { model: o.model } : {}),
      ...(native && o.tui ? { tui: true } : {}),
      ...(native && o.thread ? { thread: o.thread } : {}),
      ...(o.member ? { member: o.member } : {}),
      ...(o.teamDir ? { teamDir: resolve(o.teamDir) } : {}),
    };
    const ws = await api("/api/baristas", { method: "POST", body: JSON.stringify({ dir, ...spec }) });
    const how = o.tui ? " (answers in the running Codex session)" : native ? (o.write ? " (may edit files)" : " (read-only)") : "";
    // A member's cwd is the roster entry's dir, not --dir; that check belongs to `cafe team status`.
    if (o.member) {
      out(`started ${ws.length} worker(s) in ${dir}${how}`, ws);
      return;
    }
    // "started" must mean it came up: wait for it to register, or report how it failed (#82).
    const outcome = await awaitBarista(dir);
    if (outcome.failed) {
      await api(`/api/baristas?dir=${encodeURIComponent(dir)}`, { method: "DELETE" }).catch(() => {});
      throw new Error(`the ${o.agent ?? "pi"} Barista in ${dir} could not start:\n${outcome.failed.lastError ?? "it exited at once"}\nlog: ${outcome.failed.log}`);
    }
    const ready = outcome.agent ? `; registered as ${outcome.agent}` : "; not registered yet (check `cafe barista list` and `cafe agents`)";
    out(`started ${ws.length} ${o.agent ?? "pi"} worker(s) in ${dir}${how}${ready}`, ws);
  });
barista
  .command("stop")
  .description("stop the Baristas supervised for one directory")
  .option("--dir <dir>", "directory whose Baristas should stop", process.cwd())
  .action(async (o) => out("stopped", await api(`/api/baristas?dir=${encodeURIComponent(resolve(o.dir))}`, { method: "DELETE" })));
barista
  .command("list")
  .alias("ls")
  .description("list supervised headless workers (not all agents; see `cafe agents`)")
  .action(async () => {
    const ws = await api<any[]>("/api/baristas");
    if (ws.length) {
      const line = (w: any) => {
        const head = `${w.state ?? (w.running ? "running" : "waiting")} ${String(w.agent ?? "pi").padEnd(6)} pid=${w.pid ?? "-"} restarts=${w.restarts} ${w.dir}#${w.slot}`;
        // A failed or restarting worker says why, in its own words, and where the full log is (#82).
        const why = !w.running && w.lastError ? `\n    ${String(w.lastError).split("\n").join("\n    ")}\n    log: ${w.log}` : "";
        return head + why;
      };
      out(ws.map(line).join("\n"), ws);
      return;
    }
    // A TUI / session-host Agent is registered directly, not supervised: say so instead of a bare (none).
    const registered = await api<any[]>("/api/agents").then((as) => as.filter((a) => a.role === "barista").length).catch(() => 0);
    out(`(no supervised workers)${registered ? `\n${registered} registered barista(s) are connected; run \`cafe agents\` to list them` : ""}`, ws);
  });
const rosterAt = (dir: string, teamDir?: string) => {
  const rosterDir = resolve(teamDir ?? dir);
  const file = join(rosterDir, ".cafe");
  const doc = readCafeFile(file);
  if (!doc.team) throw new Error(`${file} has no team block; add one (see README)`);
  return { rosterDir, team: doc.team };
};

const team = program.command("team").description("agent teams declared in .cafe (v4-11)");
team
  .command("start")
  .argument("[members...]", "only these roster members")
  .option("--dir <dir>", "directory holding the roster .cafe", process.cwd())
  .option("--team-dir <dir>", "same as --dir (explicit roster)")
  .option("--dry-run", "print the plan")
  .option("--force", "start a headless member even if an unowned same-name agent is online")
  .action(async (names: string[], o) => {
    await ensureDaemon();
    const { rosterDir, team: spec } = rosterAt(o.dir, o.teamDir);
    const unknown = names.filter((n) => !spec.members.some((m) => m.name === n));
    if (unknown.length) throw new Error(`unknown member(s): ${unknown.join(", ")}; roster: ${spec.members.map((m) => m.name).join(", ")}`);
    const selected = names.length ? spec.members.filter((m) => names.includes(m.name)) : spec.members;
    const health = await api<{ host: string }>("/api/health");
    const agents = await api<AgentRecord[]>("/api/agents");
    const workers = await api<{ rosterDir?: string; member?: string; state?: string }[]>("/api/baristas");
    // Presence must be local: a same-named member on another Host is not this Host's process.
    const onlineAny = new Set(agents.filter((a) => a.team === spec.name && a.member).map((a) => a.member!));
    const onlineHere = new Set(agents.filter((a) => a.host === health.host && a.team === spec.name && a.member).map((a) => a.member!));
    // A failed worker is not present: `team start` is how the person retries it (v4-11 review).
    const supervised = new Set(workers.filter((w) => w.rosterDir === rosterDir && w.member && w.state !== "failed").map((w) => w.member!));
    const missingHeadless = selected.filter((m) => m.mode !== "tui" && (o.force || (!onlineHere.has(m.name) && !supervised.has(m.name))));
    const missingTui = selected.filter((m) => m.mode === "tui" && !onlineHere.has(m.name));
    const plan = {
      rosterDir,
      team: spec.name,
      channel: spec.channel,
      present: selected.filter((m) => onlineAny.has(m.name) || supervised.has(m.name)).map((m) => m.name),
      start: missingHeadless.map((m) => m.name),
      tui: missingTui.map((m) => m.name),
    };
    if (o.dryRun) return out(JSON.stringify(plan, null, 2), plan);
    // The daemon publishes the roster from disk even when only TUI members remain, so a team that
    // has not registered yet still shows up (and `to: <team>` resolves) (v4-11 review).
    const publish = missingHeadless.length ? missingHeadless : selected;
    if (publish.length) {
      await api("/api/baristas", { method: "POST", body: JSON.stringify({ dir: rosterDir, team: { ...spec, members: publish } }) });
    }
    const lines = [
      `${spec.name} (#${spec.channel}) in ${rosterDir}`,
      `started ${missingHeadless.length} headless member(s)${missingHeadless.length ? `: ${missingHeadless.map((m) => m.name).join(", ")}` : ""}`,
      ...missingTui.map((m) => {
        const dir = resolve(rosterDir, m.dir);
        const runner = m.agent ?? spec.agent ?? "pi";
        return runner === "codex"
          ? `start ${m.name}: cafe barista run --agent codex --tui --dir ${dir} --member ${m.name} --team-dir ${rosterDir}`
          : runner === "claude"
            ? `start ${m.name}: open Claude Code in ${dir} with CAFE_TEAM_MEMBER=${m.name} CAFE_TEAM_DIR=${rosterDir} (the session picks the member up at start)`
            : `start ${m.name}: open ${runner} in ${dir} with CAFE_TEAM_MEMBER=${m.name} CAFE_TEAM_DIR=${rosterDir}, then run /cafe-team ${m.name}`;
      }),
    ];
    out(lines.join("\n"), plan);
  });
team
  .command("status")
  .option("--dir <dir>", "directory holding the roster .cafe", process.cwd())
  .option("--team-dir <dir>", "same as --dir (explicit roster)")
  .action(async (o) => {
    await ensureDaemon();
    const { team: spec } = rosterAt(o.dir, o.teamDir);
    const all = await api<any[]>("/api/teams");
    const local = (await api<{ host: string }>("/api/health")).host;
    const t = all.find((x) => x.team === spec.name && x.host === local) ?? all.find((x) => x.team === spec.name);
    if (!t) return out(`team ${spec.name}: no roster published yet (start a member or run cafe team start)`, null);
    const rows = t.roster.map((m: any) => ({
      member: m.name,
      duty: m.duty ?? "-",
      mode: m.mode,
      dir: m.dir,
      status: m.status ?? "offline",
      address: m.address ?? "-",
      ...(m.observer ? { observer: true } : {}),
      ...(m.currentThread ? { currentThread: m.currentThread } : {}),
    }));
    const lines = rows.map((r: any) => `${r.status.padEnd(8)} ${r.member.padEnd(16)} ${r.duty.padEnd(14)} ${r.mode.padEnd(8)} ${r.address}${r.observer ? " (observer)" : ""}${r.currentThread ? `  thread ${r.currentThread}` : ""}`);
    out([`team ${t.team} (#${t.channel}) on ${t.host}: ${t.online}/${t.total} online, ${t.openThreads} open${t.partial ? " (partial: this Host's view)" : ""}`, ...lines].join("\n"), t);
  });
team
  .command("stop")
  .argument("[members...]")
  .option("--dir <dir>", "directory holding the roster .cafe", process.cwd())
  .option("--team-dir <dir>", "same as --dir (explicit roster)")
  .action(async (names: string[], o) => {
    await ensureDaemon();
    const { rosterDir } = rosterAt(o.dir, o.teamDir);
    let stopped = 0;
    if (names.length) {
      for (const m of names) {
        const r = (await api(`/api/baristas?dir=${encodeURIComponent(rosterDir)}&team=1&member=${encodeURIComponent(m)}`, { method: "DELETE" })) as { stopped: number };
        stopped += r.stopped;
      }
    } else {
      stopped = ((await api(`/api/baristas?dir=${encodeURIComponent(rosterDir)}&team=1`, { method: "DELETE" })) as { stopped: number }).stopped;
    }
    out(`stopped ${stopped} supervised member worker(s); TUI sessions are untouched`, { stopped });
  });
barista
  .command("run")
  .description("run a Codex / Claude Code Barista in the foreground (what `barista start --agent codex|claude` supervises)")
  .requiredOption("--agent <name>", "codex or claude")
  .option("--dir <dir>", "directory whose .cafe gives the identity (and where the agent works)", process.cwd())
  .option("--write", "allow editing files in --dir (default: read-only)")
  .option("--model <model>", "model to use")
  .option("--tui", "codex only: attach to the Codex TUI session already running in --dir (this command does not open a UI)")
  .option("--thread <id>", "with --tui: the Codex thread to use (required when --dir has more than one idle session)")
  .option("--member <name>", "register as this roster member")
  .option("--team-dir <dir>", "directory holding the roster .cafe (with --member)")
  .action(async (o) => {
    if (!BRIDGED_AGENTS.includes(o.agent)) throw new Error(`--agent must be ${BRIDGED_AGENTS.join(" or ")}`);
    if (!process.env.CAFE_DAEMON) await ensureDaemon();
    if (o.member) process.env.CAFE_TEAM_MEMBER = o.member;
    if (o.teamDir) process.env.CAFE_TEAM_DIR = resolve(o.teamDir);
    const { stop } = await runBridge({
      agent: o.agent as AgentKind,
      dir: o.dir,
      daemon: base().replace(/^http:\/\//, ""),
      token: process.env.CAFE_TOKEN,
      access: o.write ? "workspace-write" : "read-only",
      model: o.model,
      tui: !!o.tui,
      thread: o.thread,
    });
    let quitting = false;
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      await stop();
      process.exit(0);
    };
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
  });

program
  .command("session-host", { hidden: true })
  .description("serve Orders to a running interactive session (run by the cafe Claude Code plugin); JSON lines on stdout")
  .requiredOption("--agent <name>", "which agent hosts the session, e.g. claude")
  .option("--dir <dir>", "the session's working directory", process.cwd())
  .option("--pid <pid>", "pid of the session (default: the parent process)")
  .action(async (o) => {
    const send = (m: HostMessage) => {
      try {
        process.stdout.write(JSON.stringify(m) + "\n");
      } catch {
        void quit();
      }
    };
    let stop: (() => Promise<void>) | undefined;
    let quitting = false;
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      await stop?.().catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
    process.stdout.on("error", () => void quit()); // the session went away
    // The session that started us exited (we were re-parented): leave the network.
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) void quit();
    }, 2000).unref();
    if (!process.env.CAFE_DAEMON) await ensureDaemon();
    ({ stop } = await runSessionHost({
      agent: o.agent,
      dir: o.dir,
      daemon: base().replace(/^http:\/\//, ""),
      token: process.env.CAFE_TOKEN,
      pid: o.pid ? Number(o.pid) : parent,
      send,
    }));
  });

const mcp = program
  .command("mcp")
  .description("run cafe as an MCP server on stdio (tools: cafe_agents, cafe_ask, cafe_wait, cafe_cancel)")
  .option("--as <name>", "customer name shown to others (default: the MCP client's name)")
  .action(async (o) => {
    await runMcp({ base: base(), token: process.env.CAFE_TOKEN, ensure: ensureDaemon, as: o.as, version: cafeVersion() });
  });
mcp
  .command("install")
  .description("register `cafe mcp` with Claude Code and/or Codex (user scope)")
  .option("--client <name>", "claude, codex or all", "all")
  .option("--dry-run", "print the commands without running them")
  .action((o) => {
    if (!["claude", "codex", "all"].includes(o.client)) throw new Error("--client must be claude, codex or all");
    const cmds = mcpInstallCommands([process.execPath, join(here, "..", "bin", "cafe.js"), "mcp"]);
    const chosen = (o.client === "all" ? ["claude", "codex"] : [o.client]) as ("claude" | "codex")[];
    const results: { client: string; command: string; status: string }[] = [];
    for (const c of chosen) {
      const cmd = cmds[c];
      const shown = cmd.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
      if (o.dryRun) {
        results.push({ client: c, command: shown, status: "dry-run" });
        continue;
      }
      const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
      const status = r.error ? `skipped: ${cmd[0]} not found` : r.status === 0 ? "added" : `failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`;
      results.push({ client: c, command: shown, status });
    }
    out(results.map((r) => `${r.client}: ${r.status}\n  ${r.command}`).join("\n"), results);
  });

const claudeCmd = program.command("claude").description("the cafe Claude Code plugin: running Claude Code sessions answer questions for their directory's .cafe");
claudeCmd
  .command("install")
  .description("install the cafe plugin into Claude Code (user scope, from a local marketplace in CAFE_HOME)")
  .option("--dry-run", "print what would be written and run")
  .action((o) => {
    const plan = claudePluginPlan(cafeHome(), [process.execPath, join(here, "..", "bin", "cafe.js")]);
    const shown = plan.commands.map((c) => c.join(" "));
    if (o.dryRun) return out([`write ${plan.marketplace} (plugin from ${pluginSource()}, cafe.json argv ${plan.argv.join(" ")})`, ...shown].join("\n"), { ...plan, dryRun: true });
    writeClaudePlugin(plan);
    const results: string[] = [`wrote ${plan.marketplace}`];
    let failed = 0;
    for (const cmd of plan.commands) {
      const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
      const msg = (r.stderr || r.stdout || "").trim().split("\n").at(-1) ?? "";
      if (r.error) throw new Error(`${cmd[0]} not found; install Claude Code first`);
      const ok = r.status === 0 || /already/i.test(msg);
      if (!ok) failed++;
      results.push(`${ok ? (r.status === 0 ? "ok" : "ok (already)") : `failed: ${msg}`}  ${cmd.join(" ")}`);
    }
    if (failed) {
      // `claude plugin ...` failing means the plugin is NOT registered; a bare exit 0 hid that (#55).
      process.exitCode = 1;
      results.push(
        `${failed} of ${plan.commands.length} claude plugin command(s) failed; the plugin is not registered.`,
        "Check `claude plugin list`; if Claude Code itself is broken, reinstall it, then rerun `cafe claude install`.",
      );
    } else {
      results.push("New Claude Code sessions in a directory with a Barista .cafe now answer cafe questions; in open sessions run /reload-plugins. /cafe-barista off pauses a session.");
    }
    out(results.join("\n"), { ...plan, results, failed });
  });
claudeCmd
  .command("uninstall")
  .description("remove the cafe plugin from Claude Code")
  .action(() => {
    const results: string[] = [];
    for (const cmd of [
      ["claude", "plugin", "uninstall", `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`],
      ["claude", "plugin", "marketplace", "remove", CLAUDE_MARKETPLACE],
    ]) {
      const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
      results.push(`${r.status === 0 ? "ok" : `failed: ${(r.stderr || r.stdout || String(r.error)).trim().split("\n").at(-1)}`}  ${cmd.join(" ")}`);
    }
    out(results.join("\n"), results);
  });

program
  .command("serve")
  .description("be a Barista by running a command per question (prompt on stdin, answer on stdout)")
  .option("--exec <cmd>", "shell command; use {prompt_file} to get the prompt as a file instead of stdin")
  .option("--preset <name>", `ready-made command: ${Object.keys(PRESETS).join(", ")} (read-only unless --write)`)
  .option("--dir <dir>", "directory whose .cafe gives the identity (and where the command runs)", process.cwd())
  .option("--write", "with --preset: let the agent edit files in --dir (default: read-only)")
  .option("--timeout <ms>", "kill the command after this long (default: no limit)", Number)
  .action(async (o) => {
    if (o.write && !o.preset) throw new Error("--write is for --preset; a custom --exec command defines its own access");
    const cmd = o.exec ?? (o.preset ? presetCommand(o.preset, !!o.write) : undefined);
    if (!cmd) throw new Error(`pass --exec "<cmd>" or --preset ${Object.keys(PRESETS).join("|")}`);
    await ensureDaemon();
    const { stop } = await serve({ exec: cmd, dir: o.dir, daemon: base().replace(/^http:\/\//, ""), token: process.env.CAFE_TOKEN, timeoutMs: o.timeout });
    const quit = () => {
      stop();
      process.exit(0);
    };
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
  });

program
  .command("pi-extension-path")
  .description("print the path of the cafe pi extension (for `pi -e` / `omp -e` or the extensions list)")
  .action(() => out(defaultExtensionPath(), { path: defaultExtensionPath() }));

const extension = program.command("extension").description("install the cafe extension so new pi / omp sessions load it automatically");
extension
  .command("install")
  .description("add the extension to pi's settings and link it with omp")
  .option("--agent <name>", "pi, omp or all", "all")
  .option("--dry-run", "print what would change without writing")
  .option("--force", "reinstall / relink")
  .action((o) => {
    if (!["pi", "omp", "all"].includes(o.agent)) throw new Error("--agent must be pi, omp or all");
    const source = defaultExtensionPath();
    const chosen = (o.agent === "all" ? ["pi", "omp"] : [o.agent]) as ("pi" | "omp")[];
    const results: string[] = [];
    for (const agent of chosen) {
      if (agent === "pi") {
        const r = installPiExtension(homedir(), source, { dryRun: o.dryRun });
        results.push(`pi: ${r.alreadyInstalled ? "already installed" : o.dryRun ? `would add ${resolve(source)} to ${r.settingsPath}` : `added ${resolve(source)} to ${r.settingsPath}`}`);
      } else {
        const target = extensionPackageDir(source) ?? source;
        const cmd = ompExtensionCommand("install", target, { dryRun: o.dryRun, force: o.force });
        if (o.dryRun) {
          results.push(`omp: would run ${cmd.join(" ")}`);
          continue;
        }
        const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
        results.push(`omp: ${r.error ? "omp not found on PATH" : r.status === 0 ? "installed" : `failed: ${summarizeProcessError(r.stderr ?? "", r.stdout ?? "")}`}`);
      }
    }
    out(results.join("\n"), results);
  });
extension
  .command("status")
  .description("show whether pi / omp load the cafe extension")
  .action(() => {
    const source = defaultExtensionPath();
    const pi = piExtensionState(homedir(), source);
    const omp = ompExtensionState(source);
    const lines = [
      `pi:  ${pi.installed ? "installed" : "not installed"} (${pi.settingsPath})`,
      `omp: ${omp.available ? (omp.installed ? "installed" : "not installed") : `unavailable (${omp.detail})`}`,
      ...(omp.available ? [] : ["     next: run `omp --version`; reinstall @oh-my-pi/pi-coding-agent"]),
    ];
    out(lines.join("\n"), { source, pi, omp });
  });
extension
  .command("uninstall")
  .description("remove the extension from pi's settings and unlink it from omp")
  .option("--agent <name>", "pi, omp or all", "all")
  .action((o) => {
    if (!["pi", "omp", "all"].includes(o.agent)) throw new Error("--agent must be pi, omp or all");
    const source = defaultExtensionPath();
    const chosen = (o.agent === "all" ? ["pi", "omp"] : [o.agent]) as ("pi" | "omp")[];
    const results: string[] = [];
    for (const agent of chosen) {
      if (agent === "pi") {
        const r = removePiExtension(homedir(), source);
        results.push(`pi: ${r.changed ? `removed from ${r.settingsPath}` : "not installed"}`);
      } else {
        const target = extensionPackageDir(source) ?? source;
        const cmd = ompExtensionCommand("uninstall", target, {});
        const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
        results.push(`omp: ${r.error ? "omp not found on PATH" : r.status === 0 ? "uninstalled" : `failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`}`);
      }
    }
    out(results.join("\n"), results);
  });

const commandsCmd = program.command("commands").description("slash-command entry points for pi / omp / Claude Code / Codex");
commandsCmd
  .command("status")
  .description("show each host's /cafe or $cafe entry point and whether it is installed")
  .action(() => {
    const rows = commandsStatus({ userHome: homedir(), claudePlugin: claudePluginState() });
    out(rows.map((r) => `${r.agent.padEnd(7)} ${r.entry.padEnd(10)} ${r.status.padEnd(11)} ${r.detail}`).join("\n"), rows);
  });

commandsCmd
  .command("install")
  .description("install the /cafe command for Claude Code (agents/ask/status/thread, same as pi/omp; replaces the old /cafe-ask)")
  .requiredOption("--agent <agent>", "pi | omp | claude | codex")
  .option("--dry-run", "print what would change")
  .option("--force", "replace a command file cafe does not own")
  .action((o) => {
    if (o.agent !== "claude") {
      const hint = o.agent === "codex" ? "Codex uses the `$cafe` skill: run `cafe skill install`." : `${o.agent} gets /cafe from the cafe extension: run \`cafe extension install --agent ${o.agent}\`.`;
      out(hint, { agent: o.agent, manual: true });
      return;
    }
    const r = installClaudeCommand(homedir(), { dryRun: o.dryRun, force: o.force });
    const action = r.dryRun ? "would write" : "wrote";
    const replaced = r.replaced ? `\nreplaced:\n${r.replaced}` : "";
    out(`${action} ${r.path}${r.dryRun ? " (dry run)" : ""}${replaced}`, r);
  });

commandsCmd
  .command("uninstall")
  .description("remove the /cafe command file (never a person's own command)")
  .requiredOption("--agent <agent>", "pi | omp | claude | codex")
  .action((o) => {
    if (o.agent !== "claude") {
      out(`${o.agent} has no cafe-managed command file; ${o.agent === "codex" ? "$cafe comes from the skill" : "/cafe comes from the extension"}.`, { agent: o.agent, removed: false });
      return;
    }
    const r = uninstallClaudeCommand(homedir());
    out(r.removed ? `removed ${r.path}` : `${r.path} was not installed`, r);
  });

program
  .command("doctor")
  .description("check daemon, identity, extension, skill and root; print the next command")
  .action(async () => {
    const res = await runDoctor({ base: base(), home: cafeHome(), cwd: process.cwd(), token: process.env.CAFE_TOKEN ?? loadConfig().token });
    const lines = res.checks.map((c) => `${c.level.padEnd(4)} ${c.name.padEnd(9)} ${c.detail}${c.next ? `\n     next: ${c.next}` : ""}`);
    if (res.ok) lines.push("all checks passed");
    out(lines.join("\n"), { ok: res.ok, checks: res.checks });
    if (!res.ok) process.exitCode = 1;
  });

program
  .command("skill")
  .description("manage the cafe skill for Claude Code / Codex / pi")
  .command("install")
  .description("symlink it into ~/.claude/skills/cafe and ~/.agents/skills/cafe")
  .option("--dry-run", "print what would change")
  .option("--force", "replace an existing link or directory cafe did not create")
  .action((o) => {
    // Published package: dist/cli.js with ../skills/cafe; repo: packages/cli/src → ../../../skills/cafe.
    const src = [resolve(here, "../skills/cafe"), resolve(here, "../../../skills/cafe")].find((d) => existsSync(join(d, "SKILL.md")))!;
    const targets = [join(homedir(), ".claude/skills/cafe"), join(homedir(), ".agents/skills/cafe")];
    const done: string[] = [];
    for (const t of targets) {
      const existing = lstatSafe(t);
      if (existing) {
        const isLink = existing.isSymbolicLink();
        const target = isLink ? readlinkSync(t) : undefined;
        if (target === src) {
          done.push(`${t} (already linked)`);
          continue;
        }
        // A stale link to another checkout (repo moved) is safe to repoint.
        if (isLink && !o.force) {
          if (o.dryRun) {
            done.push(`${t} -> ${src} (would repoint from ${target})`);
          } else {
            rmSync(t, { force: true });
            symlinkSync(src, t);
            done.push(`${t} -> ${src} (repointed from ${target})`);
          }
          continue;
        }
        if (o.force && !o.dryRun) {
          rmSync(t, { recursive: true, force: true });
          symlinkSync(src, t);
          done.push(`${t} -> ${src} (replaced; was ${target ?? "a directory"})`);
          continue;
        }
        done.push(`${t} (exists${isLink ? ` -> ${target}` : ""}, skipped — rerun with --force to replace)`);
        continue;
      }
      if (!o.dryRun) {
        mkdirSync(dirname(t), { recursive: true });
        symlinkSync(src, t);
      }
      done.push(o.dryRun ? `${t} -> ${src} (dry run)` : `${t} -> ${src}`);
    }
    out(done.join("\n"), { targets: done, dryRun: !!o.dryRun });
  });

function lstatSafe(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

// Out-of-process Customer connectors live in their own namespace, separate from
// the pi/omp Barista extensions (`cafe extension`).
addConnectorCommands(program, out, base);

// --json is read from argv here because an error can happen before any action's preAction hook
// sets JSON_OUT (a misspelt command never reaches one).
const WANTS_JSON = process.argv.slice(2).includes("--json");

/** Under --json every failure is one JSON object on stdout (#87); otherwise text on stderr. */
function fail(error: string, message: string, extra: { suggestions?: string[]; hint?: string } = {}): never {
  if (WANTS_JSON) {
    console.log(JSON.stringify({ error, message, ...(extra.suggestions ? { suggestions: extra.suggestions } : {}) }));
  } else {
    console.error(`cafe: ${message}${extra.hint ? `\n${extra.hint}` : ""}`);
  }
  process.exit(1);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Commands within a small edit distance (or sharing a prefix), nearest first. */
function similar(word: string, names: string[]): string[] {
  return names
    .map((n) => ({ n, d: n.startsWith(word) || word.startsWith(n) ? 1 : editDistance(word, n) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(word.length / 3)))
    .sort((x, y) => x.d - y.d)
    .map((x) => x.n);
}

// Commander falls back to the top-level help (exit 0) for `cafe <typo> --help`.
// Check the first positional ourselves so a misspelt command always fails.
const commandNames = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));
for (const arg of process.argv.slice(2)) {
  if (["--json", "-V", "--version", "-h", "--help"].includes(arg) || arg.startsWith("-")) continue;
  if (arg !== "help" && !commandNames.has(arg)) {
    const suggestions = similar(arg, program.commands.map((c) => c.name()));
    fail("unknown_command", `unknown command '${arg}'`, {
      suggestions,
      hint: `${suggestions.length ? `  did you mean: ${suggestions.map((n) => `cafe ${n}`).join(", ")}\n` : ""}next: cafe --help`,
    });
  }
  break;
}

// Commander's own parse errors (a misspelt subcommand, a missing argument) become JSON under
// --json instead of plain text. Text mode keeps Commander's wording, including "Did you mean".
if (WANTS_JSON) {
  const quiet = (c: Command): void => {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {}, outputError: () => {} });
    c.commands.forEach(quiet);
  };
  quiet(program);
}

program.parseAsync().catch((err) => {
  if (err instanceof CommanderError) {
    if (err.exitCode === 0) process.exit(0); // --help / --version under exitOverride
    const raw = err.message.replace(/^error: /, "");
    const message = raw.split("\n")[0];
    const suggestions = [...raw.matchAll(/Did you mean (?:one of )?([^?]+)\?/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()));
    fail(err.code === "commander.unknownCommand" ? "unknown_command" : err.code.replace(/^commander\./, ""), message, suggestions.length ? { suggestions } : {});
  }
  fail("failed", (err as Error).message);
});
