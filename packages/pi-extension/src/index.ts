import { spawn } from "node:child_process";
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

/**
 * Make sure a local Daemon is running. If `addr` is loopback and nothing answers,
 * start `cafe daemon run` detached and poll /api/health for up to `timeoutMs`.
 */
export async function ensureDaemon(addr = daemonAddr(), timeoutMs = 5000): Promise<boolean> {
  if (await healthy(addr)) return true;
  const host = addr.split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  const cli = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, "daemon", "run"], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    if (await healthy(addr)) return true;
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

function orderPrompt(order: Order, self?: AgentRecord): string {
  return [
    `☕ cafe Order from ${order.from.address}${self ? ` to you (${self.address})` : ""}`,
    `orderId: ${order.orderId}`,
    "",
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
      return `☕ ${ev.final ? "Reply" : "Interim reply"} from ${addr(ev.agentId)} (thread ${env.threadId}):\n\n${ev.text}`;
    case "order.declined":
      return `☕ ${addr(ev.agentId)} declined (thread ${env.threadId}): ${ev.reason}`;
    case "thread.closed":
      return `☕ Thread ${env.threadId} closed: ${ev.status}`;
    default:
      return undefined;
  }
}

interface Working {
  handle: OrderHandle;
  stopHeartbeat: () => void;
  declined: boolean;
  /** Set once the run triggered by the injection has started. */
  started: boolean;
  lastText?: string;
}

/**
 * cafe pi extension: registers this session with the local Daemon as a Barista
 * (or Customer), serves incoming Orders when idle, and exposes cafe_* tools.
 */
