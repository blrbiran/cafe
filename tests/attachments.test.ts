import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");

function cli(home: string, addr: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, CAFE_HOME: home, CAFE_DAEMON: addr, CAFE_TOKEN: "t0k" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function upload(addr: string, name: string, body: string, mime = "text/plain") {
  const res = await fetch(`http://${addr}/api/artifacts?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: "POST", body });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as {
    attachment: { id: string; name: string; mime: string; size: number; sha256: string; host?: string };
  };
}

describe("attachments", () => {
  it("lets a Barista reply with an attachment", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const b = await barista(d.addr, identity("helper"), async (h) => {
      await h.ack();
      const up = await upload(d.addr, "answer.txt", "see the log", "text/plain");
      await h.reply("here it is", true, [up.attachment]);
    });
    cleanup.push(() => b.client.close());
    const c = await customer(d.addr);
    cleanup.push(() => c.close());

    const res = await c.ask({ body: "hi" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    const reply = events.find((e) => e.event.type === "order.replied")!.event as {
      attachments?: Array<{ id: string; name: string; host?: string }>;
    };
    expect(reply.attachments).toMatchObject([{ name: "answer.txt", host: "pc1" }]);

    const got = await fetch(`http://${d.addr}/api/artifacts/${reply.attachments![0]!.id}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("see the log");
  });

  it("proxies a reply attachment from the Barista's host", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    await waitFor(() => root.daemon.daemons().some((x) => x.host === "pc1" && x.online));

    await barista(child.addr, identity("helper", { description: "diagnoses things" }), async (h) => {
      await h.ack();
      const up = await upload(child.addr, "diag.txt", "diagnosis from pc1", "text/plain");
      await h.reply("see the file", true, [up.attachment]);
    });
    await waitFor(() => root.daemon.registry.all().some((a) => a.name === "helper" && a.status !== "offline"));

    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "diagnose the widget" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    const reply = events.find((e) => e.event.type === "order.replied")!.event as {
      attachments?: Array<{ id: string; name: string; host?: string }>;
    };
    expect(reply.attachments).toMatchObject([{ name: "diag.txt", host: "pc1" }]);

    // The Customer's daemon (the Root) does not hold the blob: it proxies pc1.
    const got = await fetch(`http://${root.addr}/api/artifacts/${reply.attachments![0]!.id}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("diagnosis from pc1");

    // Pull-later: the Customer's daemon copies the blob in the background, so the
    // download keeps working after the Barista's host goes offline.
    await root.daemon.sweepPulls();
    expect(root.daemon.readArtifact(reply.attachments![0]!.id)).toBeTruthy();
    await child.stop();
    const local = await fetch(`http://${root.addr}/api/artifacts/${reply.attachments![0]!.id}`);
    expect(local.status).toBe(200);
    expect(await local.text()).toBe("diagnosis from pc1");
  });

  it("cleans staged uploads that never became part of an Order", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const up = await upload(d.addr, "orphan.txt", "never attached");
    const stored = d.daemon.store.getArtifact(up.attachment.id)!;
    expect(stored.threadId).toBeUndefined();
    // Age it past the cleanup window.
    d.daemon.store.putArtifact({ ...stored, createdAt: Date.now() - 48 * 3600_000 });
    const freed = d.daemon.cleanStagedArtifacts();
    expect(freed).toBeGreaterThan(0);
    expect(d.daemon.store.getArtifact(up.attachment.id)).toBeUndefined();
    const got = await fetch(`http://${d.addr}/api/artifacts/${up.attachment.id}`);
    expect(got.status).toBe(404);
  });

  it("hands a locally uploaded file to the Barista and serves it back", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    let received: { path?: string; name?: string } | undefined;
    await barista(d.addr, identity("helper", { description: "reads files" }), async (h) => {
      await h.ack();
      received = h.attachments?.[0];
      await h.reply("read it");
    });

    const up = await upload(d.addr, "serial.log", "hello attachment");
    expect(up.attachment).toMatchObject({ name: "serial.log", mime: "text/plain", size: 16, host: "pc1" });
    expect(up.attachment.sha256).toMatch(/^[0-9a-f]{64}$/);

    const c = await customer(d.addr);
    const res = await c.ask({ body: "what does the log say?", attachments: [up.attachment] });
    await untilClosed(c, res.threadId, res.orderId);

    expect(received?.name).toBe("serial.log");
    expect(received?.path).toBeTruthy();
    expect(readFileSync(received!.path!, "utf8")).toBe("hello attachment");

    const got = await fetch(`http://${d.addr}/api/artifacts/${up.attachment.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-disposition")).toContain("attachment");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await got.text()).toBe("hello attachment");
  });

  it("pulls an attachment from the origin host before the remote Barista starts", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    await waitFor(() => root.daemon.daemons().some((x) => x.host === "pc1" && x.online));

    let received: { path?: string; name?: string } | undefined;
    await barista(child.addr, identity("helper", { description: "reads files" }), async (h) => {
      await h.ack();
      received = h.attachments?.[0];
      await h.reply("got it");
    });
    await waitFor(() => root.daemon.registry.all().some((a) => a.name === "helper" && a.status !== "offline"));

    const up = await upload(root.addr, "capture.pcap", "remote bytes");
    const c = await customer(root.addr);
    const res = await c.ask({ body: "inspect the capture", attachments: [up.attachment] });
    await untilClosed(c, res.threadId, res.orderId);

    expect(received?.name).toBe("capture.pcap");
    expect(readFileSync(received!.path!, "utf8")).toBe("remote bytes");

    // The child's Web/CLI asks its own daemon; the daemon proxies the origin.
    const got = await fetch(`http://${child.addr}/api/artifacts/${up.attachment.id}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("remote bytes");
  });

  it("a follow-up's attachments are added to the Thread's list (the card counts them all)", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    await barista(d.addr, identity("helper", { description: "reads files" }), async (h) => {
      await h.ack();
      await h.reply("read it");
    });
    const c = await customer(d.addr);
    const one = (await upload(d.addr, "one.log", "1")).attachment;
    const a = await c.ask({ body: "look at this", attachments: [one] });
    await untilClosed(c, a.threadId, a.orderId);
    const two = (await upload(d.addr, "two.png", "2")).attachment;
    const f = await c.ask({ body: "and this", threadId: a.threadId, attachments: [two, one] });
    await untilClosed(c, f.threadId, f.orderId);
    const meta = d.daemon.thread(a.threadId)!.meta;
    expect(meta.attachments?.map((x) => x.name)).toEqual(["one.log", "two.png"]);
    // The title is still the first question.
    expect(meta.summary).toBe("look at this");
  });

  it("rejects an empty upload and a path-traversal name", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    const empty = await fetch(`http://${d.addr}/api/artifacts?name=empty.txt`, { method: "POST", body: "" });
    expect(empty.status).toBe(400);
    const traversal = await fetch(`http://${d.addr}/api/artifacts?name=${encodeURIComponent("../escape.txt")}`, { method: "POST", body: "x" });
    expect(traversal.status).toBe(400);
  });

  it("cafe ask --attach uploads before the Order and thread --download fetches it", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    let received: { id?: string; path?: string; name?: string } | undefined;
    await barista(d.addr, identity("helper", { description: "reads files" }), async (h) => {
      await h.ack();
      received = h.attachments?.[0];
      await h.reply("ok");
    });
    const dir = mkdtempSync(join(tmpdir(), "cafe-cli-attach-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "serial.log");
    writeFileSync(file, "cli attachment");

    const asked = await cli(d.home, d.addr, "ask", "--attach", file, "read it");
    expect(asked.status, asked.stderr).toBe(0);
    expect(received?.name).toBe("serial.log");
    expect(readFileSync(received!.path!, "utf8")).toBe("cli attachment");
    const threadId = /thread (\w+)/.exec(asked.stdout)?.[1];
    expect(threadId).toBeTruthy();

    const outDir = join(dir, "out");
    const got = await cli(d.home, d.addr, "thread", threadId!, "--download", received!.id!, "--out", outDir);
    expect(got.status, got.stderr).toBe(0);
    expect(readFileSync(join(outDir, "serial.log"), "utf8")).toBe("cli attachment");
  });
});