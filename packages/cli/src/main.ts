#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { onlineVersions, type AgentRecord, type DaemonRecord, type RoutingHint, type ThreadEnvelope, type ThreadMeta } from "@cafe/protocol";
import { cafeHome, CONFIG_KEYS, configApplyMode, defaultExtensionPath, diffConfig, discoverRoots, listRouterModels, loadConfig, runDaemon, saveConfig, setConfigValue } from "@cafe/daemon";
import { formatApiError } from "./errors.ts";
import { PRESETS, serve } from "./serve.ts";
import { BRIDGED_AGENTS, runBridge, type AgentKind } from "./bridge/barista.ts";
import { runSessionHost, type HostMessage } from "./bridge/session-host.ts";
import { runInit } from "./init.ts";
import { extensionPackageDir, installPiExtension, ompExtensionCommand, ompExtensionState, piExtensionState, removePiExtension } from "./extension.ts";
import { runDoctor } from "./doctor.ts";
import { claudeCommandPath, claudeCommandState, commandsStatus, installClaudeCommand, uninstallClaudeCommand } from "./commands.ts";
import { claudePluginPlan, MARKETPLACE as CLAUDE_MARKETPLACE, PLUGIN as CLAUDE_PLUGIN, pluginSource, writeClaudePlugin } from "./claude-plugin.ts";
import { mcpInstallCommands, runMcp } from "./mcp.ts";
import { installService, serviceFile, servicePath, startInstalledService, uninstallService } from "./service.ts";

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

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

const ATTACH_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".txt": "text/plain", ".log": "text/plain", ".json": "application/json" };

/** Upload one file to the local daemon; the returned metadata goes on the Order. */
async function uploadAttachment(file: string): Promise<{ id: string; name: string; mime: string; size: number; sha256: string; host?: string }> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`cannot read ${file}`);
  const name = basename(path);
  const mime = ATTACH_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (process.env.CAFE_TOKEN) headers.authorization = `Bearer ${process.env.CAFE_TOKEN}`;
  const res = await fetch(`${base()}/api/artifacts?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: "POST", body: readFileSync(path), headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload ${file} failed: ${formatApiError(body, res.status)}`);
  return body.attachment;
}

/**
 * Write a config value and apply it. A value the running daemon rejects (an
 * unknown router model) is rolled back, so config and running state stay equal.
 */
