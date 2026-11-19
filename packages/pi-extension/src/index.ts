import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_PORT, type AgentRecord, type Order, type ThreadEnvelope } from "@cafe/protocol";
import { loadIdentity } from "@cafe/protocol/cafe-file";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";

const STATUS_KEY = "cafe";

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

const HISTORY_TURN_CHARS = 1500;

/** Compact transcript of the earlier turns of a Thread, oldest first. */
export function formatHistory(history: Order["history"]): string {
  return history
    .map((h) => {
      const text = h.text.length > HISTORY_TURN_CHARS ? `${h.text.slice(0, HISTORY_TURN_CHARS)} …[truncated]` : h.text;
      return `[${h.role} ${h.from}]\n${text}`;
    })
    .join("\n\n");
}

export function orderPrompt(order: Order, self?: AgentRecord): string {
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
    order.body,
    "",
    "Answer this Order directly; your final reply in this turn is sent back to the asker.",
    "If it is outside your responsibility or scope, call cafe_decline with a short reason instead of answering.",
    "For long work, you may send interim progress with cafe_reply.",
  ].join("\n");
}

function describeEvent(env: ThreadEnvelope, addr: (id: string) => string): string | undefined {
  const ev = env.event;
  switch (ev.type) {
    case "order.replied":
      return `☕ ${ev.final ? "Reply" : "Interim reply"} from ${addr(ev.agentId)} (threadId ${env.threadId}):\n\n${ev.text}`;
    case "order.declined":
      return `☕ ${addr(ev.agentId)} declined (threadId ${env.threadId}): ${ev.reason}`;
    case "order.closed":
      return `☕ Order ${env.orderId} closed: ${ev.status}. To follow up with whoever answered, call cafe_ask with threadId "${env.threadId}".`;
    default:
      return undefined;
  }
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
  const asked = new Map<string, { orderId: string; onEvent?: (env: ThreadEnvelope) => void }>();
  /** orderIds already queued or served, so a redelivery after a reconnect is not run twice. */
  const known = new Set<string>();
  /** Events that arrive before order/create returns (the daemon fans out during creation). */
  const early = new Map<string, ThreadEnvelope[]>();
  let registry: AgentRecord[] = [];

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
    const text = describeEvent(env, addrOf);
    if (text) {
      pi.sendMessage(
        { customType: "cafe-reply", content: text, display: true, details: { threadId: env.threadId, orderId: env.orderId, event: env.event.type } },
        { triggerTurn: env.event.type !== "order.closed", deliverAs: "followUp" },
      );
    }
    if (env.event.type === "order.closed") asked.delete(env.threadId);
  }

  function track(threadId: string, entry: { orderId: string; onEvent?: (env: ThreadEnvelope) => void }): void {
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
      return;
    }
    draining = true;
    try {
      current = { handle: next.handle, stopHeartbeat: next.stopHeartbeat, declined: false, seen: false, frozen: false };
      armWatchdog(current, injectTimeoutMs());
      void client.setStatus("busy").catch(() => {});
      pi.sendMessage(
        { customType: "cafe-order", content: orderPrompt(next.handle.order, client.record), display: true, details: { order: next.handle.order } },
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
    if (w.declined) return;
    if (!w.lastText && aborted) await persist(() => w.handle.decline("aborted by the operator", { unavailable: true })).catch(() => {});
    else await persist(() => w.handle.reply(w.lastText ?? "(no answer produced)", true)).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    startupError = undefined;
    if (client) return;
    try {
      const { cafe: id } = loadIdentity(ctx.cwd);
      role = id.role;
      const addr = daemonAddr();
      if (!(await ensureDaemon(addr))) {
        startupError = "daemon unreachable";
        setUiStatus("☕ cafe: daemon unreachable");
        return;
      }
      const c = new CafeClient({ daemon: addr, token: process.env.CAFE_TOKEN, reconnect: true });
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
      c.onCancel(onCancelled);
      c.onConnect((rec) => {
        setUiStatus(rec ? `☕ ${rec.address}` : "☕ cafe");
        void refreshRegistry(c);
      });
      try {
        await c.connect({ ...id, mode: ctx.hasUI && ctx.mode === "tui" ? "tui" : "headless", agent: isOmp() ? "omp" : "pi", cwd: ctx.cwd, pid: process.pid });
        client = c;
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
    else if (client && !current) void client.setStatus("idle").catch(() => {});
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
      threadId: Type.Optional(Type.String({ description: "Continue a previous conversation (thread) with whoever answered in it." })),
      wait: Type.Optional(Type.Boolean({ description: "Block until all replies are in." })),
    }),
    async execute(_id, params, signal) {
      const c = requireClient();
      const parentOrderId = current?.handle.order.orderId;
      const ask = async () => {
        try {
          return await c.ask({ body: params.body, to: params.to, threadId: params.threadId, parentOrderId });
        } catch (err) {
          if ((err as { code?: string }).code === "thread_busy") {
            throw new Error(`Thread ${params.threadId} still has an open Order; wait for its replies (cafe-reply messages) before following up.`);
          }
          throw err;
        }
      };
      await refreshRegistry(c);
      if (!params.wait) {
        const res = await ask();
        track(res.threadId, { orderId: res.orderId });
        return text(
          `Order ${res.orderId} sent (threadId ${res.threadId}). Routed ${res.decision.mode} to ${res.decision.targets.map(addrOf).join(", ") || "nobody"}: ${res.decision.reason}. Replies will arrive as cafe-reply messages; to follow up later, call cafe_ask with threadId "${res.threadId}".`,
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
        void ask()
          .then((res) => {
            threadId = res.threadId;
            orderId = res.orderId;
            // Keyed on this Order: track() drops events of other Orders in the thread.
            track(res.threadId, { orderId: res.orderId, onEvent });
          })
          .catch(reject);
      });
      const status = await closed;
      return text(
        `Order ${orderId} (threadId ${threadId}) ${status}.\n\n${replies.join("\n\n") || "(no replies)"}\n\nTo follow up with whoever answered, call cafe_ask with threadId "${threadId}".`,
      );
    },
  });

  pi.registerTool({
    name: "cafe_reply",
    label: "cafe reply",
    description: "Send an interim (non-final) reply for the cafe Order you are currently working on. Your final answer is sent automatically at the end of the turn.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      if (!current) throw new Error("no cafe Order in progress");
      await current.handle.reply(params.text, false);
      return text("Interim reply sent.");
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
