import { resolve } from "node:path";
import { loadIdentity } from "@cafe/protocol/cafe-file";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";
import { buildFollowup, buildPrompt, DECLINE_MARKER } from "../serve.ts";
import { ClaudeEngine } from "./claude.ts";
import { CodexEngine } from "./codex.ts";
import { CodexTuiEngine } from "./codex-tui.ts";
import type { Access, AgentKind, Engine } from "./engine.ts";

export type { Access, AgentKind } from "./engine.ts";
export const BRIDGED_AGENTS: readonly AgentKind[] = ["codex", "claude"];

export interface BridgeOptions {
  agent: AgentKind;
  dir: string;
  daemon: string;
  token?: string;
  /** Default read-only; `workspace-write` lets the agent edit files in `dir` (never more). */
  access?: Access;
  model?: string;
  /** Agent executable (tests use fakes). */
  bin?: string;
  /** Codex only: answer in a running Codex session (the TUI) instead of a headless thread (v3-1 phase 2). */
  tui?: boolean;
  /** With `tui`: the Codex thread to use (default: the newest one started in `dir`). */
  thread?: string;
  /** With `tui`: tuning for tests. */
  tuiTiming?: { injectTimeoutMs?: number; pollMs?: number };
  log?: (msg: string) => void;
}

const REPLY_NOTE = "Answer directly and concisely; your final message is sent back as the reply.";

/**
 * A native Codex / Claude Code Barista (v3-1). Registers the `.cafe` identity of `dir`, then runs each Order as
 * one turn of a Codex thread / Claude session. One turn at a time per process (the supervisor starts one process
 * per concurrency slot); later Orders queue. The Daemon stores which external session continues which Thread, so
 * Follow-ups and restarts keep the conversation.
 */
export async function runBridge(opts: BridgeOptions): Promise<{ client: CafeClient; stop: () => Promise<void> }> {
  const log = opts.log ?? ((m: string) => console.error(`[cafe ${opts.agent}] ${m}`));
  const dir = resolve(opts.dir);
  const { cafe, file } = loadIdentity(dir);
  if (!file) throw new Error(`no .cafe found in ${dir} or its parents; a Barista needs an identity`);
  if (cafe.role !== "barista") throw new Error(`${file} declares role "${cafe.role}"; set role: barista to receive questions`);
  const access: Access = opts.access ?? "read-only";
  const engineOpts = { dir, access, model: opts.model, bin: opts.bin, log };
  if (opts.tui && opts.agent !== "codex") throw new Error("--tui is for --agent codex; Claude Code sessions join through the cafe plugin (`cafe claude install`)");
  const engine: Engine = opts.tui
    ? new CodexTuiEngine({ ...engineOpts, thread: opts.thread, ...opts.tuiTiming })
    : opts.agent === "codex"
      ? new CodexEngine(engineOpts)
      : new ClaudeEngine(engineOpts);

  const client = new CafeClient({ daemon: opts.daemon, token: opts.token, reconnect: true, log });
  // An Order is acknowledged on arrival, so it needs heartbeats while it waits behind a long turn.
  const queue: Array<{ h: OrderHandle; stopBeat: () => void }> = [];
  let current: { orderId: string; abort: AbortController } | undefined;
  let stopped = false;

  const handle = async (h: OrderHandle) => {
    const abort = new AbortController();
    current = { orderId: h.order.orderId, abort };
    void client.setStatus("busy").catch(() => {});
    const stopBeat = keepAlive(h);
    const self = { address: client.record?.address ?? cafe.name, description: cafe.description };
    log(`→ ${h.order.from.address}: ${h.order.body.slice(0, 80)}`);
    try {
      const resume = await client.getSession(h.order.threadId, opts.agent).catch(() => undefined);
      const r = await engine.run({
        prompt: buildPrompt(h.order, self, REPLY_NOTE, h.attachments),
        followup: buildFollowup(h.order, h.attachments),
        resume,
        signal: abort.signal,
        onSession: (sid) => {
          if (sid !== resume) void client.setSession(h.order.threadId, opts.agent, sid).catch((e) => log(`cannot store session: ${(e as Error).message}`));
        },
      });
      if (abort.signal.aborted || r.status === "interrupted") {
        log(`✗ cancelled ${h.order.orderId}`);
        if (stopped) await h.decline("barista is shutting down", { unavailable: true }).catch(() => {});
        return;
      }
      if (r.status === "failed") {
        await h.decline(`${opts.agent} failed: ${r.error ?? "unknown error"}`, { unavailable: true });
      } else if (r.text.startsWith(DECLINE_MARKER)) {
        await h.decline(r.text.slice(DECLINE_MARKER.length).trim() || "not mine");
      } else if (!r.text) {
        await h.decline(`${opts.agent} produced no answer`, { unavailable: true });
      } else {
        await h.reply(r.text);
      }
      log(`← ${h.order.orderId} (${r.status})`);
    } catch (err) {
      await h.decline(`${opts.agent} bridge error: ${(err as Error).message}`, { unavailable: true }).catch(() => {});
    } finally {
      stopBeat();
      current = undefined;
    }
  };

  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        const next = queue.shift()!;
        next.stopBeat(); // `handle` takes over with its own heartbeat
        await handle(next.h);
      }
    } finally {
      running = false;
      if (!stopped) void client.setStatus("idle").catch(() => {});
    }
  };

  client.onOrder((h) => {
    void h.ack().catch(() => {});
    queue.push({ h, stopBeat: keepAlive(h) });
    void pump();
  });
  client.onCancel(({ orderId, by }) => {
    const i = queue.findIndex((q) => q.h.order.orderId === orderId);
    if (i >= 0) queue.splice(i, 1)[0]!.stopBeat();
    if (current?.orderId === orderId) current.abort.abort();
    log(`cancelled by ${by}: ${orderId}`);
  });

  // A TUI session works under the person's own permissions and approvals: no access level of ours to report.
  const rec = await client.connect(
    opts.tui
      ? { ...cafe, mode: "tui", agent: opts.agent, cwd: dir, pid: process.pid }
      : { ...cafe, mode: "headless", agent: opts.agent, access: access === "read-only" ? "read-only" : "write", cwd: dir, pid: process.pid },
  );
  log(`${opts.agent} barista ${rec?.address} ready (${opts.tui ? `answers in the running Codex session${opts.thread ? ` ${opts.thread}` : ""}` : access})`);
  return {
    client,
    stop: async () => {
      stopped = true;
      for (const q of queue.splice(0)) {
        q.stopBeat();
        await q.h.decline("barista is shutting down", { unavailable: true }).catch(() => {});
      }
      current?.abort.abort();
      // Let the interrupted turn report back before the connection goes.
      for (let i = 0; i < 50 && current; i++) await new Promise((r) => setTimeout(r, 100));
      await engine.close();
      client.close();
    },
  };
}
