#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { AgentRecord, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";
import { cafeHome, loadConfig, runDaemon, setConfigValue } from "@cafe/daemon";
import { PRESETS, serve } from "./serve.ts";

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

const program = new Command("cafe")
  .description("cafe: route a message to the agent(s) on the network that can answer it")
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
    const running = await runDaemon({ mode: o.root ? "root" : undefined, port: o.port });
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
  .command("status")
  .description("show daemon status")
  .action(async () => {
    if (!(await healthy())) return out("cafe daemon is not running", { running: false });
    const s = await api("/api/snapshot");
    out(
      [
        `host:      ${s.host}${s.isRoot ? " (root)" : ""}`,
        `url:       ${base()}`,
        `root:      ${s.isRoot ? "self" : s.rootOnline ? "online" : "offline"}`,
        `router:    ${s.router}`,
        `agents:    ${s.agents.length} (registry v${s.registryVersion})`,
        `threads:   ${s.threads.length}`,
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
      .map((a) => `${a.status.padEnd(7)} ${a.role.padEnd(8)} ${a.mode.padEnd(8)} ${a.address.padEnd(28)} ${a.description}${a.scope.length ? ` [${a.scope.join(", ")}]` : ""}`);
    out(lines.join("\n") || "(no agents)", list);
  });

const printThreads = (list: ThreadMeta[], agents: Map<string, AgentRecord>) =>
  list
    .map((t) => `${t.status.padEnd(9)} ${t.threadId}  ${time(t.createdAt)}  ${t.from.address} → ${t.targets.map((id) => agents.get(id)?.address ?? id).join(",") || "-"}  ${t.summary.replace(/\s+/g, " ").slice(0, 60)}`)
    .join("\n") || "(no threads)";

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

const barista = program.command("barista").description("headless Baristas (pi --mode rpc) supervised by the daemon");
barista
  .command("start")
  .option("--dir <dir>", "directory to run in (its .cafe defines identity)", process.cwd())
  .action(async (o) => {
    await ensureDaemon();
    const ws = await api("/api/baristas", { method: "POST", body: JSON.stringify({ dir: resolve(o.dir) }) });
    out(`started ${ws.length} worker(s) in ${resolve(o.dir)}`, ws);
  });
barista
  .command("stop")
  .option("--dir <dir>", "", process.cwd())
  .action(async (o) => out("stopped", await api(`/api/baristas?dir=${encodeURIComponent(resolve(o.dir))}`, { method: "DELETE" })));
barista.command("list").action(async () => {
  const ws = await api<any[]>("/api/baristas");
  out(ws.map((w) => `${w.running ? "running" : "waiting"} pid=${w.pid ?? "-"} restarts=${w.restarts} ${w.dir}#${w.slot}`).join("\n") || "(none)", ws);
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
  .command("skill")
  .description("install the cafe skill for Claude Code / Codex / pi")
  .command("install")
  .action(() => {
    const src = resolve(here, "../../../skills/cafe");
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
