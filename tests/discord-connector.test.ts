import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiscordConnector, chunkText, filterReason, readConfig, useReason, type DiscordPlatform, type PlatformMessage } from "../packages/connector/src/discord-core.ts";
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

describe("discord attachment policy", () => {
  const withAttachment = (url: string, over: Partial<PlatformMessage> = {}) =>
    baseMsg({ text: "look at this", attachments: [{ id: "a1", name: "screen.png", url, size: 12, contentType: "image/png" }], ...over });

  it("is off unless the connector opts in", () => {
    const cfg = readConfig({ allowChannels: ["c1"], allowUsers: ["u1"] });
    expect(useReason(withAttachment("https://cdn.discordapp.com/a.png"), cfg)).toMatch(/attachments are disabled/);
  });

  it("downloads only from the explicit CDN allowlist over https", () => {
    const cfg = readConfig({ allowChannels: ["c1"], allowUsers: ["u1"], allowAttachments: true });
    expect(useReason(withAttachment("https://cdn.discordapp.com/attachments/1/a.png"), cfg)).toBeUndefined();
    expect(useReason(withAttachment("https://evil.example/a.png"), cfg)).toMatch(/not an allowed attachment host/);
    expect(useReason(withAttachment("http://cdn.discordapp.com/a.png"), cfg)).toMatch(/https/);
    // A host that merely ends with the allowed name must not pass.
    expect(useReason(withAttachment("https://cdn.discordapp.com.evil.example/a.png"), cfg)).toMatch(/not an allowed/);
  });

  it("honours a custom allowlist and the size limit", () => {
    const cfg = readConfig({ allowChannels: ["c1"], allowUsers: ["u1"], allowAttachments: true, attachmentHosts: ["files.example"] });
    expect(useReason(withAttachment("https://files.example/a.png"), cfg)).toBeUndefined();
    expect(useReason(withAttachment("https://cdn.discordapp.com/a.png"), cfg)).toMatch(/not an allowed/);
    expect(useReason(withAttachment("https://files.example/a.png", { attachments: [{ id: "a1", name: "big.bin", url: "https://files.example/big.bin", size: 999_999_999, contentType: "application/octet-stream" }] }), cfg)).toMatch(/too large/);
  });

  it("accepts a message that is only an attachment when attachments are enabled", () => {
    const cfg = readConfig({ allowChannels: ["c1"], allowUsers: ["u1"], allowAttachments: true });
    expect(filterReason(withAttachment("https://cdn.discordapp.com/a.png", { text: "" }), cfg)).toBeUndefined();
    // Without the opt-in, an empty message stays empty.
    expect(filterReason(baseMsg({ text: "" }), readConfig({ allowChannels: ["c1"] }))).toMatch(/empty/);
  });
});

