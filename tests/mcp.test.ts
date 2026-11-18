import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { keepAlive } from "@cafe/protocol/client";
import { runMcp } from "../packages/cli/src/mcp.ts";
import { barista, identity, startDaemon } from "./helpers.ts";

const CAFE = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "bin", "cafe.js");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** An MCP client over in-memory streams talking to runMcp. */
function mcpClient(base: string, maxWaitS?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcp({ base, token: "t0k", version: "test", input, output, maxWaitS });
  cleanup.push(async () => {
    input.end();
    await done;
  });
  const pending = new Map<number, (m: any) => void>();
  createInterface({ input: output }).on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await request("tools/call", { name, arguments: args });
    return { text: r.result.content[0].text as string, isError: !!r.result.isError };
  };
  return { request, call, notify: (method: string) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`) };
}

async function network() {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  const echo = await barista(root.addr, identity("echo", { description: "echoes questions" }));
  cleanup.push(() => echo.client.close());
  const slow = await barista(root.addr, identity("slow", { description: "takes its time" }), async (h) => {
    await h.ack();
    const stop = keepAlive(h, 50);
    await new Promise((r) => setTimeout(r, 1200));
    stop();
    await h.reply(`slow answer to ${h.order.body}`);
  });
  cleanup.push(() => slow.client.close());
  return { root, base: `http://${root.addr}` };
}

describe("cafe mcp", () => {
  it("handshakes, lists tools, and the customer is named after the MCP client", async () => {
    const { base, root } = await network();
    const m = mcpClient(base);
    const init = await m.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" }, capabilities: {} });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "cafe" }, capabilities: { tools: {} } });
    m.notify("notifications/initialized");
    const tools = await m.request("tools/list");
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(["cafe_agents", "cafe_ask", "cafe_wait", "cafe_cancel"]);
    expect((await m.request("ping")).result).toEqual({});
    expect((await m.request("nope/nope")).error.code).toBe(-32601);

    const agents = await m.call("cafe_agents");
    expect(agents.text).toContain("echo#1@root (idle): echoes questions");

    const ask = await m.call("cafe_ask", { question: "ping", to: "echo" });
    expect(ask.isError).toBe(false);
    expect(ask.text).toContain("status: done");
    expect(ask.text).toContain("## echo#1@root\necho says: ping");
    const threadId = /threadId: (\S+)/.exec(ask.text)![1]!;
    expect(root.daemon.thread(threadId)?.meta.from.address).toBe("claude-code@root");

    const follow = await m.call("cafe_ask", { question: "again", threadId });
    expect(follow.text).toContain("echo says: again");
  });

  it("returns early with the threadId when the answer is slow; cafe_wait picks it up", async () => {
    const { base } = await network();
    const m = mcpClient(base);
    await m.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "codex", version: "1" }, capabilities: {} });
    const ask = await m.call("cafe_ask", { question: "think", to: "slow", wait_seconds: 0.2 });
    expect(ask.text).toContain("status: still working");
    expect(ask.text).toContain("Call cafe_wait");
    const threadId = /threadId: (\S+)/.exec(ask.text)![1]!;
    const wait = await m.call("cafe_wait", { threadId });
    expect(wait.text).toContain("status: done");
    expect(wait.text).toContain("slow answer to think");
  });

  it("reports declines and unknown agents as tool errors, and caps wait_seconds", async () => {
    const { base } = await network();
    const m = mcpClient(base, 1);
    await m.request("initialize", { clientInfo: { name: "x" } });
    const none = await m.call("cafe_ask", { question: "hello", to: "nobody-here" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/status: failed/);
    const missing = await m.call("cafe_ask", {});
    expect(missing).toEqual({ text: "question is required", isError: true });
    const started = Date.now();
    const capped = await m.call("cafe_ask", { question: "think", to: "slow", wait_seconds: 50 });
    expect(Date.now() - started).toBeLessThan(1150);
    expect(capped.text).toContain("still working");
    const threadId = /threadId: (\S+)/.exec(capped.text)![1]!;
    expect((await m.call("cafe_cancel", { threadId })).text).toBe(`cancelled ${threadId}`);
  });

  it("`cafe mcp` speaks MCP on stdio; `cafe mcp install --dry-run` prints the registration commands", async () => {
    const { root } = await network();
    const child = spawn(process.execPath, [CAFE, "mcp"], { env: { ...process.env, CAFE_DAEMON: root.addr, CAFE_TOKEN: "t0k" }, stdio: ["pipe", "pipe", "inherit"] });
    cleanup.push(() => void child.kill());
    const lines = createInterface({ input: child.stdout! });
    const next = () => new Promise<any>((r) => lines.once("line", (l) => r(JSON.parse(l))));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t" } } })}\n`);
    expect((await next()).result.serverInfo.name).toBe("cafe");
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cafe_ask", arguments: { question: "hi", to: "echo" } } })}\n`);
    expect((await next()).result.content[0].text).toContain("echo says: hi");

    const install = spawn(process.execPath, [CAFE, "--json", "mcp", "install", "--dry-run"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    install.stdout!.on("data", (d) => (out += d));
    await new Promise((r) => install.on("close", r));
    const res = JSON.parse(out);
    expect(res.map((r: { client: string }) => r.client)).toEqual(["claude", "codex"]);
    expect(res[0].command).toMatch(/^claude mcp add --scope user cafe -- \S+ \S+cafe\.js mcp$/);
    expect(res[1].command).toMatch(/^codex mcp add cafe -- /);
  });
});