export default function cafe(pi: ExtensionAPI) {
  let client: CafeClient | undefined;
  let ctxRef: ExtensionContext | undefined;
  let accept: "auto" | "confirm" = "auto";
  let role: "barista" | "customer" = "customer";
  const queue: OrderHandle[] = [];
  let current: Working | undefined;
  let draining = false;
  /** Threads this session asked about: threadId → waiter (wait mode) or undefined (async). */
  const asked = new Map<string, { onEvent?: (env: ThreadEnvelope) => void }>();
  /** Events that arrive before order/create returns (the daemon fans out during creation). */
  const early = new Map<string, ThreadEnvelope[]>();
  let registry: AgentRecord[] = [];

  const addrOf = (id: string) => registry.find((r) => r.agentId === id)?.address ?? id;
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
    if (entry.onEvent) return entry.onEvent(env);
    const text = describeEvent(env, addrOf);
    if (text) {
      pi.sendMessage(
        { customType: "cafe-reply", content: text, display: true, details: { threadId: env.threadId, event: env.event.type } },
        { triggerTurn: env.event.type !== "thread.closed", deliverAs: "followUp" },
      );
    }
    if (env.event.type === "thread.closed") asked.delete(env.threadId);
  }

  function track(threadId: string, entry: { onEvent?: (env: ThreadEnvelope) => void }): void {
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
      if (accept === "confirm" && ctxRef?.hasUI) {
        const ok = await ctxRef.ui.confirm("☕ cafe Order", `From ${next.order.from.address}:\n\n${next.order.body}\n\nWork on it now?`);
        if (!ok) {
          await next.decline("declined by the human operator").catch(() => {});
          draining = false;
          return void drain();
        }
      }
      await next.ack().catch(() => {});
      current = { handle: next, stopHeartbeat: keepAlive(next), declined: false, started: false };
      void client.setStatus("busy").catch(() => {});
      pi.sendMessage(
        { customType: "cafe-order", content: orderPrompt(next.order, client.record), display: true, details: { order: next.order } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } finally {
      draining = false;
    }
  }

  async function finish(): Promise<void> {
    const w = current;
    if (!w) return;
    current = undefined;
    w.stopHeartbeat();
    if (!w.declined) {
      const text = w.lastText ?? "(no answer produced)";
      await w.handle.reply(text, true).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (client) return;
    const { cafe: id } = loadIdentity(ctx.cwd);
    accept = id.accept;
    role = id.role;
    const addr = daemonAddr();
    if (!(await ensureDaemon(addr))) {
      setUiStatus("☕ cafe: daemon unreachable");
      return;
    }
    const c = new CafeClient({ daemon: addr, token: process.env.CAFE_TOKEN, reconnect: true });
    c.onOrder((h) => {
      queue.push(h);
      void drain();
    });
    c.onThreadEvent(onThreadEvent);
    c.onConnect((rec) => setUiStatus(rec ? `☕ ${rec.address}` : "☕ cafe"));
    try {
      await c.connect({ ...id, mode: ctx.hasUI && ctx.mode === "tui" ? "tui" : "headless", cwd: ctx.cwd, pid: process.pid });
      client = c;
    } catch (err) {
      setUiStatus(`☕ cafe: ${(err as Error).message}`);
    }
  });

  pi.on("session_shutdown", async () => {
    const c = client;
    client = undefined;
    if (current) {
      current.stopHeartbeat();
      await current.handle.decline("agent session shutting down").catch(() => {});
      current = undefined;
    }
    for (const h of queue.splice(0)) await h.decline("agent session shutting down").catch(() => {});
    c?.close();
  });

  pi.on("agent_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (current) current.started = true;
    if (client) void client.setStatus("busy").catch(() => {});
  });

  pi.on("agent_end", async (event) => {
    if (!current?.started) return;
    const text = lastAssistantText(event.messages);
    if (text) current.lastText = text;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    ctxRef = ctx;
    if (current?.started) await finish();
    if (queue.length) await drain();
    else if (client && !current) void client.setStatus("idle").catch(() => {});
  });

  pi.on("before_agent_start", async (event) => {
    const rec = client?.record;
    const lines = [
      rec ? `You are connected to the cafe agent network as ${rec.address} (role: ${role}).` : "You can reach the cafe agent network.",
      "Other agents on the network may know things you don't. Use cafe_agents to see who is registered and cafe_ask to send them a question (non-blocking by default; replies arrive as cafe-reply messages).",
    ];
    if (role === "barista") lines.push("Messages of type cafe-order are questions from other agents: answer them, or call cafe_decline if they are not your responsibility.");
    event.systemPromptOptions.sections.cafe = lines.join("\n");
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  pi.registerMessageRenderer<{ order: Order }>("cafe-order", (message, options, theme) => {
    const order = message.details?.order;
    const head = theme.fg("accent", `☕ Order from ${order?.from.address ?? "?"}`);
    const body = order?.body ?? (typeof message.content === "string" ? message.content : "");
    return new Text(`${head}\n${options.expanded ? body : body.split("\n").slice(0, 6).join("\n")}`, 1, 0);
  });
  pi.registerMessageRenderer("cafe-reply", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const [first = "", ...rest] = content.split("\n");
    return new Text(`${theme.fg("accent", first)}${rest.length ? `\n${rest.join("\n")}` : ""}`, 1, 0);
  });

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
  const requireClient = (): CafeClient => {
    if (!client?.connected) throw new Error("not connected to the cafe daemon");
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
      "Send an Order (question or task) to other agents on the cafe network. The daemon routes it to the right agent(s) unless `to` names an address (name, name@host or name#n@host). Non-blocking by default: replies arrive later as cafe-reply messages. Set wait=true to block until the thread closes and get all replies.",
    promptSnippet: "Ask other agents on the cafe network",
    promptGuidelines: ["Use cafe_ask when another agent on the cafe network is likely to know the answer or own the code in question."],
    parameters: Type.Object({
      body: Type.String({ description: "The question or task, self-contained." }),
      to: Type.Optional(Type.String({ description: "Explicit address; omit to let the router decide." })),
      wait: Type.Optional(Type.Boolean({ description: "Block until all replies are in." })),
    }),
    async execute(_id, params, signal) {
      const c = requireClient();
      const parentOrderId = current?.handle.order.orderId;
      if (!params.wait) {
        const res = await c.ask({ body: params.body, to: params.to, parentOrderId });
        track(res.threadId, {});
        return text(
          `Order sent (thread ${res.threadId}). Routed ${res.decision.mode} to ${res.decision.targets.map(addrOf).join(", ") || "nobody"}: ${res.decision.reason}. Replies will arrive as cafe-reply messages.`,
        );
      }
      const replies: string[] = [];
      let threadId = "";
      const closed = new Promise<string>((resolve, reject) => {
        const onAbort = () => {
          if (threadId) void c.cancel(threadId).catch(() => {});
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const onEvent = (env: ThreadEnvelope) => {
          const line = env.event.type === "thread.closed" ? undefined : describeEvent(env, addrOf);
          if (line) replies.push(line);
          if (env.event.type === "thread.closed") {
            signal?.removeEventListener("abort", onAbort);
            asked.delete(env.threadId);
            resolve(env.event.status);
          }
        };
        void c
          .ask({ body: params.body, to: params.to, parentOrderId })
          .then((res) => {
            threadId = res.threadId;
            track(res.threadId, { onEvent });
          })
          .catch(reject);
      });
      const status = await closed;
      return text(`Thread ${threadId} ${status}.\n\n${replies.join("\n\n") || "(no replies)"}`);
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
