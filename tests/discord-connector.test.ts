import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiscordConnector, chunkText, filterReason, readConfig, type DiscordPlatform, type PlatformMessage } from "../packages/connector/src/discord-core.ts";
import { barista, identity, startDaemon, waitFor } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const baseMsg = (over: Partial<PlatformMessage> = {}): PlatformMessage => ({
  eventId: "m1",
  guildId: "g1",
  channelId: "c1",
  userId: "u1",
  text: "how do I deploy?",
  mentionsBot: true,
  authorIsBot: false,
  ...over,
});

describe("discord filter", () => {
  const cfg = readConfig({ allowGuilds: ["g1"], allowChannels: ["c1"], allowUsers: ["u1"] });

  it("accepts an allowlisted mention and explains each rejection", () => {
    expect(filterReason(baseMsg(), cfg)).toBeUndefined();
    expect(filterReason(baseMsg({ authorIsBot: true }), cfg)).toMatch(/bot/);
    expect(filterReason(baseMsg({ text: "   " }), cfg)).toMatch(/empty/);
    expect(filterReason(baseMsg({ mentionEveryone: true }), cfg)).toMatch(/everyone/);
    expect(filterReason(baseMsg({ guildId: "g2" }), cfg)).toMatch(/g2.*allowGuilds/);
    expect(filterReason(baseMsg({ channelId: "c2" }), cfg)).toMatch(/c2.*allowChannels/);
    expect(filterReason(baseMsg({ userId: "u2" }), cfg)).toMatch(/u2.*allowUsers/);
    expect(filterReason(baseMsg({ mentionsBot: false }), cfg)).toMatch(/mention/);
  });

  it("honours requireMention: false and the DM switch", () => {
    const relaxed = readConfig({ allowChannels: ["c1"], requireMention: false });
    expect(filterReason(baseMsg({ mentionsBot: false }), relaxed)).toBeUndefined();
    const noDm = readConfig({});
    expect(filterReason(baseMsg({ guildId: undefined, channelId: "dm1" }), noDm)).toMatch(/direct messages/);
    const dm = readConfig({ allowDMs: true });
    expect(filterReason(baseMsg({ guildId: undefined, channelId: "dm1", mentionsBot: false }), dm)).toBeUndefined();
  });
});

describe("discord chunking", () => {
  it("splits long replies under the 2000-char limit at a boundary", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.join("\n").replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
    expect(chunkText("short")).toEqual(["short"]);
  });
});

/** A fake Discord: records what was sent, lets the test push messages, runs nothing else. */
function fakePlatform() {
  const sent: Array<{ channelId: string; text: string }> = [];
  let deliver: (m: PlatformMessage) => Promise<void> = async () => {};
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => (markReady = r));
  let closed = false;
  const platform: DiscordPlatform = {
    async connect(onMessage, _onError, onReady) {
      deliver = onMessage;
      onReady?.();
      markReady();
      // Stay connected until close(); connect() resolves on disconnect.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => closed && resolve(), 20);
        t.unref?.();
      });
    },
    async send(channelId, text) {
      sent.push({ channelId, text });
    },
    async close() {
      closed = true;
    },
  };
  return { platform, sent, ready, push: (m: PlatformMessage) => deliver(m) };
}

async function daemonWithBarista() {
  const d = await startDaemon("discord");
  cleanups.push(() => d.stop());
  const b = await barista(d.addr, identity("replier", { description: "answers questions" }), async (h) => {
    await h.ack();
    await h.reply(`answered: ${h.order.body}`);
  });
  cleanups.push(() => b.client.close());
  return d;
}

describe("discord connector end to end (fake platform)", () => {
  it("turns a mention into an Order and posts the final answer back to the channel", async () => {
    const d = await daemonWithBarista();
    const stateDir = tempDir("cafe-discord-state-");
    const fake = fakePlatform();
    const { platform, sent, push, ready: fakeReady } = fake;
    const config = { token: "x", allowChannels: ["c1"], allowUsers: ["u1"] };
    const main = createDiscordConnector({
      platform: async () => platform,
      env: { CAFE_DAEMON: d.addr, CAFE_TOKEN: "t0k", CAFE_CONNECTOR_STATE: stateDir, CAFE_CONNECTOR_NAME: "discord", CAFE_CONNECTOR_CONFIG: join(stateDir, "config.json") },
      heartbeatMs: 0,
    });
    // Provide the config file the SDK reads (token + allowlists).
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(stateDir, "config.json"), JSON.stringify(config));

    const runP = main.run();
    // connect() must be up before a message can be delivered.
    await fakeReady;
    await push(baseMsg({ eventId: "e1", text: "hello there" })).catch(() => {});
    await waitFor(() => sent.some((s) => s.text === "answered: hello there"), 8_000);
    main.stop();
    await runP.catch(() => {});
  }, 20_000);

  it("ignores a non-allowlisted channel", async () => {
    const d = await daemonWithBarista();
    const { writeFileSync } = await import("node:fs");
    const stateDir = tempDir("cafe-discord-skip-");
    const { platform, sent, push, ready: fakeReady } = fakePlatform();
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ token: "x", allowChannels: ["other"] }));
    const main = createDiscordConnector({
      platform: async () => platform,
      env: { CAFE_DAEMON: d.addr, CAFE_TOKEN: "t0k", CAFE_CONNECTOR_STATE: stateDir, CAFE_CONNECTOR_NAME: "discord", CAFE_CONNECTOR_CONFIG: join(stateDir, "config.json") },
      heartbeatMs: 0,
    });
    const runP = main.run();
    await fakeReady;
    await push(baseMsg({ eventId: "e2", channelId: "c1" })).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toEqual([]);
    main.stop();
    await runP.catch(() => {});
  }, 20_000);
});