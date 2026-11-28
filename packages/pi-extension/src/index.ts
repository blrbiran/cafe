import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { compactHistoryText, DEFAULT_PORT, orderReplyView, type AgentRecord, type Attachment, type ChannelDigest, type Order, type ThreadEnvelope } from "@cafe/protocol";
import { loadAgentIdentity, loadTeamMember, managedAgentResumeStore, readCafeFile } from "@cafe/protocol/cafe-file";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";

const STATUS_KEY = "cafe";
const COLLECTED_RESULT_CHARS = 1500;

export function daemonAddr(): string {
  return process.env.CAFE_DAEMON ?? `127.0.0.1:${DEFAULT_PORT}`;
}

async function healthy(addr: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${addr}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reply attachments are uploaded to the local daemon first, then referenced by metadata (v4-1 phase 2). */
async function uploadAttachment(path: string): Promise<Attachment> {
  if (!existsSync(path)) throw new Error(`attachment not found: ${path}`);
  const name = basename(path);
  const res = await fetch(`http://${daemonAddr()}/api/artifacts?name=${encodeURIComponent(name)}&mime=application/octet-stream`, {
    method: "POST",
    body: readFileSync(path),
    headers: process.env.CAFE_TOKEN ? { authorization: `Bearer ${process.env.CAFE_TOKEN}` } : {},
  });
  const body = (await res.json().catch(() => ({}))) as { attachment?: Attachment; error?: string; message?: string };
  if (!res.ok || !body.attachment) throw new Error(`upload ${path} failed: ${body.error ?? res.status}: ${body.message ?? ""}`.trim());
  return body.attachment;
}

/** The `cafe` CLI entry: the installed `@cafe/cli`, else the sibling workspace package. */
function cafeCliPath(): string {
  // Published package: dist/pi-extension.js, with the CLI entry in ../bin/cafe.js.
  const bundled = fileURLToPath(new URL("../bin/cafe.js", import.meta.url));
  if (existsSync(bundled)) return bundled;
  try {
    return fileURLToPath(import.meta.resolve("@cafe/cli"));
  } catch {
    return fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
  }
}

/**
 * Make sure a local Daemon is running. If `addr` is loopback and nothing answers,
 * run `cafe daemon start` detached (it uses the installed autostart service if
 * there is one, else spawns the daemon) and poll /api/health for up to `timeoutMs`.
 */
export async function ensureDaemon(addr = daemonAddr(), timeoutMs = 5000): Promise<boolean> {
  if (await healthy(addr)) return true;
  const host = addr.split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  const cli = cafeCliPath();
  // Under oh-my-pi (Bun) process.execPath is the omp binary itself: start the daemon with Node.
  const node = process.versions.bun ? (process.env.CAFE_NODE ?? "node") : process.execPath;
  const child = spawn(node, [cli, "daemon", "start"], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    if (await healthy(addr)) return true;
  }
  return false;
}

/** Running inside oh-my-pi (a Bun build of pi) rather than pi on Node. Override with CAFE_HOST_AGENT=pi|omp. */
export function isOmp(): boolean {
  return process.env.CAFE_HOST_AGENT ? process.env.CAFE_HOST_AGENT === "omp" : !!process.versions.bun;
}

/** oh-my-pi's agent_end has no `aborted` flag: the last assistant message says how it stopped. */
export function runAborted(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string };
    if (m?.role === "assistant") return m.stopReason === "aborted";
  }
  return false;
}

/** Text of the last assistant message in a run's messages. */
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((c: { type?: string }) => c?.type === "text")
        .map((c: { text?: string }) => c.text ?? "")
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}

/** Compact transcript of the earlier turns of a Thread, oldest first. */
export function formatHistory(history: Order["history"]): string {
  return history
    .map((h) => `[${h.role} ${h.from}]\n${compactHistoryText(h.text)}`)
    .join("\n\n");
}

export function orderPrompt(order: Order, self?: AgentRecord, attachments?: Array<{ name: string; mime: string; size: number; path?: string }>): string {
  const to = self ? ` to you (${self.address})` : "";
  const head =
    order.turn > 1
      ? [
          `☕ cafe follow-up (turn ${order.turn}) from ${order.from.address}${to}`,
          `orderId: ${order.orderId} · threadId: ${order.threadId}`,
          "",
          "This continues an earlier conversation in this thread. You may have handled other work since then, so rely on this transcript, not your memory:",
          "",
          formatHistory(order.history),
          "",
          "--- new message ---",
        ]
      : [`☕ cafe Order from ${order.from.address}${to}`, `orderId: ${order.orderId} · threadId: ${order.threadId}`, ""];
  return [
    ...head,
    ...(order.parentContext && order.parentThreadId ? [`Parent task (${order.parentThreadId}):\n${order.parentContext}`, ""] : []),
    ...(order.clarificationRecipient ? [`This is the person's answer to your clarification. Continue the original work. If its Order already closed, use cafe_reply with reportThreadId=${order.parentThreadId} and reportOrderId=${order.parentOrderId} to send the result.`, ""] : []),
    order.body,
    ...(attachments?.length ? ["", "Attachments on this machine:", ...attachments.map((a) => `- ${a.name} (${a.mime}, ${a.size} bytes)${a.path ? `: ${a.path}` : ""}`)] : []),
    "",
    "Answer this Order directly; your final reply in this turn is sent back to the asker.",
    "If it is outside your responsibility or scope, call cafe_decline with a short reason instead of answering.",
    "For long work, you may send interim progress with cafe_reply.",
    "An unrelated new question → cafe_ask without escalate. To ask the sender of THIS Order a clarifying question, call cafe_ask with escalate=true (it creates a sub-thread; do not pass threadId). To assign linked work, call cafe_ask with delegate=true and an explicit to.",
    "A new Order defaults to this agent's home channel; pass channel to post elsewhere (channels are scopes, not secrets).",
  ].join("\n");
}

