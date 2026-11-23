/**
 * Discord connector core: the platform-independent half of the Discord connector.
 *
 * The adapter talks to Discord through a small `DiscordPlatform` interface so the whole event →
 * Order → reply path is unit-tested with a fake platform (no bot token, no network). `discordjs.ts`
 * is the real implementation, loaded lazily so the SDK itself never depends on discord.js.
 */
import type { ConnectorContext, ConnectorMain, ConnectorOptions } from "@cafe/connector/sdk";
import { defineConnector } from "@cafe/connector/sdk";
import type { ThreadEnvelope } from "@cafe/protocol";

export const DISCORD_MAX_CHARS = 2000;

export interface PlatformMessage {
  /** Discord message id: also the idempotency key. */
  eventId: string;
  guildId?: string;
  channelId: string;
  userId: string;
  text: string;
  mentionEveryone?: boolean;
  mentionsBot: boolean;
  authorIsBot: boolean;
}

export interface DiscordPlatform {
  /**
   * Connect and start delivering messages. Resolves when the connection ends (a stop/close),
   * not on success — the connector awaits it, so "connected" is signalled through `onReady`.
   */
  connect(onMessage: (m: PlatformMessage) => Promise<void>, onError: (err: Error) => void, onReady?: () => void): Promise<void>;
  /** Send one chunk (≤ 2000 chars) to a channel. */
  send(channelId: string, text: string): Promise<void>;
  /** Disconnect (tests: stop delivering). */
  close(): Promise<void>;
}

export interface DiscordConfig {
  allowGuilds: string[];
  allowChannels: string[];
  allowUsers: string[];
  allowDMs: boolean;
  requireMention: boolean;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}

export function readConfig(config: Record<string, unknown>): DiscordConfig {
  return {
    allowGuilds: stringList(config.allowGuilds),
    allowChannels: stringList(config.allowChannels),
    allowUsers: stringList(config.allowUsers),
    allowDMs: !!config.allowDMs,
    requireMention: config.requireMention !== false,
  };
}

function allows(list: string[], value: string | undefined): boolean {
  return list.length === 0 || (!!value && list.includes(value));
}

/** Why a Discord message is ignored, or undefined when it should become an Order. */
export function filterReason(m: PlatformMessage, c: DiscordConfig): string | undefined {
  if (m.authorIsBot) return "author is a bot";
  if (!m.text.trim()) return "empty message";
  if (m.mentionEveryone) return "@everyone/@here is not accepted";
  if (!m.guildId && !c.allowDMs) return "direct messages are disabled (allowDMs: false)";
  if (m.guildId && !allows(c.allowGuilds, m.guildId)) return `guild ${m.guildId} is not in allowGuilds`;
  if (!allows(c.allowChannels, m.channelId)) return `channel ${m.channelId} is not in allowChannels`;
  if (!allows(c.allowUsers, m.userId)) return `user ${m.userId} is not in allowUsers`;
  if (c.requireMention && !m.mentionsBot && m.guildId) return "message does not mention the bot (requireMention)";
  return undefined;
}

/** Split a reply into Discord-sized chunks at a word or newline boundary where possible. */
export function chunkText(text: string, max = DISCORD_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}

/** Follow the Order's Thread over SSE and send each final reply back to Discord. */
export async function followAndSend(ctx: ConnectorContext, platform: DiscordPlatform, item: { eventId: string; channel: string; threadId?: string; orderId?: string }): Promise<void> {
  if (!item.threadId || !item.orderId) throw new Error(`event ${item.eventId} has no Thread/Order to follow`);
  const finals: string[] = [];
  for await (const env of ctx.cafe.streamThread(item.threadId, { orderId: item.orderId })) {
    const e = env as ThreadEnvelope;
    if (e.orderId !== item.orderId) continue;
    if (e.event.type === "order.replied" && e.event.final) finals.push(e.event.text);
    if (e.event.type === "order.closed") break;
  }
  if (!finals.length) {
    ctx.error(`order ${item.orderId} closed without a final reply`);
  }
  for (const text of finals) {
    for (const chunk of chunkText(text)) await platform.send(item.channel, chunk);
  }
  ctx.outbox.markDelivered(item.eventId);
}