async function setAndApply(key: string, value: string): Promise<{ human: string; data: any }> {
  const before = loadConfig() as Record<string, any>;
  const old = key.split(".").reduce((o, k) => o?.[k], before);
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
  const home = cafeHome();
  mkdirSync(home, { recursive: true });
  // Autostart installed for this home: let launchd/systemd run it so it stays supervised.
  if (startInstalledService(home)) {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await healthy()) return;
    }
  }
  const out = openSync(join(home, "daemon.log"), "a");
  const args = ["--no-warnings", MAIN, "daemon", "run", ...(opts.root ? ["--root"] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthy()) return;
  }
  throw new Error(`cafe daemon did not start; see ${join(home, "daemon.log")}`);
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
async function follow(threadId: string, opts: { quiet?: boolean; orderId?: string } = {}): Promise<string> {
  const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
  const res = await fetch(`${base()}/api/threads/${threadId}/stream${opts.orderId ? `?orderId=${opts.orderId}` : ""}`, {
    headers: process.env.CAFE_TOKEN ? { authorization: `Bearer ${process.env.CAFE_TOKEN}` } : {},
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
    if (o.root) setConfigValue("mode", "root");
    await ensureDaemon({ root: o.root });
    const h = await api("/api/health");
    out(`cafe daemon running on ${base()} (host ${h.host}${h.isRoot ? ", root" : ""}, pid ${h.pid})`, h);
  });
daemon
  .command("stop")
  .description("stop the background daemon")
  .action(async () => {
    if (!(await healthy())) return out("cafe daemon is not running", { running: false });
    await api("/api/shutdown", { method: "POST" });
    out("cafe daemon stopping", { stopping: true });
  });
daemon
  .command("restart")
  .description("stop and start the daemon (config changes marked restart required)")
  .action(async () => {
    const cfg = loadConfig();
    if (await healthy()) {
      await api("/api/shutdown", { method: "POST" });
      for (let i = 0; i < 50 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 100));
    }
    await ensureDaemon({ root: cfg.mode === "root" });
    const h = await api("/api/health");
    out(`cafe daemon restarted on ${base()} (host ${h.host}${h.isRoot ? ", root" : ""}, pid ${h.pid})`, h);
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
    const f = serviceFile({
      platform: process.platform,
      node: process.execPath,
      bin: join(here, "..", "bin", "cafe.js"),
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
    const fmt = (v: unknown) => (v === undefined ? "(not set)" : typeof v === "string" ? v : JSON.stringify(v));
    out(
      [
        `host:      ${s.host}${s.isRoot ? " (root)" : ""}`,
        `mode:      ${s.isRoot ? "root" : "daemon"}`,
        `version:   ${h.version ?? "unknown"}`,
        `url:       ${base()}`,
        `advertise: ${loadConfig().advertise ?? "(not set; other machines use lanAddress)"}`,
        `root:      ${s.isRoot ? "self" : loadConfig().root ? `${loadConfig().root} (${s.rootOnline ? "online" : "offline"})` : "mDNS discovery"}`,
        `router:    ${h.router}${h.model ? ` (${h.model})` : ""}`,
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
  .option("--thread <threadId>", "follow-up in an existing thread (goes to whoever answered there)")
  .option("--async", "return the thread id immediately")
  .option("--notice", "send a Notice (no reply expected)")
  .option("--deadline <ms>", "broadcast collection deadline", Number)
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
        threadId: o.thread,
        kind: o.notice ? "notice" : "order",
        deadlineMs: o.deadline,
        as: o.as,
        origin: o.origin,
        ...(o.via ? { via: { address: o.via } } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    if (o.async || o.notice) return out(`thread ${res.threadId} (order ${res.orderId}) → ${res.decision.mode}: ${res.decision.reason}`, res);
    if (!JSON_OUT) console.log(`thread ${res.threadId}`);
    const status = await follow(res.threadId, { orderId: res.orderId });
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

program
  .command("agents")
  .description("list registered agents")
  .action(async () => {
    await ensureDaemon();
    const list = await api<AgentRecord[]>("/api/agents");
    const lines = list
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((a) => `${a.status.padEnd(7)} ${a.role.padEnd(8)} ${runsAs(a).padEnd(12)} ${a.address.padEnd(28)} ${a.description}${a.scope.length ? ` [${a.scope.join(", ")}]` : ""}`);
    out(lines.join("\n") || "(no agents)", list);
  });

/** Short "what runs it" column for `cafe agents`: the agent kind (pi, omp, codex, claude, command), `·tui` when
 * someone is using it in a terminal, `·ro` / `·rw` for Bridges. Falls back to the mode for agents that do not report a kind. */
function runsAs(a: Pick<AgentRecord, "mode" | "agent" | "access">): string {
  if (!a.agent) return a.mode;
  return [a.agent, a.mode === "tui" ? "tui" : undefined, a.access === "read-only" ? "ro" : a.access === "write" ? "rw" : undefined].filter(Boolean).join("·");
}

const printThreads = (list: ThreadMeta[], agents: Map<string, AgentRecord>) =>
  list
    .map((t) => `${t.status.padEnd(9)} ${t.threadId}  ${time(t.createdAt)}  ${t.from.address} → ${t.targets.map((id) => agents.get(id)?.address ?? id).join(",") || "-"}  ${t.summary.replace(/\s+/g, " ").slice(0, 60)}`)
    .join("\n") || "(no threads)";

program
  .command("stats")
  .description("how each barista did in the last 7 days (used as a weak routing hint)")
  .action(async () => {
    await ensureDaemon();
    const { learn, hints } = await api<{ learn: boolean; hints: Record<string, RoutingHint> }>("/api/routing/hints");
    const rows = Object.values(hints).sort((a, b) => b.answered + b.declined - (a.answered + a.declined) || a.identity.localeCompare(b.identity));
    const lines = rows.map((h) => {
      const topics = Object.keys(h.declinedTopics).slice(0, 6).join(", ");
      return `${h.identity.padEnd(28)} answered ${String(h.answered).padStart(3)}  declined ${String(h.declined).padStart(3)}  failed ${String(h.failed).padStart(3)}${topics ? `  declined topics: ${topics}` : ""}`;
    });
    const footer = learn ? "" : "\n(router.learn is off: routing ignores this history)";
    out((lines.join("\n") || "(no answers or declines in the last 7 days)") + footer, { learn, hints });
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
  .option("--limit <n>", "", Number, 30)
  .action(async (o) => {
    await ensureDaemon();
    const q = new URLSearchParams({ limit: String(o.limit), ...(o.status ? { status: o.status } : {}) });
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
    const lines = [`${t.meta.from.address}: ${t.meta.summary}`, ...att, ...t.events.map((e) => describe(e, agents)).filter(Boolean)];
    out(lines.join("\n"), t);
  });

program
  .command("connect")
  .argument("<host:port>")
  .description("join another machine's Root: saves mode, root and token")
  .option("--token <token>", "the Root's token (cafe config get token on the Root)")
  .action((addr: string, o) => {
    if (!o.token) throw new Error("--token is required (cafe config get token on the Root)");
    setConfigValue("mode", "daemon");
    setConfigValue("root", addr);
    setConfigValue("token", o.token);
    out(`saved root ${addr}; restart required: cafe daemon restart`, { mode: "daemon", root: addr, restartRequired: true });
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

const root = program.command("root").description("Root Daemon address");
root
  .command("set")
  .argument("<host:port>")
  .description("point this daemon at a (moved) Root; updates config.yml and the live connection")
  .action(async (addr: string) => {
    setConfigValue("root", addr);
    if (await healthy()) await api("/api/root", { method: "POST", body: JSON.stringify({ root: addr }) });
    out(`root set to ${addr}`, { root: addr });
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
  .description("print the Root this Daemon uses")
  .action(() => {
    const c = loadConfig();
    out(c.mode === "root" ? "this host is the root" : (c.root ?? "(no root configured)"), { mode: c.mode, root: c.root });
  });
root
  .command("test")
  .description("do a token-authenticated handshake with the configured Root")
  .action(async () => {
    const c = loadConfig();
    if (!c.root) throw new Error("no root configured; use `cafe root discover` or `cafe connect <host:port> --token <token>`");
    try {
      const res = await fetch(`http://${c.root}/api/health`, {
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
  .description("print one value (no key: the whole file); an unset value prints (not set)")
  .action((key?: string) => {
    const c = loadConfig() as Record<string, any>;
    if (!key) {
      out(JSON.stringify(c, null, 2), c);
      return;
    }
    if (!CONFIG_KEYS.includes(key)) throw new Error(`unknown config key '${key}'`);
    const v = key.split(".").reduce((o, k) => o?.[k], c);
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
      `running:    ${running.router}${running.model ? ` (${running.model})` : ""}`,
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
  .option("--agent <name>", "pi (default), omp (oh-my-pi), codex (codex app-server) or claude (claude -p)")
  .option("--write", "codex / claude only: allow editing files in --dir (default: read-only)")
  .option("--model <model>", "codex / claude only: model to use")
  .option("--tui", "codex only: answer in the Codex session running in --dir (the TUI), not a headless one")
  .option("--thread <id>", "with --tui: the Codex thread to use (default: the newest session started in --dir)")
  .action(async (o) => {
    const native = BRIDGED_AGENTS.includes(o.agent);
    if ((o.write || o.model) && !native) throw new Error("--write and --model are for --agent codex or claude");
    if (o.tui && o.agent !== "codex") throw new Error("--tui is for --agent codex; for Claude Code run `cafe claude install`");
    if (o.thread && !o.tui) throw new Error("--thread needs --tui");
    if (o.tui && (o.write || o.model)) throw new Error("--tui uses the session's own model and permissions; drop --write / --model");
    await ensureDaemon();
    const spec = native
      ? { agent: o.agent, ...(o.write ? { access: "workspace-write" } : {}), ...(o.model ? { model: o.model } : {}), ...(o.tui ? { tui: true } : {}), ...(o.thread ? { thread: o.thread } : {}) }
      : o.agent ? { bin: o.agent } : {};
    const ws = await api("/api/baristas", { method: "POST", body: JSON.stringify({ dir: resolve(o.dir), ...spec }) });
    const how = o.tui ? " (answers in the running Codex session)" : native ? (o.write ? " (may edit files)" : " (read-only)") : "";
    out(`started ${ws.length} ${o.agent ?? "pi"} worker(s) in ${resolve(o.dir)}${how}`, ws);
  });
barista
  .command("stop")
  .description("stop the Baristas supervised for one directory")
  .option("--dir <dir>", "directory whose Baristas should stop", process.cwd())
  .action(async (o) => out("stopped", await api(`/api/baristas?dir=${encodeURIComponent(resolve(o.dir))}`, { method: "DELETE" })));
barista
  .command("list")
  .description("list the Baristas this daemon supervises")
  .action(async () => {
  const ws = await api<any[]>("/api/baristas");
  out(ws.map((w) => `${w.running ? "running" : "waiting"} ${String(w.agent ?? "pi").padEnd(6)} pid=${w.pid ?? "-"} restarts=${w.restarts} ${w.dir}#${w.slot}`).join("\n") || "(none)", ws);
});
barista
  .command("run")
  .description("run a Codex / Claude Code Barista in the foreground (what `barista start --agent codex|claude` supervises)")
  .requiredOption("--agent <name>", "codex or claude")
  .option("--dir <dir>", "directory whose .cafe gives the identity (and where the agent works)", process.cwd())
  .option("--write", "allow editing files in --dir (default: read-only)")
  .option("--model <model>", "model to use")
  .option("--tui", "codex only: answer in the running Codex session in --dir")
  .option("--thread <id>", "with --tui: the Codex thread to use")
  .action(async (o) => {
    if (!BRIDGED_AGENTS.includes(o.agent)) throw new Error(`--agent must be ${BRIDGED_AGENTS.join(" or ")}`);
    if (!process.env.CAFE_DAEMON) await ensureDaemon();
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
    for (const cmd of plan.commands) {
      const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
      const msg = (r.stderr || r.stdout || "").trim().split("\n").at(-1) ?? "";
      if (r.error) throw new Error(`${cmd[0]} not found; install Claude Code first`);
      results.push(`${r.status === 0 ? "ok" : /already/i.test(msg) ? "ok (already)" : `failed: ${msg}`}  ${cmd.join(" ")}`);
    }
    results.push("New Claude Code sessions in a directory with a Barista .cafe now answer cafe questions; in open sessions run /reload-plugins. /cafe off pauses a session.");
    out(results.join("\n"), { ...plan, results });
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
  .option("--preset <name>", `ready-made command: ${Object.keys(PRESETS).join(", ")}`)
  .option("--dir <dir>", "directory whose .cafe gives the identity (and where the command runs)", process.cwd())
  .option("--timeout <ms>", "kill the command after this long (default: no limit)", Number)
  .action(async (o) => {
    const cmd = o.exec ?? (o.preset ? PRESETS[o.preset] : undefined);
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
        results.push(`omp: ${r.error ? "omp not found on PATH" : r.status === 0 ? "installed" : `failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`}`);
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
      `omp: ${omp.available ? (omp.installed ? "installed" : "not installed") : omp.detail}`,
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
    const rows = commandsStatus({ cafeHome: cafeHome() });
    out(rows.map((r) => `${r.agent.padEnd(7)} ${r.entry.padEnd(10)} ${r.status.padEnd(11)} ${r.detail}`).join("\n"), rows);
  });

commandsCmd
  .command("install")
  .description("install the /cafe-ask command for Claude Code (pi/omp get /cafe from the extension)")
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
  .description("remove the /cafe-ask command file (never a person's own command)")
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
    const res = await runDoctor({ base: base(), home: cafeHome(), cwd: process.cwd(), token: process.env.CAFE_TOKEN });
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
  .action(() => {
    // Published package: dist/cli.js with ../skills/cafe; repo: packages/cli/src → ../../../skills/cafe.
    const src = [resolve(here, "../skills/cafe"), resolve(here, "../../../skills/cafe")].find((d) => existsSync(join(d, "SKILL.md")))!;
    const targets = [join(homedir(), ".claude/skills/cafe"), join(homedir(), ".agents/skills/cafe")];
    const done: string[] = [];
    for (const t of targets) {
      mkdirSync(dirname(t), { recursive: true });
      if (existsSync(t) || lstatSafe(t)) {
        if (lstatSafe(t)?.isSymbolicLink() && readlinkSync(t) === src) {
          done.push(`${t} (already linked)`);
          continue;
        }
        done.push(`${t} (exists, skipped — remove it to relink)`);
        continue;
      }
      symlinkSync(src, t);
      done.push(`${t} -> ${src}`);
    }
    out(done.join("\n"), done);
  });

function lstatSafe(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

// Commander falls back to the top-level help (exit 0) for `cafe <typo> --help`.
// Check the first positional ourselves so a misspelt command always fails.
const commandNames = new Set(program.commands.map((c) => c.name()));
for (const arg of process.argv.slice(2)) {
  if (["--json", "-V", "--version", "-h", "--help"].includes(arg) || arg.startsWith("-")) continue;
  if (arg !== "help" && !commandNames.has(arg)) {
    console.error(`cafe: unknown command '${arg}'`);
    process.exit(1);
  }
  break;
}

program.parseAsync().catch((err) => {
  console.error(`cafe: ${(err as Error).message}`);
  process.exit(1);
});
