import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import type { ThreadEnvelope } from "@cafe/protocol";
import { defineConnector, type ConnectorContext, type ConnectorMain, type ConnectorOptions } from "./sdk.ts";

export { isEntryPoint } from "./sdk.ts";
export type { ConnectorOptions } from "./sdk.ts";

/** One line on the mock platform's event bus. */
export interface MockEvent {
  channel: string;
  user: string;
  eventId: string;
  text: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function allowed(allowlist: string[], value: string): boolean {
  return allowlist.length === 0 || allowlist.includes(value);
}

function isReadable(input: unknown): input is NodeJS.ReadableStream {
  return !!input && typeof (input as { on?: unknown }).on === "function";
}

/** Accept a Node stream or a plain async iterable of chunks; yield complete lines. */
async function* inputLines(input: NodeJS.ReadableStream | AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  if (isReadable(input)) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) yield line;
    return;
  }
  let buf = "";
  for await (const chunk of input) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf.replace(/\r$/, "");
}

function validateEvent(raw: unknown): MockEvent | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "event must be a JSON object";
  const v = raw as Record<string, unknown>;
  for (const key of ["channel", "user", "eventId", "text"] as const) {
    if (typeof v[key] !== "string" || !v[key]) return `event.${key} must be a non-empty string`;
  }
  return { channel: v.channel as string, user: v.user as string, eventId: v.eventId as string, text: v.text as string };
}

/** Collect this Order's final replies over SSE, write them to stdout, mark the outbox item delivered. */
async function followAndEmit(ctx: ConnectorContext, item: { eventId: string; channel: string; threadId?: string; orderId?: string }): Promise<void> {
  if (!item.threadId || !item.orderId) throw new Error(`event ${item.eventId} has no Thread/Order to follow`);
  const finals: string[] = [];
  for await (const env of ctx.cafe.streamThread(item.threadId, { orderId: item.orderId })) {
    const e = env as ThreadEnvelope;
    if (e.orderId !== item.orderId) continue;
    if (e.event.type === "order.replied" && e.event.final) finals.push(e.event.text);
    if (e.event.type === "order.closed") break;
  }
  for (const text of finals) ctx.emit({ type: "reply", channel: item.channel, threadId: item.threadId, text, final: true });
  if (!finals.length) ctx.error(`order ${item.orderId} closed without a final reply`);
  ctx.outbox.markDelivered(item.eventId);
}

/** Send the Order (idempotent by event id), persist the mapping, then follow the reply. */
async function sendAndFollow(ctx: ConnectorContext, item: { eventId: string; channel: string; text: string; status?: string }): Promise<void> {
  try {
    const known = ctx.threads.get(item.channel);
    const created = await ctx.cafe.sendOrder({
      body: item.text,
      ...(known ? { threadId: known } : {}),
      idempotencyKey: item.eventId,
      origin: "agent",
      via: { address: ctx.address },
      as: ctx.name,
    });
    ctx.threads.set(item.channel, created.threadId);
    ctx.outbox.markSent(item.eventId, created.threadId, created.orderId);
    ctx.seen.add(item.eventId);
    await followAndEmit(ctx, { eventId: item.eventId, channel: item.channel, threadId: created.threadId, orderId: created.orderId });
  } catch (err) {
    ctx.outbox.markFailed(item.eventId, messageOf(err));
    ctx.error(`event ${item.eventId}: ${messageOf(err)}`);
  }
}