describe("discord attachments end to end (fake platform)", () => {
  /** A fake Discord where attachments "download" locally; the URL policy is still the core's. */
  function fakePlatform(attachmentBytes = new Map<string, Uint8Array>()) {
    const sent: Array<{ channelId: string; text: string; nonce?: string }> = [];
    const downloaded: string[] = [];
    let deliver: (m: PlatformMessage) => Promise<void> = async () => {};
    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => (markReady = r));
    const platform: DiscordPlatform = {
      async connect(onMessage, _onError, onReady) {
        deliver = onMessage;
        onReady?.();
        markReady();
        await new Promise<void>((resolve) => {
          const t = setInterval(() => resolve(), 20);
          t.unref?.();
          setTimeout(() => clearInterval(t), 60_000).unref?.();
        });
      },
      async download(a) {
        downloaded.push(a.url);
        const bytes = attachmentBytes.get(a.url);
        if (!bytes) throw new Error(`fake platform has no bytes for ${a.url}`);
        return { bytes, name: a.name, mime: a.contentType ?? "application/octet-stream" };
      },
      async send(channelId, text, opts) {
        sent.push({ channelId, text, nonce: opts?.nonce });
      },
      async close() {},
    };
    return { platform, sent, downloaded, ready, push: (m: PlatformMessage) => deliver(m) };
  }

  it("downloads an allowlisted file, attaches it to the Order, and keeps the bytes off the prompt", async () => {
    const d = await daemonWithBarista();
    const seenOrders: Array<{ body: string; attachments?: Array<{ name: string; id: string }> }> = [];
    const b2 = await barista(d.addr, identity("reader", { description: "reads files" }), async (h) => {
      await h.ack();
      seenOrders.push({ body: h.order.body, attachments: (h.order.attachments ?? []).map((a) => ({ name: a.name, id: a.id })) });
      await h.reply("read it");
    });
    cleanups.push(() => b2.client.close());

    const stateDir = tempDir("cafe-discord-attach-");
    const { writeFileSync } = await import("node:fs");
    const url = "https://cdn.discordapp.com/attachments/1/notes.txt";
    const fake = fakePlatform(new Map([[url, new TextEncoder().encode("secret file body")]]));
    writeFileSync(
      stateDir + "/config.json",
      JSON.stringify({ token: "x", allowChannels: ["c1"], allowUsers: ["u1"], allowAttachments: true, requireMention: false }),
    );
    const main = createDiscordConnector({
      platform: async () => fake.platform,
      env: { CAFE_DAEMON: d.addr, CAFE_TOKEN: "t0k", CAFE_CONNECTOR_STATE: stateDir, CAFE_CONNECTOR_NAME: "discord", CAFE_CONNECTOR_CONFIG: join(stateDir, "config.json") },
      heartbeatMs: 0,
    });
    const runP = main.run();
    await fake.ready;
    await fake
      .push(
        baseMsg({
          eventId: "e-att",
          text: "please read this",
          mentionsBot: false,
          attachments: [{ id: "a1", name: "notes.txt", url, size: 16, contentType: "text/plain" }],
        }),
      )
      .catch(() => {});
    await waitFor(() => fake.sent.some((s) => s.text === "read it"), 8_000);
    expect(fake.downloaded).toEqual([url]);
    const order = seenOrders.at(-1)!;
    expect(order.body).toBe("please read this");
    expect(order.body).not.toContain("secret file body");
    expect(order.attachments?.map((a) => a.name)).toEqual(["notes.txt"]);
    main.stop();
    await runP.catch(() => {});
  }, 20_000);

  it("keeps a stable outbound nonce per reply chunk so a resend cannot double-post", async () => {
    const d = await daemonWithBarista();
    const stateDir = tempDir("cafe-discord-nonce-");
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ token: "x", allowChannels: ["c1"], allowUsers: ["u1"], requireMention: false }));
    const env = { CAFE_DAEMON: d.addr, CAFE_TOKEN: "t0k", CAFE_CONNECTOR_STATE: stateDir, CAFE_CONNECTOR_NAME: "discord", CAFE_CONNECTOR_CONFIG: join(stateDir, "config.json") };
    const connector = (p: typeof fake.platform) => createDiscordConnector({ platform: async () => p, env, heartbeatMs: 0 });
    const fake = fakePlatform();
    const main = connector(fake.platform);
    const runP = main.run();
    await fake.ready;
    await fake.push(baseMsg({ eventId: "e-nonce", text: "repeat me", mentionsBot: false })).catch(() => {});
    await waitFor(() => fake.sent.length > 0, 8_000);
    const firstNonces = fake.sent.map((s) => s.nonce);
    expect(firstNonces.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    main.stop();
    await runP.catch(() => {});

    // Simulate a crash between "posted to Discord" and "marked delivered": recovery must resend, and
    // the repeated nonce is what makes Discord drop the duplicate instead of posting twice.
    const outboxPath = join(stateDir, "outbox.json");
    const outbox = JSON.parse(readFileSync(outboxPath, "utf8")) as { items: Array<{ eventId: string; delivered?: boolean }> };
    const item = outbox.items.find((i) => i.eventId === "e-nonce")!;
    delete item.delivered;
    writeFileSync(outboxPath, JSON.stringify(outbox));

    const fake2 = fakePlatform();
    const main2 = connector(fake2.platform);
    const run2 = main2.run();
    await fake2.ready;
    await waitFor(() => fake2.sent.length > 0, 8_000);
    expect(fake2.sent.map((s) => s.nonce)).toEqual(firstNonces);
    main2.stop();
    await run2.catch(() => {});
  }, 20_000);
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
    async download(a) {
      throw new Error(`this fake has no attachment bytes (${a.id})`);
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