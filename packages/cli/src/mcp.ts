import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentRecord, Attachment, ThreadEnvelope, ThreadMeta } from "@cafe/protocol";

/** Below Claude Code's 2-minute auto-background and Codex's 300 s tool timeout (v3-1 Q77). */
export const MAX_WAIT_S = 100;
const LATEST_PROTOCOL = "2025-06-18";

export interface McpOptions {
  /** `http://host:port` of the local Daemon. */
  base: string;
  token?: string;
  /** Start the local Daemon if needed; called before the first tool runs. */
  ensure?: () => Promise<void>;
  /** Customer name shown to others; default: the MCP client's name (e.g. claude-code, codex-mcp-client). */
  as?: string;
  version: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Cap on wait_seconds (tests use small values). */
  maxWaitS?: number;
}

const TOOLS = [
  {
    name: "cafe_agents",
    description: "List the agents (Baristas) on the cafe network and what each one is responsible for.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cafe_ask",
    description:
      "Ask the cafe agent network a question. cafe routes it to the agent best placed to answer (or to `to`). " +
      `Waits up to wait_seconds (max ${MAX_WAIT_S}) for the answer; if it is not ready, returns the threadId — call cafe_wait with it. ` +
      "Pass threadId to ask a follow-up in an earlier conversation (it goes to whoever answered there).",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question or task, self-contained." },
        to: { type: "string", description: "Explicit address (name, name@host, name#n@host); skips routing." },
        broadcast: { type: "boolean", description: "Ask every eligible agent. Only when the person explicitly wants everyone; normal questions use routing." },
        threadId: { type: "string", description: "Continue this conversation (follow-up)." },
        parent_order_id: { type: "string", description: "The Order this question is a sub-Order of (for escalation)." },
        parent_thread_id: { type: "string", description: "The Thread holding parent_order_id (needed when it is no longer in memory)." },
        escalate: { type: "boolean", description: "With parent_order_id: ask the sender of that Order a clarifying question (creates a sub-thread)." },
        channel: { type: "string", description: "Message scope (default: the agent's home channel, else default)." },
        collect: { type: "string", enum: ["any", "all"], description: "any: first answer wins; all: wait for every target or the deadline." },
        attachments: { type: "array", items: { type: "string" }, description: "Local file paths to attach; this MCP server reads and uploads them." },
        wait_seconds: { type: "number", description: `How long to wait for the answer (default and max ${MAX_WAIT_S}).` },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "cafe_wait",
    description: "Keep waiting for the answer to a question asked with cafe_ask (by threadId). Returns the answer, or says it is still being worked on.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        orderId: { type: "string", description: "A specific question in the thread (default: the latest one)." },
        wait_seconds: { type: "number", description: `Default and max ${MAX_WAIT_S}.` },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "cafe_cancel",
    description: "Cancel a question you asked that is still being worked on.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" } }, required: ["threadId"], additionalProperties: false },
  },
  {
    name: "cafe_reply",
    description:
      "Reply to an open cafe Order as one of its target Baristas (by address). For a process working on an Order that is not connected as a Barista peer; attachments are local paths this server uploads.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        agent: { type: "string", description: "The target Barista's address (name@host)." },
        text: { type: "string" },
        attachments: { type: "array", items: { type: "string" }, description: "Local file paths to attach." },
        final: { type: "boolean", description: "Default true; false sends an interim reply and keeps the Order open." },
      },
      required: ["threadId", "agent", "text"],
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {}

/**
 * `cafe mcp`: cafe as an MCP server over stdio (newline-delimited JSON-RPC 2.0), so Claude Code, Codex or any
 * MCP client can be a Customer without the skill (v3-1 Q77). Talks to the local Daemon's HTTP API.
 */
