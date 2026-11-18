import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadIdentity } from "@cafe/protocol/cafe-file";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";
import type { Order } from "@cafe/protocol";

/** Ready-made commands for common agent CLIs. Each reads the prompt from stdin and prints the answer on stdout. */
export const PRESETS: Record<string, string> = {
  claude: "claude -p",
  codex: "codex exec --skip-git-repo-check -",
};

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

/** The text handed to the command for one Order. */
export function buildPrompt(order: Order, self: { address: string; description: string }): string {
  const lines = [
    `You are ${self.address} on the cafe agent network. Another agent or person sent you this question.`,
    `Your declared responsibility: ${self.description || "(none declared)"}`,
    `From: ${order.from.address}`,
  ];
  if (order.turn > 1 && order.history.length) {
    lines.push("", `This is a follow-up (turn ${order.turn}). Earlier in this conversation:`);
    for (const h of order.history) lines.push(`[${h.role === "customer" ? "asked" : "answered"} by ${h.from}]`, h.text.slice(0, 1500), "");
  }
  lines.push(
    "",
    "Question:",
    order.body,
    "",
    "Answer directly and concisely; your entire stdout is sent back as the reply.",
    `If this question is clearly outside your responsibility, print a single line \`${DECLINE_MARKER} <short reason>\` instead.`,
  );
  return lines.join("\n");
}

/**
 * Turn any prompt-in/answer-out command (claude -p, codex exec -, a script) into a Barista.
 * Orders run concurrently up to the `.cafe` concurrency; the rest queue.
 */
export async function serve(opts: ServeOptions): Promise<{ client: CafeClient; stop: () => void }> {
  const log = opts.log ?? ((m: string) => console.error(`[cafe serve] ${m}`));
  const dir = resolve(opts.dir);
  const { cafe, file } = loadIdentity(dir);
  if (!file) throw new Error(`no .cafe found in ${dir} or its parents; a Barista needs an identity`);
  if (cafe.role !== "barista") throw new Error(`${file} declares role "${cafe.role}"; set role: barista to receive questions`);

  const client = new CafeClient({ daemon: opts.daemon, token: opts.token, reconnect: true, log });
  const queue: OrderHandle[] = [];
  const running = new Map<string, () => void>(); // orderId → kill
  let active = 0;

  const run = async (h: OrderHandle) => {
    active++;
    void client.setStatus("busy").catch(() => {});
    const stopBeat = keepAlive(h);
    const prompt = buildPrompt(h.order, { address: client.record?.address ?? cafe.name, description: cafe.description });
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
        await h.decline(`command failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${result.stderr.trim().slice(-300) || "no output"}`);
      } else if (text.startsWith(DECLINE_MARKER)) {
        await h.decline(text.slice(DECLINE_MARKER.length).trim() || "not mine");
      } else if (!text) {
        await h.decline("command produced no output");
      } else {
        await h.reply(text);
      }
      log(`← ${h.order.orderId} (${result.code === 0 ? "ok" : `exit ${result.code}`})`);
    } catch (err) {
      await h.decline(`could not run command: ${(err as Error).message}`).catch(() => {});
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
    while (active < cafe.concurrency && queue.length) void run(queue.shift()!);
  };

  client.onOrder((h) => {
    void h.ack().catch(() => {});
    queue.push(h);
    pump();
  });
  client.onCancel(({ orderId, by }) => {
    const i = queue.findIndex((q) => q.order.orderId === orderId);
    if (i >= 0) queue.splice(i, 1);
    running.get(orderId)?.();
    log(`cancelled by ${by}: ${orderId}`);
  });

  const rec = await client.connect({ ...cafe, mode: "cli", cwd: dir, pid: process.pid });
  log(`serving as ${rec?.address} with: ${opts.exec}`);
  return {
    client,
    stop: () => {
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
