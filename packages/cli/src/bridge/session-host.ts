import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAgentIdentity } from "@cafe/protocol/cafe-file";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";
import { buildFollowup, buildPrompt, DECLINE_MARKER } from "../serve.ts";

/**
 * The cafe side of a running interactive session that answers Orders (v3-1 phase 2). Used by the Claude Code
 * mod (`packages/claude-plugin`), which runs `cafe session-host` as a child of the session.
 *
 * Host → mod: one JSON object per line on stdout (`HostMessage`).
 * Mod → host: HTTP POSTs over the Unix socket named in `ready` (`/started`, `/done`, `/pause`).
 *
 * One Order is handed to the session at a time; the next one waits for `/done`. An Order the session does not
 * start within `injectTimeoutMs` (it is busy, stopped or closed) is declined as unavailable.
 */
export type HostMessage =
  | { type: "none"; reason: string }
  | { type: "ready"; address: string; socket: string }
  | { type: "status"; address?: string; paused: boolean }
  | { type: "order"; orderId: string; marker: string; text: string }
  | { type: "cancel"; orderId: string }
  | { type: "digest"; text: string };

export interface DoneBody {
  orderId: string;
  /** The session's final text for the turn. */
  text?: string;
  /** The turn was interrupted (Esc in the terminal, or our own cancel). */
  aborted?: boolean;
  /** The turn could not run or ended on an error (a refused submit, an API error). */
  error?: string;
}

export interface SessionHostOptions {
  /** Which agent hosts the session (shown on the Agents page): claude, codex, … */
  agent: string;
  dir: string;
  daemon: string;
  token?: string;
  /** pid of the interactive session (registered as the Agent's pid). */
  pid?: number;
  /** The session runs in the background with no terminal (default: detected from the process tree). */
  background?: boolean;
  /** How long a handed-over Order may wait to start (default CAFE_INJECT_TIMEOUT_MS or 120 s). */
  injectTimeoutMs?: number;
  /** Where the control socket goes (default: the OS temp dir). */
  socketDir?: string;
  send: (msg: HostMessage) => void;
  log?: (msg: string) => void;
}

const REPLY_NOTE = "Answer in this conversation; your final message of this turn is sent back as the reply.";

/** The line that starts every injected Order, so the session's turn can be matched to it. */
export const orderMarker = (orderId: string) => `[cafe order ${orderId}]`;

type ProcInfo = { ppid: number; command: string } | undefined;

function psInfo(pid: number): ProcInfo {
  const r = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout?.trim() ?? "");
  return m ? { ppid: Number(m[1]), command: m[2]! } : undefined;
}

/** `claude --bg-pty-host …`: the executable is claude and the flag is its own argument. */
const BG_HOST = /^(?:\S*\/)?claude(?:\.exe)?(?:\s+\S+)*?\s+--bg-pty-host(?:\s|$)/;

/**
 * Whether the session `pid` runs in the background: Claude Code's `--bg` runs the session under a
 * `claude --bg-pty-host …` process, with no terminal the user can switch to. Looks a few ancestors up;
 * any failure means "not known to be background".
 */
export function isBackgroundSession(pid: number, read: (pid: number) => ProcInfo = psInfo): boolean {
  try {
    for (let p = pid, i = 0; p > 1 && i < 4; i++) {
      const info = read(p);
      if (!info) return false;
      if (BG_HOST.test(info.command)) return true;
      p = info.ppid;
    }
  } catch {
    // ps missing or refused: unknown.
  }
  return false;
}

