import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionHost, type HostMessage } from "../packages/cli/src/bridge/session-host.ts";
import { customer, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// `cafe session-host` is what the Claude Code mod talks to. Here the test plays the mod: it reads the host's
// messages and answers over the control socket, as claude-plugin/hooks/register.ts does.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function post(socket: string, path: string, body: unknown): Promise<any> {
  return new Promise((ok, fail) => {
    const req = request({ socketPath: socket, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d)).on("end", () => ok(JSON.parse(s)));
    });
    req.on("error", fail).end(JSON.stringify(body));
  });
}

async function setup(opts: { cafe?: string; injectTimeoutMs?: number } = {}) {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  const dir = mkdtempSync(join(tmpdir(), "cafe-session-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  if (opts.cafe !== "") writeFileSync(join(dir, ".cafe"), opts.cafe ?? "name: falcon\ndescription: knows the falcon project\n");
  const msgs: HostMessage[] = [];
  const host = await runSessionHost({ agent: "claude", dir, daemon: root.addr, pid: 4242, injectTimeoutMs: opts.injectTimeoutMs, send: (m) => msgs.push(m), log: () => {} });
  cleanup.push(host.stop);
  const c = await customer(root.addr);
  cleanup.push(() => c.close());
  const orders = () => msgs.filter((m): m is Extract<HostMessage, { type: "order" }> => m.type === "order");
  return { root, dir, host, msgs, orders, c, socket: host.socket! };
}

const replyOf = (events: { event: { type: string } }[]) => (events.find((e) => e.event.type === "order.replied")?.event as { text: string } | undefined)?.text;
const declineOf = (events: { event: { type: string } }[]) => events.find((e) => e.event.type === "order.declined")?.event as { reason: string; unavailable?: boolean } | undefined;

describe("cafe session-host (an interactive session as a Barista)", () => {
  it("registers as a Claude Code session, hands over one Order at a time, and returns the turn's text", async () => {
    const { root, msgs, orders, c, socket } = await setup();
    expect(msgs[0]).toMatchObject({ type: "ready", address: "falcon#1@root", socket });
    expect(root.daemon.registry.all().find((r) => r.name === "falcon")).toMatchObject({ mode: "tui", agent: "claude", pid: 4242 });

    const a = await c.ask({ body: "what port?", to: "falcon" });
    const b = await c.ask({ body: "and the codename?", to: "falcon" });
    await waitFor(() => orders().length === 1);
    const o = orders()[0]!;
    expect(o.text.startsWith(`${o.marker}\n`)).toBe(true);
    expect(o.text).toContain("what port?");

    const aDone = untilClosed(c, a.threadId);
    await post(socket, "/started", { orderId: o.orderId });
    await new Promise((r) => setTimeout(r, 50));
    expect(orders()).toHaveLength(1); // B waits for A
    await post(socket, "/done", { orderId: o.orderId, text: "9123" });
    expect(replyOf(await aDone)).toBe("9123");

    await waitFor(() => orders().length === 2);
    const bDone = untilClosed(c, b.threadId);
    await post(socket, "/started", { orderId: orders()[1]!.orderId });
    await post(socket, "/done", { orderId: orders()[1]!.orderId, text: "BLUEBIRD" });
    expect(replyOf(await bDone)).toBe("BLUEBIRD");
  });

  it("a follow-up to a thread this session answered is sent without the history", async () => {
    const { orders, c, socket } = await setup();
    const a = await c.ask({ body: "first question", to: "falcon" });
    await waitFor(() => orders().length === 1);
    const done = untilClosed(c, a.threadId);
    await post(socket, "/done", { orderId: orders()[0]!.orderId, text: "first answer" });
    await done;
    const f = await c.ask({ body: "second question", threadId: a.threadId });
    await waitFor(() => orders().length === 2);
    const text = orders()[1]!.text;
    expect(text).toContain("Follow-up from");
    expect(text).toContain("second question");
    expect(text).not.toContain("first answer");
    const fDone = untilClosed(c, f.threadId);
    await post(socket, "/done", { orderId: orders()[1]!.orderId, text: "ok" });
    await fDone;
  });

  it("CAFE_DECLINE declines on topic; an interrupted or failed turn declines as unavailable", async () => {
    const { orders, c, socket } = await setup();
    const cases: Array<[Record<string, unknown>, (d: { reason: string; unavailable?: boolean } | undefined) => void]> = [
      [{ text: "CAFE_DECLINE: billing is not mine" }, (d) => expect(d).toMatchObject({ reason: "billing is not mine" })],
      [{ text: "half", aborted: true }, (d) => expect(d).toMatchObject({ unavailable: true })],
      [{ error: "the session was stopped" }, (d) => expect(d?.reason).toContain("the session was stopped")],
      [{ text: "" }, (d) => expect(d).toMatchObject({ unavailable: true })],
    ];
    for (const [i, [body, check]] of cases.entries()) {
      const t = await c.ask({ body: `q${i}`, to: "falcon" });
      await waitFor(() => orders().length === i + 1);
      const done = untilClosed(c, t.threadId);
      await post(socket, "/done", { orderId: orders()[i]!.orderId, ...body });
      const events = await done;
      expect(replyOf(events)).toBeUndefined();
      check(declineOf(events));
    }
  });

  it("a cancel is passed to the session; the next Order follows", async () => {
    const { msgs, orders, c, socket } = await setup();
    const a = await c.ask({ body: "long job", to: "falcon" });
    await waitFor(() => orders().length === 1);
    await post(socket, "/started", { orderId: orders()[0]!.orderId });
    const b = await c.ask({ body: "next", to: "falcon" });
    await c.cancel(a.threadId);
    await waitFor(() => msgs.some((m) => m.type === "cancel" && m.orderId === orders()[0]!.orderId));
    // The aborted turn reports back; nothing more goes to the asker, and B is handed over.
    await post(socket, "/done", { orderId: orders()[0]!.orderId, text: "partial", aborted: true });
    await waitFor(() => orders().length === 2);
    const bDone = untilClosed(c, b.threadId);
    await post(socket, "/done", { orderId: orders()[1]!.orderId, text: "B" });
    expect(replyOf(await bDone)).toBe("B");
  });

  it("an Order the session does not start in time is declined as unavailable and withdrawn", async () => {
    const { msgs, orders, c } = await setup({ injectTimeoutMs: 150 });
    const a = await c.ask({ body: "anyone there?", to: "falcon" });
    const events = await untilClosed(c, a.threadId);
    expect(declineOf(events)).toMatchObject({ unavailable: true });
    expect(msgs).toContainEqual({ type: "cancel", orderId: orders()[0]!.orderId });
  });

  it("/pause leaves the network and /pause false comes back with the same address", async () => {
    const { root, socket } = await setup();
    const falcon = () => root.daemon.registry.all().find((r) => r.name === "falcon");
    expect(await post(socket, "/pause", { paused: true })).toMatchObject({ ok: true, paused: true });
    await waitFor(() => !falcon());
    expect(await post(socket, "/pause", { paused: false })).toMatchObject({ ok: true, paused: false, address: "falcon#1@root" });
    await waitFor(() => falcon()?.status === "idle");
  });

  it("without a .cafe Barista identity it says so and does not register", async () => {
    const { msgs, root } = await setup({ cafe: "" });
    expect(msgs).toEqual([expect.objectContaining({ type: "none" })]);
    expect(root.daemon.registry.all()).toHaveLength(0);
  });
});