async function sendAndFollow(ctx: ConnectorContext, platform: DiscordPlatform, m: PlatformMessage): Promise<void> {
  try {
    const known = ctx.threads.get(m.channelId);
    const created = await ctx.cafe.sendOrder({
      body: m.text,
      ...(known ? { threadId: known } : {}),
      idempotencyKey: m.eventId,
      origin: "agent",
      via: { address: ctx.address, ...(m.userId ? { id: m.userId } : {}) },
      as: ctx.name,
    });
    ctx.threads.set(m.channelId, created.threadId);
    ctx.outbox.markSent(m.eventId, created.threadId, created.orderId);
    ctx.seen.add(m.eventId);
    await followAndSend(ctx, platform, { eventId: m.eventId, channel: m.channelId, threadId: created.threadId, orderId: created.orderId });
  } catch (err) {
    ctx.outbox.markFailed(m.eventId, err instanceof Error ? err.message : String(err));
    ctx.error(`event ${m.eventId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Handle one Discord message: filter, dedupe, send the Order, follow and reply. */
export async function handleMessage(ctx: ConnectorContext, platform: DiscordPlatform, m: PlatformMessage): Promise<void> {
  const cfg = readConfig(ctx.config);
  const why = filterReason(m, cfg);
  if (why) {
    ctx.log(`skip ${m.eventId}: ${why}`);
    return;
  }
  if (ctx.seen.has(m.eventId)) {
    ctx.log(`skip ${m.eventId}: already handled`);
    return;
  }
  const existing = ctx.outbox.get(m.eventId);
  if (existing?.status === "sent") {
    ctx.seen.add(m.eventId);
    if (!existing.delivered) await followAndSend(ctx, platform, existing).catch((err) => ctx.error(`event ${m.eventId}: ${(err as Error).message}`));
    return;
  }
  const item = ctx.outbox.add({ eventId: m.eventId, channel: m.channelId, user: m.userId, text: m.text, status: "pending" });
  await sendAndFollow(ctx, platform, m);
  void item;
}

/** Recover unfinished work after a restart; the platform event id keeps a retry idempotent. */
export async function recover(ctx: ConnectorContext, platform: DiscordPlatform): Promise<void> {
  for (const item of ctx.outbox.undelivered()) {
    await followAndSend(ctx, platform, item).catch((err) => ctx.error(`event ${item.eventId}: ${(err as Error).message}`));
  }
}

export interface DiscordConnectorOptions extends ConnectorOptions {
  /** Inject the platform (tests); the real Discord.js client is created when omitted. */
  platform?: () => Promise<DiscordPlatform>;
}

export function createDiscordConnector(opts: DiscordConnectorOptions = {}): ConnectorMain {
  let platform: DiscordPlatform | undefined;
  let stopRequested = false;
  /** Set once the connector is holding the process open; `stop()` uses it to end `run()` cleanly. */
  let releaseHold: (() => void) | undefined;

  const shutdown = () => {
    stopRequested = true;
    void platform?.close();
    releaseHold?.();
  };

  const base = defineConnector(async (ctx) => {
    if (typeof ctx.config.token !== "string" || !ctx.config.token) {
      throw new Error("config.token is not set (run `cafe connector config discord token <bot token>`)");
    }
    platform = opts.platform ? await opts.platform() : await (await import("./discordjs.ts")).createDiscordJsPlatform(ctx);
    await recover(ctx, platform);
    // `connect()` resolves only when the connection ends. `onReady` fires once the gateway is up.
    const ready = new Promise<void>((r) => {
      void platform!
        .connect(
          (m) => (stopRequested ? Promise.resolve() : handleMessage(ctx, platform!, m)),
          (err) => ctx.error(err.message),
          () => r(),
        )
        .catch((err: Error) => ctx.error(err.message));
    });
    await ready;
    ctx.log(`connected as ${ctx.address}`);
    // Hold the process open until a stop signal (or `main.stop()`); the gateway runs in the background.
    await new Promise<void>((resolve) => {
      releaseHold = resolve;
      const stop = () => shutdown();
      if (stopRequested) return stop();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  }, opts);
  return {
    run: () => base.run(),
    stop: () => {
      shutdown();
      base.stop();
    },
  };
}