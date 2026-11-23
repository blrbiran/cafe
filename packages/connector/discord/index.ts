/**
 * Discord Customer connector (v4-3, #28) — the first real platform.
 *
 * A thin adapter: Discord messages become cafe Orders, the final answer goes back to the same
 * Discord channel. Everything platform-independent (Thread mapping, seen-event dedupe, outbox,
 * SSE follow) lives in `./discord-core.ts` and is unit-tested without Discord.
 *
 * Requires the bot's **Message Content** intent (Discord Developer Portal → Bot → Privileged
 * Gateway Intents). Allowlist guild/channel/user ids; a message that does not mention the bot is
 * ignored (`requireMention`). Discord posts are chunked to 2000 characters, and each chunk carries a
 * stable nonce so a crash-recovery resend cannot double-post.
 *
 * Attachments are opt-in (`allowAttachments: true`). Message URLs are attacker-controlled, so a
 * download happens only when the URL is https and its host is exactly in `attachmentHosts`
 * (`cdn.discordapp.com` / `media.discordapp.net` by default). The bytes go to the Daemon's upload
 * API; the Order carries metadata plus the text, never the file contents.
 */
import { createDiscordConnector } from "@cafe/connector/discord";
import { isEntryPoint } from "@cafe/connector/mock";

const main = createDiscordConnector();

export default main;

if (isEntryPoint(import.meta.url)) {
  main.run().catch((err) => {
    process.stderr.write(`discord connector: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}