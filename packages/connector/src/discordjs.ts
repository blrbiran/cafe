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
  channel?: { send(text: string): Promise<unknown>; isDMBased?(): boolean };
  author: { id: string; bot?: boolean };
  mentions?: { users?: { has(id: string): boolean }; everyone?: boolean; here?: boolean };
}

/** Build a `PlatformMessage` from a discord.js message; `botUserId` is our own user id. */
export function toPlatformMessage(m: AnyMessage, botUserId: string | undefined): PlatformMessage {
  const mentionsBot = !!botUserId && !!m.mentions?.users?.has(botUserId);
  return {
    eventId: m.id,
    ...(m.guildId ? { guildId: m.guildId } : {}),
    channelId: m.channelId,
    userId: m.author.id,
    text: m.content,
    mentionEveryone: !!(m.mentions?.everyone || m.mentions?.here),
    mentionsBot,
    authorIsBot: !!m.author.bot,
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
    async send(channelId, text) {
      const ch = channels.get(channelId);
      if (!ch?.send) throw new Error(`discord channel ${channelId} is not known to this connector yet`);
      await ch.send(text);
    },
    async close() {
      await client.destroy().catch(() => {});
    },
  };
}