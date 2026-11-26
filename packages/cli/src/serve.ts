import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAgentIdentity } from "@cafe/protocol/cafe-file";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";
import type { Order } from "@cafe/protocol";
import { extractAttachments } from "./artifacts.ts";

/**
 * Ready-made commands for common agent CLIs. Each reads the prompt from stdin and prints the answer on stdout.
 * They pin the same read-only defaults as `cafe barista start --agent …`; `--write` widens them explicitly.
 */
export const PRESETS: Record<string, string> = {
  claude: "claude -p --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools Read,Grep,Glob",
  codex: "codex exec -s read-only --skip-git-repo-check -",
};

/** The preset command for an access level (the CLI never silently inherits the user's global sandbox). */
export function presetCommand(name: string, write = false): string | undefined {
  const preset = PRESETS[name];
  if (!preset) return undefined;
  if (!write) return preset;
  if (name === "claude") return "claude -p --permission-mode dontAsk --tools Read,Grep,Glob,Edit,Write --allowedTools Read,Grep,Glob,Edit,Write";
  if (name === "codex") return "codex exec -s workspace-write --skip-git-repo-check -";
  return preset;
}

/** The command as shown on the Agents page (the identity field holds at most 80 characters). */
export function commandLabel(exec: string): string {
  const one = exec.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

export const DECLINE_MARKER = "CAFE_DECLINE:";
const MAX_OUTPUT = 1024 * 1024;

export interface ServeOptions {
  /** Shell command run once per Order. Prompt on stdin, or in the file named by `{prompt_file}`. */
  exec: string;
  dir: string;
  daemon: string;
  token?: string;
  /** Kill the command after this long (ms). 0 = no limit (heartbeats keep the Order alive). */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const STDOUT_REPLY =
  "Answer directly and concisely; your entire stdout is sent back as the reply. To send a file, print a line `CAFE_ATTACH: /absolute/path` — it is uploaded and removed from the text.";

/** The text handed to the command for one Order. `replyNote` says how the answer gets back (stdout by default). */
export function buildPrompt(
  order: Order,
  self: { address: string; description: string },
  replyNote = STDOUT_REPLY,
  attachments?: Array<{ name: string; mime: string; size: number; path?: string }>,
): string {
  const lines = [
    `You are ${self.address} on the cafe agent network. Another agent or person sent you this question.`,
    `Your declared responsibility: ${self.description || "(none declared)"}`,
    `From: ${order.from.address}`,
    `Order: ${order.orderId} · Thread: ${order.threadId}`,
  ];
  if (attachments?.length) {
    lines.push("", "Attachments on this machine:");
    for (const a of attachments) lines.push(`- ${a.name} (${a.mime}, ${a.size} bytes)${a.path ? `: ${a.path}` : ""}`);
  }
  if (order.turn > 1 && order.history.length) {
    lines.push("", `This is a follow-up (turn ${order.turn}). Earlier in this conversation:`);
    for (const h of order.history) lines.push(`[${h.role === "customer" ? "asked" : "answered"} by ${h.from}]`, h.text.slice(0, 1500), "");
  }
  lines.push(
    "",
    "Question:",
    order.body,
    "",
    replyNote,
    `If this question is clearly outside your responsibility, print a single line \`${DECLINE_MARKER} <short reason>\` instead.`,
    "If you need to ask the sender a clarifying question, call cafe_ask with escalate=true, parent_order_id and parent_thread_id above (or run `cafe ask --escalate --parent <orderId> --parent-thread <threadId> \"...\"`). Do not set a parent for an unrelated new question; to delegate, use an explicit target or broadcast.",
  );
  return lines.join("\n");
}

/** A Follow-up sent into an agent session that already holds the earlier turns (bridged Codex / Claude Baristas). */
export function buildFollowup(order: Order, attachments?: Array<{ name: string; mime: string; size: number; path?: string }>): string {
  return [
    `Follow-up from ${order.from.address} (turn ${order.turn}) in the same cafe conversation:`,
    "",
    order.body,
    ...(attachments?.length ? ["", "Attachments on this machine:", ...attachments.map((a) => `- ${a.name} (${a.mime}, ${a.size} bytes)${a.path ? `: ${a.path}` : ""}`)] : []),
    "",
    `Answer as before. If this is clearly outside your responsibility, reply with a single line \`${DECLINE_MARKER} <short reason>\` instead.`,
  ].join("\n");
}

/**
 * Turn any prompt-in/answer-out command (claude -p, codex exec -, a script) into a Barista.
 * Orders run concurrently up to the `.cafe` concurrency; the rest queue.
 */
export async function serve(opts: ServeOptions): Promise<{ client: CafeClient; stop: () => void }> {
  const log = opts.log ?? ((m: string) => console.error(`[cafe serve] ${m}`));
  const dir = resolve(opts.dir);
  const loaded = loadAgentIdentity(dir);
  const { file, identity } = loaded;
  if (!file) throw new Error(`no .cafe found in ${dir} or its parents; a Barista needs an identity`);
  if (identity.role !== "barista") throw new Error(`${file} declares role "${identity.role}"; set role: barista to receive questions`);

  const client = new CafeClient({ daemon: opts.daemon, token: opts.token, reconnect: true, log });
  // An Order is acknowledged on arrival, so it needs heartbeats while it waits for a free slot.
  const queue: Array<{ h: OrderHandle; stopBeat: () => void }> = [];
  const running = new Map<string, () => void>(); // orderId → kill
  let active = 0;
  // v4-13: the team playbook is delivered once per process, before the first Order; roster
  // changes ride the next Order. Neither creates an extra turn.
  let teamNote: string | undefined;
  const rosterNotes: string[] = [];
  client.onTeamContext((tc) => {
    teamNote ??= tc.playbook;
  });
  client.onRoster((r) => {
    rosterNotes.push(
      r.removedTeam
        ? `Team ${r.team} was removed; stop treating yourself as its member.`
        : `Team ${r.team} roster changed (revision ${r.revision}): ${[...r.change.added.map((n) => `+${n}`), ...r.change.removed.map((n) => `-${n}`), ...r.change.updated.map((n) => `~${n}`)].join(", ") || "members updated"}. Now: ${r.members.map((m) => m.name).join(", ")}.`,
    );
    if (rosterNotes.length > 5) rosterNotes.splice(0, rosterNotes.length - 5);
  });

  const run = async (h: OrderHandle) => {
    active++;
    void client.setStatus("busy").catch(() => {});
    const stopBeat = keepAlive(h);
    const notes = [teamNote, ...rosterNotes.splice(0)].filter(Boolean) as string[];
    teamNote = undefined;
    const prompt = `${notes.length ? `${notes.join("\n\n")}\n\n` : ""}${buildPrompt(h.order, { address: client.record?.address ?? identity.name, description: identity.description }, undefined, h.attachments)}`;
    let tmp: string | undefined;
    let cmd = opts.exec;
    if (cmd.includes("{prompt_file}")) {
      tmp = mkdtempSync(join(tmpdir(), "cafe-prompt-"));
      writeFileSync(join(tmp, "prompt.md"), prompt);
      cmd = cmd.replaceAll("{prompt_file}", JSON.stringify(join(tmp, "prompt.md")));
    }
    log(`→ ${h.order.from.address}: ${h.order.body.slice(0, 80)}`);
    try {
      const result = await exec(cmd, dir, tmp ? undefined : prompt, opts.timeoutMs ?? 0, (kill) => running.set(h.order.orderId, kill));
      if (result.cancelled) return log(`✗ cancelled ${h.order.orderId}`);
      const text = result.stdout.trim();
      if (result.code !== 0) {
        await h.decline(`command failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${result.stderr.trim().slice(-300) || "no output"}`, { unavailable: true });
      } else if (text.startsWith(DECLINE_MARKER)) {
        await h.decline(text.slice(DECLINE_MARKER.length).trim() || "not mine");
      } else {
        const parsed = await extractAttachments(`http://${opts.daemon}`, text, opts.token ?? process.env.CAFE_TOKEN);
        if (!parsed.text && !parsed.attachments.length) {
          await h.decline("command produced no output", { unavailable: true });
        } else {
          await h.reply(parsed.text, true, parsed.attachments);
        }
      }
      log(`← ${h.order.orderId} (${result.code === 0 ? "ok" : `exit ${result.code}`})`);
    } catch (err) {
      await h.decline(`could not run command: ${(err as Error).message}`, { unavailable: true }).catch(() => {});
    } finally {
      stopBeat();
      running.delete(h.order.orderId);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      active--;
      if (active === 0 && queue.length === 0) void client.setStatus("idle").catch(() => {});
      pump();
    }
  };

  const pump = () => {
    while (active < (identity.concurrency ?? 1) && queue.length) {
      const next = queue.shift()!;
      next.stopBeat(); // `run` takes over with its own heartbeat
      void run(next.h);
    }
  };

  client.onOrder((h) => {
    void h.ack().catch(() => {});
    queue.push({ h, stopBeat: keepAlive(h) });
    pump();
  });
  client.onCancel(({ orderId, by }) => {
    const i = queue.findIndex((q) => q.h.order.orderId === orderId);
    if (i >= 0) queue.splice(i, 1)[0]!.stopBeat();
    running.get(orderId)?.();
    log(`cancelled by ${by}: ${orderId}`);
  });

  const rec = await client.connect({ ...identity, mode: "cli", agent: "command", command: commandLabel(opts.exec), cwd: dir, pid: process.pid });
  log(`serving as ${rec?.address} with: ${opts.exec}`);
  return {
    client,
    stop: () => {
      for (const q of queue.splice(0)) {
        q.stopBeat();
        void q.h.decline("barista is shutting down", { unavailable: true }).catch(() => {});
      }
      for (const kill of running.values()) kill();
      client.close();
    },
  };
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

/** Run a shell command in its own process group; killing it takes the whole group down. */
function exec(cmd: string, cwd: string, stdin: string | undefined, timeoutMs: number, onKill: (kill: () => void) => void): Promise<ExecResult> {
  return new Promise((resolveP, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CAFE_HEADLESS: "1" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, s);
      } catch {
        child.kill(s);
      }
    };
    const kill = () => {
      if (child.exitCode !== null) return;
      signal("SIGTERM");
      setTimeout(() => child.exitCode === null && signal("SIGKILL"), 3000).unref();
    };
    onKill(() => {
      cancelled = true;
      kill();
    });
    child.on("error", reject);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8192);
    });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs) : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // Grandchildren may outlive the shell; clean up the group.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      resolveP({ code: code ?? 1, stdout, stderr, timedOut, cancelled });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}
