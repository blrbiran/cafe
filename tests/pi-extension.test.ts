import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cafe, { lastAssistantText } from "@cafe/pi-extension";
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

/** Simulate pi running the injected turn and producing `answer`. */
async function runTurn(pi: ReturnType<typeof fakePi>, answer: string) {
  await pi.fire("agent_start", { type: "agent_start" }, dir);
  await pi.fire("agent_end", { type: "agent_end", messages: [assistant(answer)] }, dir);
  await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, dir);
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
    await pi.tools.get("cafe_decline").execute("t1", { reason: "not mine" });
    await pi.fire("agent_end", { type: "agent_end", messages: [assistant("I declined")] }, dir);
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
    expect(out.content[0].text).toContain("Order sent");
    await waitFor(() => pi.sent.some((s) => s.message.customType === "cafe-reply" && String(s.message.content).includes("gadgets says")));

    const waited = await pi.tools.get("cafe_ask").execute("t3", { body: "gadgets again", to: "gadgets@root", wait: true });
    expect(waited.content[0].text).toContain("done");
    expect(waited.content[0].text).toContain("gadgets says: gadgets again");

    const listed = await pi.tools.get("cafe_agents").execute("t4", {});
    expect(listed.content[0].text).toContain("widgets#1@root");
  });
});
