import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cafe, { formatHistory, isOrderMessage, lastAssistantText, orderPrompt } from "@cafe/pi-extension";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

type Handler = (event: any, ctx: any) => unknown;

/** Minimal stand-in for pi's ExtensionAPI: records handlers, tools and sent messages. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  const api = {
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    registerTool(t: any) {
      tools.set(t.name, t);
    },
    registerMessageRenderer() {},
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  let idle = true;
  const statuses: Array<string | undefined> = [];
  const ctx = (cwd: string) => ({
    cwd,
    hasUI: false,
    mode: "print",
    isIdle: () => idle,
    ui: { setStatus: (_k: string, t: string | undefined) => statuses.push(t), confirm: async () => true },
  });
  return {
    api,
    tools,
    sent,
    statuses,
    setIdle: (v: boolean) => (idle = v),
    async fire(event: string, payload: any, cwd: string) {
      for (const h of handlers.get(event) ?? []) await h(payload, ctx(cwd));
    },
  };
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

/** The CustomMessage pi builds in AgentSession.sendCustomMessage for an extension sendMessage(). */
function asCustom(sent: { message: any }) {
  return { role: "custom", customType: sent.message.customType, content: sent.message.content, display: sent.message.display, details: sent.message.details, timestamp: Date.now() };
}

const cleanup: Array<() => unknown> = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cafe-ext-"));
  writeFileSync(join(dir, ".cafe"), "name: widgets\ndescription: owns the widget service\ntags: [widgets]\n");
});
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CAFE_DAEMON;
});

async function setup() {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  process.env.CAFE_DAEMON = root.addr;
  const pi = fakePi();
  cafe(pi.api as any);
  await pi.fire("session_start", { type: "session_start", reason: "startup" }, dir);
  cleanup.push(() => pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, dir));
  await waitFor(() => root.daemon.registry.all().some((r) => r.address === "widgets#1@root"));
  const c = await customer(root.addr);
  cleanup.push(() => c.close());
  return { root, pi, c };
}

const orders = (pi: ReturnType<typeof fakePi>) => pi.sent.filter((s) => s.message.customType === "cafe-order");

/** Simulate one pi run: agent_start, message_end for each message, agent_end, agent_settled. */
async function run(pi: ReturnType<typeof fakePi>, messages: any[]) {
  await pi.fire("agent_start", { type: "agent_start" }, dir);
  for (const message of messages) await pi.fire("message_end", { type: "message_end", message }, dir);
  await pi.fire("agent_end", { type: "agent_end", messages }, dir);
  await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, dir);
}

/** Simulate pi running the run started by the latest injected Order and producing `answer`. */
async function runTurn(pi: ReturnType<typeof fakePi>, answer: string) {
  await run(pi, [asCustom(orders(pi).at(-1)!), assistant(answer)]);
}

