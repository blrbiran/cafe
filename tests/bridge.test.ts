import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runBridge, type Access, type AgentKind } from "../packages/cli/src/bridge/barista.ts";
import { claudeArgs } from "../packages/cli/src/bridge/claude.ts";
import { refuseServerRequest } from "../packages/cli/src/bridge/codex.ts";
import { customer, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const BIN: Record<AgentKind, string> = { codex: join(FIX, "fake-codex.mjs"), claude: join(FIX, "fake-claude.mjs") };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(agent: AgentKind, access?: Access) {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  const tmp = mkdtempSync(join(tmpdir(), `cafe-bridge-${agent}-`));
  cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  const dir = join(tmp, "work");
  const state = join(tmp, "state");
  mkdirSync(dir);
  mkdirSync(state);
  writeFileSync(join(dir, ".cafe"), "name: coder\ndescription: answers questions about the code\n");
  const logFile = join(tmp, "agent.log");
  const KEY = agent === "codex" ? "FAKE_CODEX" : "FAKE_CLAUDE";
  process.env[`${KEY}_STATE`] = state;
  process.env[`${KEY}_LOG`] = logFile;
  cleanup.push(() => {
    delete process.env[`${KEY}_STATE`];
    delete process.env[`${KEY}_LOG`];
  });
  const start = async () => {
    const b = await runBridge({ agent, dir, daemon: root.addr, bin: BIN[agent], access, log: process.env.BRIDGE_DEBUG ? (m) => console.log("BRIDGE", m) : () => {} });
    cleanup.push(b.stop);
    return b;
  };
  const bridge = await start();
  const c = await customer(root.addr);
  cleanup.push(() => c.close());
  const ask = async (body: string, threadId?: string, to = "coder") => {
    const res = await c.ask({ body, to, threadId });
    const events = await untilClosed(c, res.threadId);
    if (process.env.BRIDGE_DEBUG) console.log(JSON.stringify(events.map((e) => e.event)));
    return { ...res, events: events.filter((e) => e.orderId === res.orderId) };
  };
  const logged = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, dir, state, bridge, start, c, ask, logged };
}

const replyOf = (events: { event: { type: string } }[]) => (events.find((e) => e.event.type === "order.replied")?.event as { text: string } | undefined)?.text;

describe.each(["codex", "claude"] as const)("native %s barista", (agent) => {
  it("answers, continues the same session for a follow-up, and is read-only by default", async () => {
    const { ask, logged, root } = await setup(agent);
    // The Registry says which agent runs it and that it is read-only (shown on the Agents page).
    expect(root.daemon.registry.all().find((r) => r.name === "coder")).toMatchObject({ mode: "headless", agent, access: "read-only" });
    const first = await ask("what is x");
    expect(replyOf(first.events)).toBe("turn=1 kind=fresh q=what is x");
    const second = await ask("and y", first.threadId);
    expect(replyOf(second.events)).toBe("turn=2 kind=followup q=and y");

    if (agent === "codex") {
      const starts = logged().filter((m) => m.method === "thread/start");
      expect(starts).toHaveLength(1);
      expect(starts[0].params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
      // The fake asks to run a command each turn; the bridge refuses.
      const answers = logged().filter((m) => typeof m.id === "string" && m.id.startsWith("srv-"));
      expect(answers.length).toBeGreaterThan(0);
      expect(answers.every((m) => m.result?.decision === "decline")).toBe(true);
    } else {
      const calls = logged() as string[][];
      expect(calls).toHaveLength(2);
      for (const a of calls) {
        expect(a).toEqual(expect.arrayContaining(["-p", "--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob", "--setting-sources", "user"]));
        expect(a).not.toContain("--dangerously-skip-permissions");
      }
      expect(calls[0]).toContain("--session-id");
      expect(calls[1]![calls[1]!.indexOf("--resume") + 1]).toBe(calls[0]![calls[0]!.indexOf("--session-id") + 1]);
    }
  });

  it("resumes the session after the barista restarts (mapping kept by the daemon)", async () => {
    const { ask, bridge, start, root, dir } = await setup(agent);
    const first = await ask("what is x");
    const sid = root.daemon.store.getAgentSession(agent, dir, first.threadId);
    expect(sid).toBeTruthy();
    await bridge.stop();
    await start();
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "coder" && r.status !== "offline"));
    const second = await ask("and y", first.threadId);
    expect(replyOf(second.events)).toBe("turn=2 kind=followup q=and y");
  });

  it("starts a fresh session with the history when the old one is gone", async () => {
    const { ask, state, root, dir } = await setup(agent);
    const first = await ask("what is x");
    const old = root.daemon.store.getAgentSession(agent, dir, first.threadId);
    for (const f of readdirSync(state)) rmSync(join(state, f));
    const second = await ask("and y", first.threadId);
    // A fresh prompt: the question comes after "Question:", and the earlier turn travels as history.
    expect(replyOf(second.events)).toBe("turn=1 kind=fresh q=and y");
    const now = root.daemon.store.getAgentSession(agent, dir, first.threadId);
    expect(now).toBeTruthy();
    expect(now).not.toBe(old);
  });

  it("a cancel interrupts the running turn and the barista takes the next question", async () => {
    const { c, ask, root, logged } = await setup(agent);
    const res = await c.ask({ body: "SLOW please", to: "coder" });
    await waitFor(() => root.daemon.thread(res.threadId)?.meta.status === "working");
    await new Promise((r) => setTimeout(r, 200));
    await c.cancel(res.threadId);
    await waitFor(() => root.daemon.thread(res.threadId)?.meta.status === "cancelled");
    if (agent === "codex") await waitFor(() => logged().some((m) => m.method === "turn/interrupt"));
    const next = await ask("what is z");
    expect(replyOf(next.events)).toBe("turn=1 kind=fresh q=what is z");
  });

  it("CAFE_DECLINE: declines on topic; an agent failure declines as unavailable", async () => {
    const { ask } = await setup(agent);
    const d = await ask("DECLINE this");
    expect(d.events.find((e) => e.event.type === "order.declined")?.event).toMatchObject({ reason: "not my topic" });
    expect((d.events.find((e) => e.event.type === "order.declined")?.event as { unavailable?: boolean }).unavailable).toBeUndefined();
    if (agent === "claude") {
      const f = await ask("FAIL now");
      expect(f.events.find((e) => e.event.type === "order.declined")?.event).toMatchObject({ unavailable: true, reason: expect.stringContaining("it broke") });
    }
  });

  it("--write gives workspace-write, never more", async () => {
    const { ask, logged, root } = await setup(agent, "workspace-write");
    expect(root.daemon.registry.all().find((r) => r.name === "coder")).toMatchObject({ agent, access: "write" });
    await ask("edit something");
    if (agent === "codex") {
      expect(logged().find((m) => m.method === "thread/start").params).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "never" });
    } else {
      const a = (logged() as string[][])[0]!;
      expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write");
      expect(a).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk"]));
    }
  });
});

