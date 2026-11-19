#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { onlineVersions, type AgentRecord, type DaemonRecord, type RoutingHint, type ThreadEnvelope, type ThreadMeta } from "@cafe/protocol";
import { cafeHome, defaultExtensionPath, discoverRoots, loadConfig, runDaemon, setConfigValue } from "@cafe/daemon";
import { PRESETS, serve } from "./serve.ts";
import { BRIDGED_AGENTS, runBridge, type AgentKind } from "./bridge/barista.ts";
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
  if (!res.ok) throw new Error(`${body.error ?? res.status}: ${body.message ?? ""}`.trim());
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
    out(
      [
        `host:      ${s.host}${s.isRoot ? " (root)" : ""}`,
        `version:   ${(await api("/api/health")).version ?? "unknown"}`,
        `url:       ${base()}`,
        `root:      ${s.isRoot ? "self" : s.rootOnline ? "online" : "offline"}`,
        `router:    ${s.router}`,
        `agents:    ${s.agents.length} (registry v${s.registryVersion})`,
        `threads:   ${s.threads.length}`,
        ...versionLines(s.daemons),
      ].join("\n"),
      { running: true, ...s, threads: s.threads.length },
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
  .action(async (words: string[], o) => {
    await ensureDaemon();
    const res = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ body: words.join(" "), to: o.to, threadId: o.thread, kind: o.notice ? "notice" : "order", deadlineMs: o.deadline, as: o.as }),
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
  .description("show a thread's full event log")
  .argument("<threadId>")
  .action(async (id: string) => {
    const t = await api<{ meta: ThreadMeta; events: ThreadEnvelope[] }>(`/api/threads/${id}`);
    const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a]));
    const lines = [`${t.meta.from.address}: ${t.meta.summary}`, ...t.events.map((e) => describe(e, agents)).filter(Boolean)];
    out(lines.join("\n"), t);
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
  .action(() => {
    const c = loadConfig();
    out(c.mode === "root" ? "this host is the root" : (c.root ?? "(no root configured)"), { mode: c.mode, root: c.root });
  });

const config = program.command("config").description("~/.cafe/config.yml");
config
  .command("get")
  .argument("[key]")
  .action((key?: string) => {
    const c = loadConfig() as Record<string, any>;
    const v = key ? key.split(".").reduce((o, k) => o?.[k], c) : c;
    out(typeof v === "string" ? v : JSON.stringify(v, null, 2), v);
  });
config
  .command("set")
  .argument("<key>")
  .argument("<value>")
  .description("set a value (e.g. router.model anthropic/claude-haiku-4-5) and reload the running daemon")
  .action(async (key: string, value: string) => {
    setConfigValue(key, value);
    if (await healthy()) await api("/api/reload", { method: "POST" });
    out(`${key} = ${value}`, { [key]: value });
  });

const barista = program.command("barista").description("headless Baristas supervised by the daemon (pi, omp, codex, claude)");
barista
  .command("start")
  .option("--dir <dir>", "directory to run in (its .cafe defines identity)", process.cwd())
  .option("--agent <name>", "pi (default), omp (oh-my-pi), codex (codex app-server) or claude (claude -p)")
  .option("--write", "codex / claude only: allow editing files in --dir (default: read-only)")
  .option("--model <model>", "codex / claude only: model to use")
  .action(async (o) => {
    const native = BRIDGED_AGENTS.includes(o.agent);
    if ((o.write || o.model) && !native) throw new Error("--write and --model are for --agent codex or claude");
    await ensureDaemon();
    const spec = native
      ? { agent: o.agent, ...(o.write ? { access: "workspace-write" } : {}), ...(o.model ? { model: o.model } : {}) }
      : o.agent ? { bin: o.agent } : {};
    const ws = await api("/api/baristas", { method: "POST", body: JSON.stringify({ dir: resolve(o.dir), ...spec }) });
    out(`started ${ws.length} ${o.agent ?? "pi"} worker(s) in ${resolve(o.dir)}${native ? (o.write ? " (may edit files)" : " (read-only)") : ""}`, ws);
  });
barista
  .command("stop")
  .option("--dir <dir>", "", process.cwd())
  .action(async (o) => out("stopped", await api(`/api/baristas?dir=${encodeURIComponent(resolve(o.dir))}`, { method: "DELETE" })));
barista.command("list").action(async () => {
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

program
  .command("skill")
  .description("install the cafe skill for Claude Code / Codex / pi")
  .command("install")
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

program.parseAsync().catch((err) => {
  console.error(`cafe: ${(err as Error).message}`);
  process.exit(1);
});