export function runMcp(opts: McpOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const maxWait = Math.min(opts.maxWaitS ?? MAX_WAIT_S, MAX_WAIT_S);
  let customer = opts.as;
  let ensured: Promise<void> | undefined;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  });
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    ensured ??= (opts.ensure?.() ?? Promise.resolve()).catch((e) => {
      ensured = undefined;
      throw e;
    });
    await ensured;
    const res = await fetch(`${opts.base}${path}`, { ...init, headers: headers() });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new ToolError(`${body.error ?? res.status}: ${body.message ?? ""}`.trim());
    return body as T;
  };

  const send = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);

  /** Attachments are local paths: the MCP server is local, so it reads and uploads them. */
  const upload = async (file: string): Promise<Attachment> => {
    await api("/api/health");
    const path = resolve(file);
    if (!existsSync(path)) throw new ToolError(`attachment not found: ${file}`);
    const name = basename(path);
    const res = await fetch(`${opts.base}/api/artifacts?name=${encodeURIComponent(name)}&mime=application/octet-stream`, {
      method: "POST",
      body: readFileSync(path),
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new ToolError(`upload ${file} failed: ${body.error ?? res.status}: ${body.message ?? ""}`.trim());
    return body.attachment as Attachment;
  };

  /** Follow one Order over SSE until it closes or `seconds` pass. */
  const waitOrder = async (threadId: string, orderId: string, seconds: number) => {
    const agents = new Map((await api<AgentRecord[]>("/api/agents")).map((a) => [a.agentId, a.address]));
    const who = (id?: string) => (id ? (agents.get(id) ?? id) : "?");
    const replies: { from: string; text: string; final: boolean }[] = [];
    const notes: string[] = [];
    let status: string | undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(0, seconds) * 1000);
    try {
      const res = await fetch(`${opts.base}/api/threads/${encodeURIComponent(threadId)}/stream?orderId=${encodeURIComponent(orderId)}`, { headers: headers(), signal: ctrl.signal });
      if (!res.ok || !res.body) throw new ToolError(`cannot follow thread ${threadId}: ${res.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!data) continue;
          const env = JSON.parse(data.slice(6)) as ThreadEnvelope;
          if (env.orderId !== orderId) continue;
          const e = env.event;
          if (e.type === "order.replied") replies.push({ from: who(e.agentId), text: e.text, final: e.final });
          else if (e.type === "order.declined") notes.push(e.skipped ? `${who(e.agentId)} did not answer before the deadline` : `${who(e.agentId)} declined: ${e.reason}`);
          else if (e.type === "order.failed") notes.push(`${e.agentId ? who(e.agentId) : "the question"} failed: ${e.reason}`);
          else if (e.type === "order.cancelled") notes.push(`cancelled by ${e.by}`);
          else if (e.type === "order.closed") status = e.status;
        }
        if (status) break;
      }
    } catch (err) {
      if (!ctrl.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    const lines = [`threadId: ${threadId}`, `orderId: ${orderId}`, `status: ${status ?? "still working"}`];
    for (const r of replies) lines.push("", `## ${r.from}${r.final ? "" : " (progress)"}`, r.text);
    if (notes.length) lines.push("", ...notes);
    if (!status) lines.push("", `Not answered yet. Call cafe_wait with threadId "${threadId}" to keep waiting, or cafe_cancel to give up.`);
    else if (status === "done") lines.push("", `Ask a follow-up with cafe_ask and threadId "${threadId}".`);
    return { text: lines.join("\n"), isError: !!status && status !== "done" };
  };

  const seconds = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.min(v, maxWait) : maxWait);
  const str = (v: unknown, name: string, required = false): string | undefined => {
    if (v === undefined || v === null || v === "") {
      if (required) throw new ToolError(`${name} is required`);
      return undefined;
    }
    if (typeof v !== "string") throw new ToolError(`${name} must be a string`);
    return v;
  };

  const callTool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    switch (name) {
      case "cafe_agents": {
        const list = (await api<AgentRecord[]>("/api/agents")).filter((a) => a.role === "barista").sort((a, b) => a.address.localeCompare(b.address));
        const lines = list.map((a) => `- ${a.address} (${a.status})${a.description ? `: ${a.description}` : ""}${a.tags.length ? ` [${a.tags.join(", ")}]` : ""}`);
        return { text: lines.join("\n") || "No agents are registered on the cafe network." };
      }
      case "cafe_ask": {
        const body = str(args.question, "question", true)!;
        const to = str(args.to, "to");
        const channel = str(args.channel, "channel");
        // v4-13: MCP is HTTP-only, so it checks /api/health itself and refuses BEFORE creating an
        // Order. A silent downgrade (a team broadcast, an escalation routed like a normal ask) is
        // worse than an error (#110).
        const h = await api<{ host: string; version?: string; features?: string[] }>("/api/health").catch(() => undefined);
        const need = (feature: string, used: boolean, effect: string): void => {
          if (!used) return;
          if (Array.isArray(h?.features) && h.features.includes(feature)) return;
          throw new ToolError(`${h?.host ?? "this daemon"} (cafe ${h?.version ?? "unknown"}) does not support ${feature}; ${effect}. If that Host already runs a newer cafe, restart it there (cafe daemon restart); otherwise upgrade cafe on it first.`);
        };
        need("channels", !!channel, `channel #${channel} would be ignored`);
        need("collect", args.collect === "all", "the first answer may close the thread instead of waiting for every target");
        need("escalate", args.escalate === true, "the question would become a normal routed ask, not a sub-Thread to the parent");
        if (to) {
          const name = to.replace(/[#@].*$/, "");
          const host = /@([a-zA-Z0-9_.-]+)$/.exec(to)?.[1];
          const [teams, agents] = await Promise.all([
            api<{ team: string; host: string }[]>("/api/teams").catch(() => []),
            api<{ name: string; address: string; displayName?: string }[]>("/api/agents").catch(() => []),
          ]);
          // An agent name wins over a team name (the daemon's own resolution order).
          const agentHit = agents.some((a) => a.address === to || a.name === name || a.displayName === name);
          const teamHit = !agentHit && teams.some((t) => t.team === name && (!host || t.host === host));
          need("team-sessions", teamHit, `to: ${to} would reach every member instead of the orchestrator`);
        }
        const files = Array.isArray(args.attachments) ? args.attachments.map((f) => str(f, "attachment", true)!) : [];
        const attachments: Attachment[] = [];
        for (const file of files) attachments.push(await upload(file));
        const res = await api<{ threadId: string; orderId: string; decision: { reason: string; targets: string[]; failure?: string; router?: string } }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({
            body,
            to,
            broadcast: args.broadcast === true || undefined,
            threadId: str(args.threadId, "threadId"),
            ...(str(args.parent_order_id, "parent_order_id") ? { parentOrderId: str(args.parent_order_id, "parent_order_id") } : {}),
            ...(str(args.parent_thread_id, "parent_thread_id") ? { parentThreadId: str(args.parent_thread_id, "parent_thread_id") } : {}),
            ...(args.escalate === true ? { escalate: true } : {}),
            ...(channel ? { channel } : {}),
            ...(args.collect === "all" ? { collect: "all" as const } : {}),
            as: customer ?? "mcp",
            origin: "agent",
            ...(process.env.CAFE_VIA ? { via: { address: process.env.CAFE_VIA } } : {}),
            ...(attachments.length ? { attachments } : {}),
          }),
        });
        if (res.decision?.targets?.length === 0) {
          // An immediate routing failure (offline parent, empty channel) is not "sent, replies will come".
          return { text: `Not delivered${res.decision.failure ? ` (${res.decision.failure})` : ""}: ${res.decision.reason}`, isError: true };
        }
        return waitOrder(res.threadId, res.orderId, seconds(args.wait_seconds));
      }
      case "cafe_wait": {
        const threadId = str(args.threadId, "threadId", true)!;
        const orderId = str(args.orderId, "orderId") ?? (await api<{ meta: ThreadMeta }>(`/api/threads/${encodeURIComponent(threadId)}`)).meta.orderId;
        return waitOrder(threadId, orderId, seconds(args.wait_seconds));
      }
      case "cafe_cancel": {
        const threadId = str(args.threadId, "threadId", true)!;
        await api(`/api/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" });
        return { text: `cancelled ${threadId}` };
      }
      case "cafe_reply": {
        const threadId = str(args.threadId, "threadId", true)!;
        const agent = str(args.agent, "agent", true)!;
        const text = str(args.text, "text", true)!;
        const files = Array.isArray(args.attachments) ? args.attachments.map((f) => str(f, "attachment", true)!) : [];
        const attachments: Attachment[] = [];
        for (const file of files) attachments.push(await upload(file));
        await api(`/api/threads/${encodeURIComponent(threadId)}/reply`, {
          method: "POST",
          body: JSON.stringify({ agent, text, final: args.final !== false, ...(attachments.length ? { attachments } : {}) }),
        });
        return { text: `replied to ${threadId}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}` };
      }
      default:
        throw new ToolError(`unknown tool ${name}`);
    }
  };

  const handle = async (msg: any) => {
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const client = String(msg.params?.clientInfo?.name ?? "").replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
        customer ??= client || "mcp";
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "cafe", version: opts.version },
          instructions:
            "cafe routes questions to other agents on the user's machines. Use cafe_agents to see who is there, cafe_ask to ask, " +
            "cafe_wait when an answer takes longer than one call.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        try {
          const r = await callTool(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
          return reply({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
        } catch (err) {
          const text = err instanceof ToolError ? err.message : `cafe: ${(err as Error).message}`;
          return reply({ content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        if (msg.id !== undefined) return fail(-32601, `method not found: ${msg.method}`);
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      // Requests run concurrently: a long cafe_ask must not block ping or tools/list.
      void handle(msg).catch((err) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (err as Error).message } }));
    });
    rl.on("close", () => resolve());
  });
}

/** Commands that register `cafe mcp` with Claude Code / Codex (user scope). */
export function mcpInstallCommands(command: string[]): Record<"claude" | "codex", string[]> {
  return {
    claude: ["claude", "mcp", "add", "--scope", "user", "cafe", "--", ...command],
    codex: ["codex", "mcp", "add", "cafe", "--", ...command],
  };
}