export async function runSessionHost(opts: SessionHostOptions): Promise<{ client?: CafeClient; socket?: string; stop: () => Promise<void> }> {
  const log = opts.log ?? ((m: string) => console.error(`[cafe session] ${m}`));
  const dir = resolve(opts.dir);
  const { cafe, file, identity: baseIdentity } = loadAgentIdentity(dir);
  if (!file || baseIdentity.role !== "barista") {
    opts.send({ type: "none", reason: !file ? `no .cafe in ${dir} or its parents` : `${file} is not a barista` });
    return { stop: async () => {} };
  }
  const injectTimeoutMs = opts.injectTimeoutMs ?? (Number(process.env.CAFE_INJECT_TIMEOUT_MS) || 120_000);

  const client = new CafeClient({ daemon: opts.daemon, token: opts.token, reconnect: true, log });
  // An Order is acknowledged on arrival, so it needs heartbeats while it waits for the session's current turn.
  const queue: Array<{ h: OrderHandle; stopBeat: () => void }> = [];
  /** Threads this session has answered in: their follow-ups need no repeated history. */
  const answered = new Set<string>();
  let current: { h: OrderHandle; started: boolean; cancelled: boolean; timer?: NodeJS.Timeout; stopBeat: () => void } | undefined;
  let paused = false;
  let stopped = false;
  // v4-13: deliver the team playbook once, and a roster change with the next Order. Neither
  // starts a turn of its own (the session's context stays owned by the person).
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

  const finish = () => {
    if (!current) return;
    clearTimeout(current.timer);
    current.stopBeat();
    current = undefined;
    if (paused || stopped) {
      if (paused && !stopped) client.close(); // paused while answering: leave now that it is done
      return;
    }
    void client.setStatus("idle").catch(() => {});
    pump();
  };

  const pump = () => {
    if (current || paused || stopped) return;
    const next = queue.shift();
    if (!next) return;
    next.stopBeat(); // `current` takes over with its own heartbeat
    const h = next.h;
    const self = { address: client.record?.address ?? baseIdentity.name, description: baseIdentity.description };
    const notes = [teamNote, ...rosterNotes.splice(0)].filter(Boolean) as string[];
    teamNote = undefined;
    const body = `${notes.length ? `${notes.join("\n\n")}\n\n` : ""}${answered.has(h.order.threadId) ? buildFollowup(h.order, h.attachments) : buildPrompt(h.order, self, REPLY_NOTE, h.attachments)}`;
    const marker = orderMarker(h.order.orderId);
    current = { h, started: false, cancelled: false, stopBeat: keepAlive(h) };
    current.timer = setTimeout(() => {
      if (!current || current.h !== h || current.started) return;
      log(`✗ not started within ${injectTimeoutMs} ms: ${h.order.orderId}`);
      opts.send({ type: "cancel", orderId: h.order.orderId });
      void h.decline("the session did not take the question (busy, stopped or closed)", { unavailable: true }).catch(() => {});
      finish();
    }, injectTimeoutMs);
    void client.setStatus("busy").catch(() => {});
    log(`→ ${h.order.from.address}: ${h.order.body.slice(0, 80)}`);
    opts.send({ type: "order", orderId: h.order.orderId, marker, text: `${marker}\n${body}` });
  };

  const onDone = async (b: DoneBody) => {
    if (!current || current.h.order.orderId !== b.orderId) return;
    const { h, cancelled } = current;
    try {
      if (cancelled) return; // the asker already knows
      const text = (b.text ?? "").trim();
      if (b.error) await h.decline(`the session could not answer: ${b.error}`, { unavailable: true });
      else if (b.aborted) await h.decline("the answer was interrupted in the terminal", { unavailable: true });
      else if (text.startsWith(DECLINE_MARKER)) await h.decline(text.slice(DECLINE_MARKER.length).trim() || "not mine");
      else if (!text) await h.decline("the session produced no answer", { unavailable: true });
      else {
        await h.reply(text);
        answered.add(h.order.threadId);
      }
      log(`← ${b.orderId}${b.aborted ? " (aborted)" : b.error ? ` (${b.error})` : ""}`);
    } catch (err) {
      log(`cannot report ${b.orderId}: ${(err as Error).message}`);
    } finally {
      finish();
    }
  };

  const setPaused = async (p: boolean) => {
    if (p === paused) return;
    paused = p;
    if (p) {
      // Leave the network: queued Orders go back unanswered, the running one finishes.
      for (const q of queue.splice(0)) {
        q.stopBeat();
        await q.h.decline("the session stopped taking questions", { unavailable: true }).catch(() => {});
      }
      if (!current) client.close();
    } else {
      await client.connect(identity());
    }
    opts.send({ type: "status", address: client.record?.address, paused });
  };

  client.onOrder((h) => {
    void h.ack().catch(() => {});
    if (paused || stopped) {
      void h.decline("the session stopped taking questions", { unavailable: true }).catch(() => {});
      return;
    }
    queue.push({ h, stopBeat: keepAlive(h) });
    pump();
  });
  client.onDigest((d) => {
    const lines = d.threads.map((t) => `- ${t.status} ${t.summary.slice(0, 120)} (${t.replies} replies, ${t.declined} declined)${t.closedAt ? " closed" : ""}`);
    const text = `cafe channel #${d.channel} digest${d.partial ? " (partial: root offline)" : ""}: ${d.threads.length} changed Thread(s)${d.omitted ? `, ${d.omitted} omitted` : ""}\n${lines.join("\n")}\nThis is an observation, not an Order. To act, call cafe_ask with a fresh question.`;
    if (!paused && !stopped) opts.send({ type: "digest", text });
  });
  client.onCancel(({ orderId, by }) => {
    const i = queue.findIndex((q) => q.h.order.orderId === orderId);
    if (i >= 0) queue.splice(i, 1)[0]!.stopBeat();
    if (current?.h.order.orderId === orderId) {
      current.cancelled = true;
      opts.send({ type: "cancel", orderId });
      // Not started yet: nothing will report back, so move on now.
      if (!current.started) finish();
    }
    log(`cancelled by ${by}: ${orderId}`);
  });
  let ready = false;
  client.onConnect((rec) => {
    if (ready) opts.send({ type: "status", address: rec?.address, paused });
  });

  const pid = opts.pid ?? process.ppid;
  const background = opts.background ?? isBackgroundSession(pid);
  const identity = () => ({ ...baseIdentity, mode: "tui" as const, agent: opts.agent, cwd: dir, pid, ...(background ? { background } : {}) });

  // Control socket for the mod. Unix socket, owner-only.
  const socket = join(opts.socketDir ?? tmpdir(), `cafe-session-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
  const server: Server = createServer(async (req, res) => {
    try {
      const body = await readJson(req);
      if (req.method !== "POST") throw new Error("POST only");
      if (req.url === "/started") {
        if (current && current.h.order.orderId === body.orderId) {
          current.started = true;
          clearTimeout(current.timer);
        }
      } else if (req.url === "/done") await onDone(body as unknown as DoneBody);
      else if (req.url === "/pause") await setPaused(!!body.paused);
      else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, paused, address: client.record?.address }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  });
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(socket, () => ok()));
  chmodSync(socket, 0o600);

  const rec = await client.connect(identity());
  log(`${opts.agent} session ${rec?.address} ready in ${dir}`);
  opts.send({ type: "ready", address: rec?.address ?? baseIdentity.name, socket });
  ready = true;

  return {
    client,
    socket,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const q of queue.splice(0)) {
        q.stopBeat();
        await q.h.decline("the session closed", { unavailable: true }).catch(() => {});
      }
      if (current && !current.cancelled) await current.h.decline("the session closed", { unavailable: true }).catch(() => {});
      if (current) finish();
      server.close();
      if (existsSync(socket)) rmSync(socket, { force: true });
      client.close();
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4 * 1024 * 1024) throw new Error("body too large");
  }
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}