function describeEvent(env: ThreadEnvelope, addr: (id: string) => string): string | undefined {
  const ev = env.event;
  switch (ev.type) {
    case "order.replied":
    case "order.overridden": {
      const reply = orderReplyView(ev);
      if (!reply) return undefined;
      const speaker = reply.source === "operator" ? `an operator override for ${addr(reply.agentId)}` : addr(reply.agentId);
      return `☕ ${reply.final ? "Reply" : "Interim reply"} from ${speaker} (threadId ${env.threadId}):\n\n${reply.text}`;
    }
    case "order.declined":
      return `☕ ${addr(ev.agentId)} declined (threadId ${env.threadId}): ${ev.reason}`;
    case "order.closed":
      return `☕ Order ${env.orderId} closed: ${ev.status}. To follow up with whoever answered, call cafe_ask with threadId "${env.threadId}".`;
    default:
      return undefined;
  }
}

function finalReplyWasRejected(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "not_registered" || code === "not_a_target" || code === "not_found" || code === "bad_assignment" || code === "bad_request";
}

interface Working {
  handle: OrderHandle;
  stopHeartbeat: () => void;
  declined: boolean;
  /** pi has processed the injected cafe-order message (seen in message_end). */
  seen: boolean;
  /** A human message arrived after ours: later assistant text answers the human, not the Order. */
  frozen: boolean;
  lastText?: string;
  finalSubmission?: Promise<void>;
  /** Inject watchdog (cleared once the message is seen). */
  watchdog?: ReturnType<typeof setTimeout>;
}

const DEFAULT_INJECT_TIMEOUT_MS = 120_000;