async function handleEvent(ctx: ConnectorContext, event: MockEvent): Promise<void> {
  const channels = stringList(ctx.config.allowChannels);
  const users = stringList(ctx.config.allowUsers);
  if (!allowed(channels, event.channel)) {
    ctx.log(`skip ${event.eventId}: channel ${event.channel} is not in allowChannels`);
    return;
  }
  if (!allowed(users, event.user)) {
    ctx.log(`skip ${event.eventId}: user ${event.user} is not in allowUsers`);
    return;
  }
  if (ctx.seen.has(event.eventId)) {
    ctx.log(`skip ${event.eventId}: already handled`);
    return;
  }

  const existing = ctx.outbox.get(event.eventId);
  if (existing?.status === "sent") {
    // Crashed after sending but before writing the final reply: replay the Thread.
    ctx.seen.add(event.eventId);
    if (!existing.delivered) await followAndEmit(ctx, existing).catch((err) => ctx.error(`event ${event.eventId}: ${messageOf(err)}`));
    return;
  }
  const item = ctx.outbox.add({
    eventId: event.eventId,
    channel: event.channel,
    user: event.user,
    text: event.text,
    status: "pending",
  });
  await sendAndFollow(ctx, item);
}

async function handleLine(ctx: ConnectorContext, line: string): Promise<void> {
  if (!line.trim()) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    ctx.error(`invalid JSON line: ${line.slice(0, 120)}`);
    return;
  }
  const event = validateEvent(raw);
  if (typeof event === "string") {
    ctx.error(event);
    return;
  }
  await handleEvent(ctx, event);
}

/** Recover unfinished work after a restart; the event id keeps a retry idempotent. */
async function recover(ctx: ConnectorContext): Promise<void> {
  for (const item of ctx.outbox.pending()) await sendAndFollow(ctx, item);
  for (const item of ctx.outbox.undelivered()) {
    await followAndEmit(ctx, item).catch((err) => ctx.error(`event ${item.eventId}: ${messageOf(err)}`));
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Ingest {
  port: number;
  close(): void;
  /** Resolves when the server was asked to stop. */
  stopped: Promise<void>;
}

/**
 * Optional local ingest: `config.ingestPort` turns the mock into a tiny HTTP
 * endpoint so a person can feed events from another terminal. `POST /` takes
 * one event; `GET /healthz` liveness. Replies still go to stdout.
 */
async function startIngest(ctx: ConnectorContext, port: number): Promise<Ingest> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
    if (req.method === "POST" && path === "/") {
      try {
        const raw = JSON.parse(await readBody(req));
        const event = validateEvent(raw);
        if (typeof event === "string") return sendJson(res, 400, { ok: false, error: event });
        await handleEvent(ctx, event);
        return sendJson(res, 200, { ok: true, eventId: event.eventId });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: messageOf(err) });
      }
    }
    return sendJson(res, 404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((resolveP, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveP();
    });
  });
  let closed = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolveP) => (resolveStopped = resolveP));
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    server.closeAllConnections?.();
    resolveStopped();
  };
  ctx.log(`ingest listening on http://127.0.0.1:${port}`);
  return { port, close, stopped };
}

/**
 * The mock connector: JSON lines on stdin (`{channel,user,eventId,text}`),
 * JSON lines on stdout (heartbeat / error / final reply). With
 * `config.ingestPort` it also accepts the same events over local HTTP.
 */
export function createMockConnector(opts: ConnectorOptions = {}): ConnectorMain {
  let closeIngest: (() => void) | undefined;
  const base = defineConnector(async (ctx) => {
    await recover(ctx);
    const port = Number(ctx.config.ingestPort);
    const ingest = Number.isInteger(port) && port > 0 ? await startIngest(ctx, port) : undefined;
    closeIngest = ingest?.close;
    try {
      const input = opts.input ?? process.stdin;
      if (ingest) {
        // stdin is /dev/null under the supervisor: keep serving HTTP instead of exiting.
        void (async () => {
          try {
            for await (const line of inputLines(input)) await handleLine(ctx, line);
          } catch (err) {
            ctx.error(messageOf(err));
          }
        })();
        await ingest.stopped;
      } else {
        for await (const line of inputLines(input)) await handleLine(ctx, line);
      }
    } finally {
      ingest?.close();
      closeIngest = undefined;
    }
  }, opts);
  return {
    run: () => base.run(),
    stop: () => {
      closeIngest?.();
      base.stop();
    },
  };
}