describe("bridge details", () => {
  it("claude uses --bare instead of user settings when an API key is configured", () => {
    expect(claudeArgs({ access: "read-only", apiKey: true, sessionId: "s" })).toContain("--bare");
    expect(claudeArgs({ access: "read-only", apiKey: true, sessionId: "s" })).not.toContain("--setting-sources");
    expect(claudeArgs({ access: "read-only", apiKey: false, resume: "s", model: "sonnet" })).toEqual(
      expect.arrayContaining(["--setting-sources", "user", "--resume", "s", "--model", "sonnet"]),
    );
  });

  it("codex approval and input requests are always refused", () => {
    expect(refuseServerRequest("item/fileChange/requestApproval")).toEqual({ result: { decision: "decline" } });
    expect(refuseServerRequest("execCommandApproval")).toEqual({ result: { decision: "denied" } });
    expect(refuseServerRequest("mcpServer/elicitation/request")).toEqual({ result: { action: "decline" } });
    expect(refuseServerRequest("item/tool/call")).toHaveProperty("error");
  });
});

describe("supervised native barista", () => {
  it("barista start --agent codex runs `cafe barista run` under the daemon's supervisor", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cafe-sup-codex-"));
    const dir = join(tmp, "work");
    const state = join(tmp, "state");
    mkdirSync(dir);
    mkdirSync(state);
    writeFileSync(join(dir, ".cafe"), "name: supcoder\ndescription: answers questions\n");
    process.env.CAFE_CODEX_BIN = BIN.codex;
    process.env.FAKE_CODEX_STATE = state;
    const root = await startDaemon("root", { mode: "root", noSupervisor: false });
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    cleanup.push(root.stop);
    cleanup.push(() => {
      delete process.env.CAFE_CODEX_BIN;
      delete process.env.FAKE_CODEX_STATE;
    });
    const workers = root.daemon.supervisor!.start({ dir, agent: "codex" });
    expect(workers).toMatchObject([{ agent: "codex", slot: 1 }]);
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "supcoder" && r.status === "idle"), 15_000);
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "hello", to: "supcoder" });
    const events = await untilClosed(c, res.threadId, 10_000);
    expect(replyOf(events)).toBe("turn=1 kind=fresh q=hello");
    expect(JSON.parse(readFileSync(join(root.home, "baristas.json"), "utf8"))).toMatchObject([{ dir, agent: "codex" }]);
  }, 30_000);
});