/** Heartbeat interval for Orders held by this agent. Env: CAFE_HEARTBEAT_MS (tests). */
function heartbeatMs(): number | undefined {
  const v = Number(process.env.CAFE_HEARTBEAT_MS);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** How long an injected Order may wait unprocessed while pi is idle. Env: CAFE_INJECT_TIMEOUT_MS. */
export function injectTimeoutMs(): number {
  const v = Number(process.env.CAFE_INJECT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INJECT_TIMEOUT_MS;
}

/** True if `m` is the injected cafe-order custom message for `orderId` (pi CustomMessage shape). */
export function isOrderMessage(m: unknown, orderId: string): boolean {
  const x = m as { role?: string; customType?: string; details?: { order?: { orderId?: string } } };
  return x?.role === "custom" && x.customType === "cafe-order" && x.details?.order?.orderId === orderId;
}

/** Retry a daemon call across a reconnect (the client re-registers with the same agentId). */
async function persist(fn: () => Promise<void>, tries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * cafe pi extension: registers this session with the local Daemon as a Barista
 * (or Customer), serves incoming Orders when idle, and exposes cafe_* tools.
 */
export default function cafe(pi: ExtensionAPI) {
  let client: CafeClient | undefined;
  let ctxRef: ExtensionContext | undefined;
  let role: "barista" | "customer" = "customer";
  /** Why cafe is unavailable in this session (bad .cafe, unreachable daemon); cleared on startup. */
  let startupError: string | undefined;
  /** Received Orders waiting their turn; acked and heartbeating from arrival. */
  const queue: Array<{ handle: OrderHandle; stopHeartbeat: () => void }> = [];
  let current: Working | undefined;
  let draining = false;
  /** Open Orders this session asked: threadId → the Order (and its waiter in wait mode). */
  type Asked = { orderId: string; onEvent?: (env: ThreadEnvelope) => void; collected?: Map<string, string> };
  const asked = new Map<string, Asked>();
  /** orderIds already queued or served, so a redelivery after a reconnect is not run twice. */
  const known = new Set<string>();
  /** Events that arrive before order/create returns (the daemon fans out during creation). */
  const early = new Map<string, ThreadEnvelope[]>();
  let registry: AgentRecord[] = [];
  const observationInterval = 60_000;
  const failedOrders = new Map<string, Pick<ChannelDigest["threads"][number], "threadId" | "summary">>();
  const observedOrders = new Set<string>();
  let lastObservation = -Infinity;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;

  function observeFailures(): void {
    if (!client?.record?.observer || !failedOrders.size || current || queue.length || !isIdle()) return;
    clearTimeout(observationTimer);
    observationTimer = undefined;
    const wait = lastObservation + observationInterval - Date.now();
    if (wait > 0) {
      observationTimer = setTimeout(observeFailures, wait);
      return;
    }
    const failures = [...failedOrders.entries()];
    const lines = failures.map(([orderId, t]) => `- Order ${orderId} in Thread ${t.threadId}: ${t.summary.slice(0, 120)}`);
    pi.sendMessage({
      customType: "cafe-observation",
      content: `Review these failed Cafe Orders. Summarize what needs attention. Open a Thread for more context before drawing conclusions.\n${lines.join("\n")}`,
      display: true,
      details: { orders: failures.map(([orderId]) => orderId) },
    }, { triggerTurn: true, deliverAs: "followUp" });
    lastObservation = Date.now();
    failedOrders.clear();
    for (const [id] of failures) observedOrders.add(id);
    while (observedOrders.size > 512) observedOrders.delete(observedOrders.values().next().value!);
  }

  const addrOf = (id: string) => registry.find((r) => r.agentId === id)?.address ?? id;
  /** Refresh the Registry cache used to show Addresses instead of agent ids. */
  const refreshRegistry = async (c: CafeClient) => {
    try {
      registry = await c.agents();
    } catch {
      // best effort
    }
  };
  const isIdle = () => {
    try {
      return ctxRef?.isIdle() ?? true;
    } catch {
      return true;
    }
  };
  const setUiStatus = (text: string | undefined) => {
    if (ctxRef?.hasUI) ctxRef.ui.setStatus(STATUS_KEY, text);
  };

  function onThreadEvent(env: ThreadEnvelope): void {
    const entry = asked.get(env.threadId);
    if (!entry) {
      const buf = early.get(env.threadId) ?? [];
      buf.push(env);
      early.set(env.threadId, buf.slice(-50));
      if (early.size > 100) early.delete(early.keys().next().value!);
      return;
    }
    if (env.orderId !== entry.orderId) return;
    if (entry.onEvent) return entry.onEvent(env);
    let text = describeEvent(env, addrOf);
    const closed = env.event.type === "order.closed";
    if (entry.collected) {
      if (!closed) {
        if (text && (env.event.type === "order.declined" || orderReplyView(env.event)?.final === true)) {
          entry.collected.set(env.eventId, text.slice(0, COLLECTED_RESULT_CHARS));
          if (entry.collected.size > 20) entry.collected.delete(entry.collected.keys().next().value!);
        }
        return;
      }
      text = [...entry.collected.values(), "", text, "See the Thread for the complete results."].join("\n\n");
    }
    if (text) {
      pi.sendMessage(
        { customType: "cafe-reply", content: text, display: true, details: { threadId: env.threadId, orderId: env.orderId, event: env.event.type } },
        { triggerTurn: !closed || entry.collected !== undefined, deliverAs: "followUp" },
      );
    }
    if (closed) asked.delete(env.threadId);
  }

  function track(threadId: string, entry: Asked): void {
    asked.set(threadId, entry);
    const buf = early.get(threadId);
    early.delete(threadId);
    for (const env of buf ?? []) onThreadEvent(env);
  }

  async function drain(): Promise<void> {
    if (draining || current || !client || !isIdle()) return;
    const next = queue.shift();
    if (!next) {
      void client.setStatus("idle").catch(() => {});
      observeFailures();
      return;
    }
    draining = true;
    try {
      current = { handle: next.handle, stopHeartbeat: next.stopHeartbeat, declined: false, seen: false, frozen: false };
      armWatchdog(current, injectTimeoutMs());
      void client.setStatus("busy").catch(() => {});
      pi.sendMessage(
        { customType: "cafe-order", content: orderPrompt(next.handle.order, client.record, next.handle.attachments), display: true, details: { order: next.handle.order } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } finally {
      draining = false;
    }
  }

  /** Drop `w` as the current Order without replying (timeout, cancel, shutdown). */
  function release(w: Working): void {
    if (current === w) current = undefined;
    w.stopHeartbeat();
    clearTimeout(w.watchdog);
  }

  /**
   * Stuck-order watchdog: if pi never processes the injected message (it never reaches
   * message_end) and pi sits idle past the timeout, decline and move on. While pi is busy
   * the message may legitimately be queued behind other work, so re-check later. Once the
   * message is seen the watchdog is off: long work is covered by heartbeats.
   */
  function armWatchdog(w: Working, ms: number): void {
    const startedAt = Date.now();
    const check = () => {
      if (current !== w || w.seen) return;
      const waited = Date.now() - startedAt;
      if (waited >= ms && isIdle()) {
        release(w);
        void persist(() => w.handle.decline(`not picked up by the agent within ${Math.round(ms / 1000)}s`, { unavailable: true }), 3).catch(() => {});
        void drain();
        return;
      }
      w.watchdog = setTimeout(check, waited >= ms ? Math.max(250, ms / 4) : ms - waited);
    };
    w.watchdog = setTimeout(check, ms);
  }

  function onCancelled(x: { orderId: string; threadId: string; by: string }): void {
    const i = queue.findIndex((q) => q.handle.order.orderId === x.orderId);
    if (i >= 0) {
      // Still queued: the daemon already closed it; drop silently.
      queue.splice(i, 1)[0]!.stopHeartbeat();
      return;
    }
    const w = current;
    if (!w || w.handle.order.orderId !== x.orderId) return;
    w.declined = true; // never reply
    release(w);
    if (ctxRef?.hasUI) ctxRef.ui.notify(`☕ cafe Order from ${w.handle.order.from.address} was cancelled by ${x.by}`, "warning");
    // Abort only the run that is working on this Order; a not-yet-processed message
    // may still sit behind a human's run, which must not be interrupted.
    if (w.seen && !isIdle()) {
      try {
        ctxRef?.abort();
      } catch {
        // stale ctx
      }
    } else void drain();
  }

  async function finish(aborted: boolean): Promise<void> {
    const w = current;
    if (!w) return;
    release(w);
    if (w.declined || await w.finalSubmission?.then(() => true, (error) => !finalReplyWasRejected(error))) return;
    const text = w.lastText;
    if (!text) {
      const reason = aborted
        ? "aborted by the operator"
        : w.frozen
          ? "human took over the run before an answer was produced"
          : "no answer produced";
      await persist(() => w.handle.decline(reason, { unavailable: true })).catch(() => {});
    } else await persist(() => w.handle.reply(text, true)).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    startupError = undefined;
    if (client) return;
    try {
      const { identity } = loadAgentIdentity(ctx.cwd);
      role = identity.role;
      const addr = daemonAddr();
      if (!(await ensureDaemon(addr))) {
        startupError = "daemon unreachable";
        setUiStatus("☕ cafe: daemon unreachable");
        return;
      }
      const c = new CafeClient({ daemon: addr, token: process.env.CAFE_TOKEN, reconnect: true, resumeStore: managedAgentResumeStore() });
      c.onOrder((h) => {
        if (known.has(h.order.orderId)) return;
        known.add(h.order.orderId);
        // Ack on receipt (delivery confirmation) and heartbeat while queued, so an Order
        // waiting behind long work is not failed by the daemon's ack/heartbeat timers.
        void persist(() => h.ack(), 3).catch(() => {});
        queue.push({ handle: h, stopHeartbeat: keepAlive(h, heartbeatMs()) });
        void drain();
      });
      c.onThreadEvent(onThreadEvent);
      c.onDigest((d: ChannelDigest) => {
        // An observation can be displayed without queuing an extra model turn.
        const lines = d.threads.map((t) => `- ${t.status} ${t.summary.slice(0, 120)} (${t.replies} replies, ${t.declined} declined)${t.closedAt ? " closed" : ""}`);
        pi.sendMessage(
          {
            customType: "cafe-digest",
            content: `☕ cafe channel #${d.channel} digest${d.partial ? " (partial: root offline)" : ""}: ${d.threads.length} changed Thread(s)${d.omitted ? `, ${d.omitted} omitted` : ""}\n${lines.join("\n")}\nThis is an observation, not an Order. To act, call cafe_ask with a fresh question.`,
            display: true,
            details: { digest: d },
          },
          { triggerTurn: false },
        );
        // The queue stays capped at 64; add overflow first so visible failures are retained.
        for (const entry of [...(d.omittedFailures ?? []).slice().reverse(), ...d.threads]) {
          const { orderId } = entry;
          if (entry.status !== "failed" || entry.closedAt === undefined || !orderId || observedOrders.has(orderId)) continue;
          failedOrders.set(orderId, entry);
        }
        while (failedOrders.size > 64) failedOrders.delete(failedOrders.keys().next().value!);
        observeFailures();
      });
      c.onTeamContext((tc) => {
        // The playbook is a one-time orientation, not a task: display it without starting a turn.
        pi.sendMessage(
          { customType: "cafe-team", content: `☕ cafe team ${tc.team} (#${tc.channel})\n\n${tc.playbook}`, display: true, details: { team: tc.team } },
          { triggerTurn: false },
        );
      });
      c.onRoster((r) => {
        const change = [...r.change.added.map((n) => `+${n}`), ...r.change.removed.map((n) => `-${n}`), ...r.change.updated.map((n) => `~${n}`)].join(", ");
        const text = r.removedTeam
          ? `☕ cafe team ${r.team} was removed; stop treating yourself as its member.`
          : `☕ cafe team ${r.team} roster changed (revision ${r.revision}): ${change || "members updated"}. Now: ${r.members.map((m) => m.name).join(", ")}.`;
        pi.sendMessage({ customType: "cafe-team", content: text, display: true, details: { roster: r } }, { triggerTurn: false });
      });
      c.onCancel(onCancelled);
      c.onConnect((rec) => {
        setUiStatus(rec ? `☕ ${rec.address}` : "☕ cafe");
        void refreshRegistry(c);
        for (const [threadId, entry] of asked) {
          if (!entry.collected) continue;
          void c.resumeOrderResults(threadId, entry.orderId).then((events) => {
            for (const event of events) onThreadEvent(event);
          }).catch(() => {
            ctxRef?.ui.notify(`cafe: could not resume results for ${threadId}; use /cafe thread ${threadId} to check`, "warning");
          });
        }
      });
      try {
        await c.connect({ ...identity, concurrency: 1, mode: ctx.hasUI && ctx.mode === "tui" ? "tui" : "headless", agent: isOmp() ? "omp" : "pi", cwd: ctx.cwd, pid: process.pid });
        client = c;
        // A capability downgrade at registration (team/channel/observer) must be visible, not logged.
        for (const w of c.drainWarnings()) {
          try {
            ctx.ui.notify(`cafe: ${w}`, "warning");
          } catch {
            // headless
          }
        }
      } catch (err) {
        startupError = `cannot connect to the cafe daemon at ${addr}: ${(err as Error).message}`;
        setUiStatus(`☕ cafe: ${(err as Error).message}`);
      }
    } catch (err) {
      // A broken .cafe must be visible: pi itself only prints a generic "Extension error".
      startupError = (err as Error).message;
      setUiStatus(`☕ cafe: not connected (${startupError})`);
      try {
        ctx.ui.notify(`cafe is unavailable: ${startupError}`, "warning");
      } catch {
        // best effort
      }
    }
  });

  pi.on("session_shutdown", async () => {
    const c = client;
    client = undefined;
    startupError = undefined;
    clearTimeout(observationTimer);
    observationTimer = undefined;
    failedOrders.clear();
    observedOrders.clear();
    lastObservation = -Infinity;
    if (current) {
      const w = current;
      release(w);
      await w.handle.decline("agent session shutting down", { unavailable: true }).catch(() => {});
    }
    for (const q of queue.splice(0)) {
      q.stopHeartbeat();
      await q.handle.decline("agent session shutting down", { unavailable: true }).catch(() => {});
    }
    c?.close();
  });

  pi.on("agent_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (client) void client.setStatus("busy").catch(() => {});
  });

  // Correlate by content, not timing: the Order's run is the one whose messages contain
  // our cafe-order custom message. The Reply is the last assistant text after it and
  // before any later human (role "user") message. A run without it never replies.
  pi.on("message_end", async (event) => {
    const w = current;
    if (!w) return;
    const m = event.message as { role?: string };
    if (isOrderMessage(m, w.handle.order.orderId)) {
      w.seen = true;
      clearTimeout(w.watchdog);
      w.frozen = false;
      w.lastText = undefined;
      return;
    }
    if (!w.seen || w.frozen) return;
    if (m.role === "user") w.frozen = true;
    else if (m.role === "assistant") {
      const t = lastAssistantText([m]);
      if (t) w.lastText = t;
    }
  });

  async function onRunEnd(aborted: boolean, ctx: ExtensionContext): Promise<void> {
    ctxRef = ctx;
    if (current?.seen) await finish(aborted);
    if (queue.length) await drain();
    else if (client && !current) {
      void client.setStatus("idle").catch(() => {});
      observeFailures();
    }
  }

  if (isOmp()) {
    // oh-my-pi has no agent_settled: a run is over at the agent_end that will not continue.
    (pi as any).on("agent_end", async (event: { messages?: unknown[]; willContinue?: boolean }, ctx: ExtensionContext) => {
      if (event.willContinue) return;
      await onRunEnd(runAborted(event.messages ?? []), ctx);
    });
  } else {
    pi.on("agent_settled", async (event, ctx) => onRunEnd(event.aborted, ctx));
  }

  pi.on("before_agent_start", async (event) => {
    const rec = client?.record;
    const connectedLine = rec
      ? `You are connected to the cafe agent network as ${rec.address} (role: ${role}).`
      : startupError
        ? `cafe is unavailable in this session: ${startupError}. Do not claim to reach the cafe network; tell the user and suggest fixing .cafe (run \`cafe init\`) or the daemon first.`
        : "You can reach the cafe agent network.";
    const lines = [connectedLine];
    if (!startupError) {
      lines.push(
        "Other agents on the network may know things you don't. Use cafe_agents to see who is registered and cafe_ask to send them a question (non-blocking by default; replies arrive as cafe-reply messages; pass threadId to follow up with whoever answered).",
      );
    }
    if (role === "barista") lines.push("Messages of type cafe-order are questions from other agents: answer them, or call cafe_decline if they are not your responsibility.");
    // pi exposes named sections; oh-my-pi passes the prompt as a string[] to extend.
    const ev = event as unknown as { systemPromptOptions?: { sections: Record<string, string> }; systemPrompt?: string[] };
    if (ev.systemPromptOptions?.sections) ev.systemPromptOptions.sections.cafe = lines.join("\n");
    else if (Array.isArray(ev.systemPrompt)) return { systemPrompt: [...ev.systemPrompt, lines.join("\n")] } as never;
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  pi.registerMessageRenderer<{ order: Order }>("cafe-order", (message, options, theme) => {
    const order = message.details?.order;
    const kind = order && order.turn > 1 ? `Follow-up (turn ${order.turn})` : "Order";
    const head = theme.fg("accent", `☕ ${kind} from ${order?.from.address ?? "?"}`);
    const body = order?.body ?? (typeof message.content === "string" ? message.content : "");
    return new Text(`${head}\n${options.expanded ? body : body.split("\n").slice(0, 6).join("\n")}`, 1, 0);
  });
  pi.registerMessageRenderer("cafe-reply", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const [first = "", ...rest] = content.split("\n");
    return new Text(`${theme.fg("accent", first)}${rest.length ? `\n${rest.join("\n")}` : ""}`, 1, 0);
  });

  // ---------------------------------------------------------------------------
  // /cafe command (pi / omp)
  // ---------------------------------------------------------------------------

  try {
    pi.registerCommand("cafe", {
      description: "cafe network: agents | ask <question> | status | thread <id> | help",
      handler: async (args, ctx) => {
        const notify = (message: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, type);
        const full = args.trim();
        const cmd = full.split(/\s+/)[0] ?? "";
        const rest = full.slice(cmd.length).trim();
        try {
          switch (cmd) {
            case "agents": {
              const list = await requireClient().agents();
              notify(
                list.length
                  ? list.map((a) => `${a.displayName ?? a.name} · ${a.address} · ${a.role}${a.status ? ` · ${a.status}` : ""}${a.description ? ` — ${a.description}` : ""}`).join("\n")
                  : "no agents registered",
              );
              break;
            }
            case "ask": {
              if (!rest) return notify("usage: /cafe ask <question>", "warning");
              const c = requireClient();
              await refreshRegistry(c);
              const res = await c.ask({ body: rest });
              track(res.threadId, { orderId: res.orderId });
              notify(`Order ${res.orderId} sent to ${res.decision.targets.map(addrOf).join(", ") || "nobody"} (thread ${res.threadId}). Replies arrive as cafe-reply messages.`);
              break;
            }
            case "status": {
              const parts = [
                `role: ${role}`,
                `daemon: ${daemonAddr()}`,
                client?.connected ? `connected as ${client.record?.address ?? "?"}` : `not connected${startupError ? ` (${startupError})` : ""}`,
                `queue: ${queue.length}`,
                `working on: ${current ? current.handle.order.orderId : "nothing"}`,
              ];
              if (client?.connected) {
                try {
                  parts.push(`agents: ${(await client.agents()).length}`);
                } catch {
                  // registry is optional here
                }
              }
              notify(parts.join("\n"));
              break;
            }
            case "thread": {
              if (!rest) return notify("usage: /cafe thread <threadId>", "warning");
              const res = await fetch(`http://${daemonAddr()}/api/threads/${encodeURIComponent(rest)}`);
              if (!res.ok) return notify(`thread ${rest}: HTTP ${res.status}`, "error");
              const body = (await res.json()) as { events?: ThreadEnvelope[] };
              const lines = (body.events ?? [])
                .slice(-20)
                .map((e) => describeEvent(e, addrOf))
                .filter((l): l is string => !!l);
              notify(lines.join("\n") || "(no events)");
              break;
            }
            default:
              notify("cafe commands:\n/cafe agents\n/cafe ask <question>\n/cafe status\n/cafe thread <id>\n/cafe help");
          }
        } catch (err) {
          notify((err as Error).message, "error");
        }
      },
    });
  } catch (err) {
    // A user-owned /cafe command wins; the tools and the skill still work.
    console.warn(`cafe: /cafe command not registered: ${(err as Error).message}`);
  }

  // v4-11: choose the roster member this session registers as. A TUI cannot isolate context, so the
  // selection is picked up on the next session start; we set the env var and say so.
  try {
    pi.registerCommand("cafe-team", {
      description: "list the team roster or select the member this session registers as",
      handler: async (args, ctx) => {
        const teamDir = process.env.CAFE_TEAM_DIR;
        if (!teamDir) return ctx.ui.notify('Restart this session from your shell with CAFE_TEAM_DIR="/path/to/roster" before your usual pi or omp command.', "warning");
        const name = args.trim();
        try {
          if (!name) {
            const doc = readCafeFile(`${teamDir}/.cafe`);
            const members = doc.team?.members.map((m) => `${m.name} (${m.duty ?? "member"}${m.observer ? ", observer" : ""})`).join(", ");
            return ctx.ui.notify(`roster: ${members || "(no members)"}\nselect with /cafe-team <name>`);
          }
          const loaded = loadTeamMember(teamDir, name);
          process.env.CAFE_TEAM_MEMBER = name;
          ctx.ui.notify(`will register as ${name} (${loaded.member.duty ?? "member"}) on the next session start. A TUI cannot isolate context, so restart the session (or /reload-plugins) for the role to take effect.`);
        } catch (err) {
          ctx.ui.notify((err as Error).message, "error");
        }
      },
    });
  } catch (err) {
    console.warn(`cafe: /cafe-team command not registered: ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
  const requireClient = (): CafeClient => {
    if (!client?.connected) {
      throw new Error(
        startupError
          ? `cafe is not connected: ${startupError}. Next: run \`cafe init\` in this directory (or check ~/.cafe/config.yml), then restart pi.`
          : "not connected to the cafe daemon",
      );
    }
    return client;
  };

  pi.registerTool({
    name: "cafe_agents",
    label: "cafe agents",
    description: "List agents registered on the cafe network (address, role, status, description, scope).",
    promptSnippet: "List agents on the cafe network",
    parameters: Type.Object({}),
    async execute() {
      registry = await requireClient().agents();
      const lines = registry.map(
        (r) => `- ${r.address} [${r.role}, ${r.status}, ${r.mode}]${r.description ? ` — ${r.description}` : ""}${r.scope.length ? ` (scope: ${r.scope.join(", ")})` : ""}`,
      );
      return text(lines.length ? lines.join("\n") : "No agents registered.");
    },
  });

  pi.registerTool({
    name: "cafe_ask",
    label: "cafe ask",
    description:
      "Send an Order (question or task) to other agents on the cafe network. The daemon routes it to the right agent(s) unless `to` names an address (name, name@host or name#n@host). Pass threadId to continue a previous conversation with whoever answered in that thread. Non-blocking by default: replies arrive later as cafe-reply messages. Set wait=true to block until the Order closes and get all replies.",
    promptSnippet: "Ask other agents on the cafe network",
    promptGuidelines: ["Use cafe_ask when another agent on the cafe network is likely to know the answer or own the code in question."],
    parameters: Type.Object({
      body: Type.String({ description: "The question or task, self-contained." }),
      to: Type.Optional(Type.String({ description: "Explicit address; omit to let the router decide." })),
      threadId: Type.Optional(Type.String({ description: "Continue a previous conversation (thread) with whoever answered in it. Do not combine with escalate." })),
      escalate: Type.Optional(Type.Boolean({ description: "Ask the sender of the Order this session is currently handling a clarifying question (creates a sub-thread)." })),
      delegate: Type.Optional(Type.Boolean({ description: "Assign work from the current Order to an explicit recipient in a new child Thread." })),
      broadcast: Type.Optional(Type.Boolean({ description: "Explicitly ask all eligible members in the selected scope." })),
      channel: Type.Optional(Type.String({ description: "Post to this channel instead of the agent's home channel (channels are scopes, not secrets)." })),
      collect: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { description: "any: first answer wins; all: wait for every target or the deadline." })),
      wait: Type.Optional(Type.Boolean({ description: "Block until all replies are in." })),
    }),
    async execute(_id, params, signal) {
      const c = requireClient();
      if (params.delegate && (!current || !params.to || params.threadId || params.escalate || params.broadcast)) {
        throw new Error("Delegation requires a current Order and one explicit recipient, without threadId, escalate, or broadcast.");
      }
      const parent = params.escalate || params.delegate ? current?.handle.order : undefined;
      const parentOrderId = parent?.orderId;
      const parentThreadId = parent?.threadId;
      const ask = async () => {
        try {
          const res = await c.ask({
            body: params.body,
            to: params.to,
            threadId: params.escalate ? undefined : params.threadId,
            parentOrderId,
            parentThreadId,
            escalate: params.escalate || undefined,
            broadcast: params.broadcast,
            channel: params.channel,
            collect: params.collect,
          });
          if (res.decision?.targets?.length === 0 && !res.decision.needsHuman) {
            // Never report "sent" when routing failed immediately (offline parent, empty channel).
            throw new Error(`The question was not delivered${res.decision.failure ? ` (${res.decision.failure})` : ""}: ${res.decision.reason}.`);
          }
          return res;
        } catch (err) {
          if ((err as { code?: string }).code === "thread_busy") {
            throw new Error(`Thread ${params.threadId} still has an open Order; wait for its replies (cafe-reply messages) before following up.`);
          }
          if ((err as { code?: string }).code === "unknown_parent") {
            throw new Error("Nothing to escalate: this session is not handling a cafe Order right now. Ask a fresh question without escalate.");
          }
          throw err;
        }
      };
      await refreshRegistry(c);
      const res = await ask();
      if (res.decision.needsHuman) {
        return text(`Clarification ${res.threadId} is waiting for the person in the original conversation. Their answer will arrive as a new Cafe Order. Do not wait on this publishing Order.`);
      }
      if (!params.wait) {
        const warnings = c.drainWarnings().map((w) => `warning: ${w}`);
        track(res.threadId, { orderId: res.orderId, ...(params.collect === "all" ? { collected: new Map() } : {}) });
        return text(
          [
            ...warnings,
            `Order ${res.orderId} sent (threadId ${res.threadId}). Routed ${res.decision.mode} to ${res.decision.targets.map(addrOf).join(", ") || "nobody"}: ${res.decision.reason}. Replies will arrive as cafe-reply messages; to follow up later, call cafe_ask with threadId "${res.threadId}".`,
          ].join("\n\n"),
        );
      }
      const replies: string[] = [];
      let threadId = "";
      let orderId = "";
      const closed = new Promise<string>((resolve, reject) => {
        const onAbort = () => {
          if (threadId) void c.cancel(threadId).catch(() => {});
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const onEvent = (env: ThreadEnvelope) => {
          const line = env.event.type === "order.closed" ? undefined : describeEvent(env, addrOf);
          if (line) replies.push(line);
          if (env.event.type === "order.closed") {
            signal?.removeEventListener("abort", onAbort);
            asked.delete(env.threadId);
            resolve(env.event.status);
          }
        };
        threadId = res.threadId;
        orderId = res.orderId;
        // Keyed on this Order: track() drops events of other Orders in the thread.
        track(res.threadId, { orderId: res.orderId, onEvent });
      });
      const status = await closed;
      const warnings = c.drainWarnings().map((w) => `warning: ${w}`);
      return text(
        [
          ...warnings,
          `Order ${orderId} (threadId ${threadId}) ${status}.\n\n${replies.join("\n\n") || "(no replies)"}\n\nTo follow up with whoever answered, call cafe_ask with threadId "${threadId}".`,
        ].join("\n\n"),
      );
    },
  });

  pi.registerTool({
    name: "cafe_reply",
    label: "cafe reply",
    description: "Send interim progress for the active Cafe Order. Use finalResult to submit the active human Order's final result. Provide both reportThreadId and reportOrderId to report after a human Order closed.",
    parameters: Type.Object({
      text: Type.String(),
      finalResult: Type.Optional(Type.Boolean({ description: "Submit the final result for the human Order this Agent is handling." })),
      reportThreadId: Type.Optional(Type.String({ description: "Original human Thread for a result report." })),
      reportOrderId: Type.Optional(Type.String({ description: "Original human Order for a result report." })),
      attachments: Type.Optional(Type.Array(Type.String(), { description: "Local file paths to upload and attach to this interim reply." })),
    }),
    async execute(_id, params) {
      if (params.finalResult) {
        const w = current;
        if (!w?.seen || w.frozen || w.declined) throw new Error("No active human Cafe Order to finalize.");
        const { threadId, orderId, from, origin } = w.handle.order;
        if (!from.id.startsWith("cli:") || origin === "agent") throw new Error("Only a human Order can receive a final task result.");
        if (w.finalSubmission) throw new Error("The final reply was already submitted or is in progress.");
        if (params.reportThreadId !== undefined || params.reportOrderId !== undefined || params.attachments?.length || !params.text.trim() || params.text.length > 12_000) {
          throw new Error("A final result uses the active Order's identifiers and requires text only, up to 12000 characters.");
        }
        const c = requireClient();
        w.finalSubmission = w.handle.reply(params.text, true);
        try {
          await w.finalSubmission;
        } catch (error) {
          if (finalReplyWasRejected(error)) {
            delete w.finalSubmission;
            throw error;
          }
          return text(`Cafe could not confirm the final reply. Check Thread ${threadId} for Order ${orderId} before retrying. If the reply landed, complete the report with cafe_reply using reportThreadId=${threadId}, reportOrderId=${orderId}, and the same text.`);
        }
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              await c.report({ threadId, orderId, text: params.text });
              return text("Final reply sent. Report added to the original human conversation.");
            } catch (error) {
              if ((error as { code?: string }).code !== "order_open" || attempt >= 7) throw error;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
        } catch (error) {
          const pending = (error as { code?: string }).code === "report_pending";
          return text(`Final reply submitted. ${pending ? "The report is saved locally and waiting to sync." : `Could not confirm the report: ${(error as Error).message}`} To retry the report, use cafe_reply with reportThreadId=${threadId}, reportOrderId=${orderId}, and the same text.`);
        }
      }
      if (params.reportThreadId || params.reportOrderId) {
        if (!params.reportThreadId || !params.reportOrderId || params.attachments?.length) throw new Error("A result report requires both original identifiers and text only.");
        await requireClient().report({ threadId: params.reportThreadId, orderId: params.reportOrderId, text: params.text });
        return text("Report added to the original human conversation.");
      }
      if (!current) throw new Error("no cafe Order in progress");
      const attachments: Attachment[] = [];
      for (const path of params.attachments ?? []) attachments.push(await uploadAttachment(path));
      await current.handle.reply(params.text, false, attachments);
      return text(attachments.length ? `Interim reply sent with ${attachments.length} attachment(s).` : "Interim reply sent.");
    },
  });

  pi.registerTool({
    name: "cafe_decline",
    label: "cafe decline",
    description: "Decline the cafe Order you are currently working on because it is not your responsibility. The router may try another agent.",
    promptGuidelines: ["Use cafe_decline when a cafe-order message is outside your scope instead of guessing an answer."],
    parameters: Type.Object({ reason: Type.String() }),
    async execute(_id, params) {
      if (!current) throw new Error("no cafe Order in progress");
      current.declined = true;
      await current.handle.decline(params.reason);
      return text("Declined. Stop working on this Order.");
    },
  });
}