describe("pi extension", () => {
  it("extracts the last assistant text", () => {
    expect(lastAssistantText([assistant("a"), { role: "user", content: "x" }, assistant("b")])).toBe("b");
    expect(lastAssistantText([{ role: "user", content: "x" }])).toBeUndefined();
  });

  it("serves an Order: inject when idle, reply with the turn's final text", async () => {
    const { pi, c } = await setup();
    const res = await c.ask({ body: "how many widgets?" });
    await waitFor(() => pi.sent.some((s) => s.message.customType === "cafe-order"));
    const injected = pi.sent.find((s) => s.message.customType === "cafe-order")!;
    expect(injected.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(injected.message.content).toContain("how many widgets?");
    const closed = untilClosed(c, res.threadId);
    await runTurn(pi, "42 widgets");
    const events = await closed;
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "42 widgets", final: true });
  });

  it("queues Orders while busy and drains on agent_settled", async () => {
    const { pi, c } = await setup();
    pi.setIdle(false);
    const res = await c.ask({ body: "widgets later", to: "widgets@root" });
    await new Promise((r) => setTimeout(r, 100));
    expect(pi.sent.filter((s) => s.message.customType === "cafe-order")).toHaveLength(0);
    pi.setIdle(true);
    // The human's own run settles: the queued Order is injected now.
    await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, dir);
    await waitFor(() => pi.sent.some((s) => s.message.customType === "cafe-order"));
    const closed = untilClosed(c, res.threadId);
    await runTurn(pi, "done later");
    expect((await closed).find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "done later" });
  });

  it("cafe_decline replaces the final reply with a decline", async () => {
    const { pi, c } = await setup();
    const res = await c.ask({ body: "widgets?", to: "widgets@root" });
    await waitFor(() => pi.sent.some((s) => s.message.customType === "cafe-order"));
    const closed = untilClosed(c, res.threadId);
    await pi.fire("agent_start", { type: "agent_start" }, dir);
    await pi.fire("message_end", { type: "message_end", message: asCustom(orders(pi).at(-1)!) }, dir);
    await pi.tools.get("cafe_decline").execute("t1", { reason: "not mine" });
    await pi.fire("message_end", { type: "message_end", message: assistant("I declined") }, dir);
    await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, dir);
    const types = (await closed).map((e) => e.event.type);
    expect(types).toContain("order.declined");
    expect(types).not.toContain("order.replied");
  });

  it("cafe_ask: async replies are injected as cafe-reply; wait=true returns them", async () => {
    const { root, pi } = await setup();
    const other = await barista(root.addr, identity("gadgets", { tags: ["gadgets"] }));
    cleanup.push(() => other.client.close());
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "gadgets"));

    const out = await pi.tools.get("cafe_ask").execute("t2", { body: "gadgets status?" });
    expect(out.content[0].text).toMatch(/Order \S+ sent \(threadId \S+\)/);
    await waitFor(() => pi.sent.some((s) => s.message.customType === "cafe-reply" && String(s.message.content).includes("gadgets says")));

    const waited = await pi.tools.get("cafe_ask").execute("t3", { body: "gadgets again", to: "gadgets@root", wait: true });
    expect(waited.content[0].text).toContain("done");
    expect(waited.content[0].text).toContain("gadgets says: gadgets again");

    const listed = await pi.tools.get("cafe_agents").execute("t4", {});
    expect(listed.content[0].text).toContain("widgets#1@root");
  });
  it("a human run between the injection and the Order's run produces no Reply and does not swallow the Order", async () => {
    const { pi, c } = await setup();
    const res = await c.ask({ body: "widgets?", to: "widgets@root" });
    await waitFor(() => orders(pi).length === 1);
    let replied = false;
    c.onThreadEvent((e) => {
      if (e.threadId === res.threadId && e.event.type === "order.replied") replied = true;
    });
    // The human's own run settles first (the injected message has not been processed yet).
    await run(pi, [user("refactor foo"), assistant("refactored foo")]);
    await new Promise((r) => setTimeout(r, 100));
    expect(replied).toBe(false);
    const closed = untilClosed(c, res.threadId);
    // Then the run containing the Order.
    await runTurn(pi, "7 widgets");
    const events = await closed;
    expect(events.filter((e) => e.event.type === "order.replied").map((e) => (e.event as any).text)).toEqual(["7 widgets"]);
  });

  it("a human message after the Order inside the same run does not become the Reply", async () => {
    const { pi, c } = await setup();
    const res = await c.ask({ body: "widgets?", to: "widgets@root" });
    await waitFor(() => orders(pi).length === 1);
    const closed = untilClosed(c, res.threadId);
    await run(pi, [asCustom(orders(pi)[0]!), assistant("order answer"), user("now do my thing"), assistant("human answer")]);
    expect((await closed).find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "order answer" });
  });

  it("an Order queued as a follow-up inside a human run is answered by the text after it", async () => {
    const { pi, c } = await setup();
    const res = await c.ask({ body: "widgets?", to: "widgets@root" });
    await waitFor(() => orders(pi).length === 1);
    const closed = untilClosed(c, res.threadId);
    // Human prompt first, our followUp message delivered later in the same run.
    await run(pi, [user("hi"), assistant("hello human"), asCustom(orders(pi)[0]!), assistant("order answer")]);
    expect((await closed).find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "order answer" });
  });

  it("follow-up Orders carry the thread transcript; cafe_ask continues a thread by threadId", async () => {
    const { root, pi, c } = await setup();
    const first = await c.ask({ body: "how many widgets?", to: "widgets@root" });
    await waitFor(() => orders(pi).length === 1);
    let closed = untilClosed(c, first.threadId);
    await runTurn(pi, "42 widgets");
    await closed;

    const second = await c.ask({ body: "and yesterday?", threadId: first.threadId });
    expect(second.threadId).toBe(first.threadId);
    await waitFor(() => orders(pi).length === 2);
    const prompt = String(orders(pi)[1]!.message.content);
    expect(prompt).toContain("follow-up (turn 2)");
    expect(prompt).toContain("how many widgets?");
    expect(prompt).toContain("42 widgets");
    expect(prompt).toContain("and yesterday?");
    closed = untilClosed(c, first.threadId);
    await runTurn(pi, "40 yesterday");
    expect((await closed).find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "40 yesterday" });

    // Customer side, from the extension: wait-mode ask, then a follow-up by threadId.
    const other = await barista(root.addr, identity("gadgets", { tags: ["gadgets"] }), async (h) => {
      await h.ack();
      await h.reply(`turn ${h.order.turn}: ${h.order.body}`);
    });
    cleanup.push(() => other.client.close());
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "gadgets"));
    const a1 = await pi.tools.get("cafe_ask").execute("t5", { body: "gadgets?", to: "gadgets@root", wait: true });
    const tid = /threadId (\S+)\)/.exec(a1.content[0].text)![1]!;
    expect(a1.content[0].text).toContain("turn 1: gadgets?");
    const a2 = await pi.tools.get("cafe_ask").execute("t6", { body: "more?", threadId: tid, wait: true });
    expect(a2.content[0].text).toContain("turn 2: more?");
    expect(a2.content[0].text).not.toContain("turn 1:");
  });

  it("cafe_ask on a busy thread fails with a clear error", async () => {
    const { root, pi } = await setup();
    const slow = await barista(root.addr, identity("slow"), async (h) => {
      await h.ack();
    });
    cleanup.push(() => slow.client.close());
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "slow"));
    const out = await pi.tools.get("cafe_ask").execute("t7", { body: "x", to: "slow@root" });
    const tid = /threadId (\S+)\)/.exec(out.content[0].text)![1]!;
    await expect(pi.tools.get("cafe_ask").execute("t8", { body: "y", threadId: tid })).rejects.toThrow(/still has an open Order/);
  });

  it("formats follow-up prompts and recognises the injected message", () => {
    const order: any = { orderId: "o2", threadId: "t", turn: 2, from: { address: "cli@h" }, body: "next?", history: [{ from: "cli@h", role: "customer", text: "q1" }, { from: "w#1@h", role: "barista", text: "a1" }] };
    expect(formatHistory(order.history)).toBe("[customer cli@h]\nq1\n\n[barista w#1@h]\na1");
    expect(orderPrompt(order)).toContain("--- new message ---\nnext?");
    expect(isOrderMessage({ role: "custom", customType: "cafe-order", details: { order } }, "o2")).toBe(true);
    expect(isOrderMessage({ role: "custom", customType: "cafe-order", details: { order } }, "o1")).toBe(false);
  });
});
