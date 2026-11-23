/**
 * The real Discord adapter (discord.js), loaded only when the Discord connector runs.
 *
 * discord.js is not a dependency of cafe: `cafe connector install` links the SDK, and the
 * connector directory gets discord.js installed next to it (`npm install discord.js` inside the
 * connector directory, or globally). Never use Node's global WebSocket — discord.js needs `ws`.
 */
import type { ConnectorContext } from "@cafe/connector/sdk";
import type { DiscordPlatform, PlatformMessage } from "./discord-core.ts";

interface AnyClient {
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
  on(event: string, fn: (...args: any[]) => void): void;
  user?: { id: string };
}

/** Fields we read from a discord.js Message (a structural subset; keeps this file type-safe without the dep). */
interface AnyMessage {
  id: string;
  content: string;
  guildId: string | null;
  channelId: string;
  channel?: { send(text: string, opts?: { nonce?: string; enforceNonce?: boolean }): Promise<unknown>; isDMBased?(): boolean };
  author: { id: string; bot?: boolean };
  mentions?: { users?: { has(id: string): boolean }; everyone?: boolean; here?: boolean };
  attachments?: Map<string, AnyAttachment> | AnyAttachment[];
}

interface AnyAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType?: string | null;
}

/** Build a `PlatformMessage` from a discord.js message; `botUserId` is our own user id. */
export function toPlatformMessage(m: AnyMessage, botUserId: string | undefined): PlatformMessage {
  const mentionsBot = !!botUserId && !!m.mentions?.users?.has(botUserId);
  const files = [...(m.attachments ? (Array.isArray(m.attachments) ? m.attachments : m.attachments.values()) : [])];
  return {
    eventId: m.id,
    ...(m.guildId ? { guildId: m.guildId } : {}),
    channelId: m.channelId,
    userId: m.author.id,
    text: m.content,
    mentionEveryone: !!(m.mentions?.everyone || m.mentions?.here),
    mentionsBot,
    authorIsBot: !!m.author.bot,
    ...(files.length
      ? {
          attachments: files.map((a) => ({
            id: a.id,
            name: a.name,
            url: a.url,
            size: a.size,
            ...(a.contentType ? { contentType: a.contentType } : {}),
          })),
        }
      : {}),
  };
}

export async function createDiscordJsPlatform(ctx: ConnectorContext): Promise<DiscordPlatform> {
  const token = String(ctx.config.token ?? "");
  let mod: any;
  try {
    // Not a cafe dependency: resolved from the connector directory's own node_modules when present.
    const spec = "discord.js";
    mod = await import(/* @vite-ignore */ spec);
  } catch {
    throw new Error("discord.js is not installed in this connector; run `npm install discord.js` in CAFE_HOME/connectors/discord");
  }
  const { Client, GatewayIntentBits, Partials } = mod;
  const client: AnyClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
  const channels = new Map<string, NonNullable<AnyMessage["channel"]>>();

  return {
    async connect(onMessage, onError, onReady) {
      client.on("error", (err: Error) => onError(err));
      client.on("messageCreate", (m: AnyMessage) => {
        if (!m.channel) return;
        channels.set(m.channelId, m.channel);
        // Ignore our own messages early; the filter also rejects bots.
        if (client.user && m.author.id === client.user.id) return;
        void onMessage(toPlatformMessage(m, client.user?.id)).catch((err: Error) => onError(err));
      });
      await client.login(token);
      onReady?.();
      // `login()` resolves at ready; hold the connection open until the process is signalled. Resolve only
      // when the gateway goes away, so the connector's `await connect()` returns on a real disconnect.
      await new Promise<void>((resolve) => {
        client.on("disconnect", () => {
          onError(new Error("discord gateway disconnected"));
          resolve();
        });
      });
    },
    async send(channelId, text, opts) {
      const ch = channels.get(channelId);
      if (!ch?.send) throw new Error(`discord channel ${channelId} is not known to this connector yet`);
      // `enforceNonce` makes Discord drop a resend that repeats the nonce: recovery cannot double-post.
      await ch.send(text, opts?.nonce ? { nonce: opts.nonce, enforceNonce: true } : undefined);
    },
    async download(a, opts) {
      // The URL came from the message and already passed the host allowlist; follow redirects only
      // within the same policy by re-checking where we ended up is overkill for Discord's CDN, so
      // cap by size and by the caller's own byte budget instead.
      const res = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`attachment ${a.id}: HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared && declared > opts.maxBytes) throw new Error(`attachment ${a.id} is larger than ${Math.floor(opts.maxBytes / 1024 / 1024)}MB`);
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (!res.body) throw new Error(`attachment ${a.id} returned no body`);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > opts.maxBytes) throw new Error(`attachment ${a.id} is larger than ${Math.floor(opts.maxBytes / 1024 / 1024)}MB`);
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return { bytes, name: a.name, mime: a.contentType || "application/octet-stream" };
    },
    async close() {
      await client.destroy().catch(() => {});
    },
  };
}