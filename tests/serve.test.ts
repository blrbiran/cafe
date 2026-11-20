import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRESETS, presetCommand, serve } from "@cafe/cli/serve";
import { customer, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function barDir(cafe: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cafe-serve-"));
  writeFileSync(join(dir, ".cafe"), cafe);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(exec: string, cafe = "name: echo\ndescription: echoes questions\ntags: [echo]\n") {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  const s = await serve({ exec, dir: barDir(cafe), daemon: root.addr, log: () => {} });
  cleanup.push(s.stop);
  const c = await customer(root.addr);
  cleanup.push(() => c.close());
  return { root, s, c };
}

describe("cafe serve --exec", () => {
  it("replies with the command's stdout; the prompt arrives on stdin", async () => {
    const { c, root } = await setup(`node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('GOT:'+s.split('Question:')[1].trim().split('\\\\n')[0]))"`);
    expect(root.daemon.registry.all().find((r) => r.name === "echo")).toMatchObject({ mode: "cli", agent: "command", command: expect.stringMatching(/^node -e /) });
    const res = await c.ask({ body: "echo ping", to: "echo" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "GOT:echo ping" });
  });

  it("CAFE_DECLINE: on stdout becomes a decline; non-zero exit declines with the error", async () => {
    const { c } = await setup(`echo "CAFE_DECLINE: not about echoes"`);
    const res = await c.ask({ body: "x", to: "echo" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.declined")?.event).toMatchObject({ reason: "not about echoes" });

    const bad = await setup(`echo boom >&2; exit 3`);
    const r2 = await bad.c.ask({ body: "x", to: "echo" });
    const ev2 = await untilClosed(bad.c, r2.threadId, r2.orderId);
    expect(ev2.find((e) => e.event.type === "order.declined")?.event).toMatchObject({ reason: expect.stringContaining("exit 3") });
  });

  it("cancelling the thread kills the running command", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "cafe-mark-")), "done");
    const { c, root } = await setup(`sleep 3; touch ${marker}; echo late`);
    const res = await c.ask({ body: "slow", to: "echo" });
    await waitFor(() => root.daemon.thread(res.threadId)?.meta.status === "working");
    await c.cancel(res.threadId);
    await new Promise((r) => setTimeout(r, 3500));
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
    expect(root.daemon.thread(res.threadId)?.meta.status).toBe("cancelled");
  });

  it("passes follow-up history and supports {prompt_file}", async () => {
    const { c } = await setup(`grep -c "This is a follow-up" {prompt_file} || echo first`);
    const first = await c.ask({ body: "one", to: "echo" });
    await untilClosed(c, first.threadId, first.orderId);
    const second = await c.ask({ body: "two", threadId: first.threadId });
    const events = await untilClosed(c, first.threadId, second.orderId);
    expect(events.filter((e) => e.event.type === "order.replied" && e.orderId === second.orderId).at(-1)?.event).toMatchObject({ text: "1" });
  });

  it("pins read-only preset defaults and widens them only with --write (#40)", () => {
    expect(presetCommand("codex")).toContain("-s read-only");
    expect(presetCommand("codex", true)).toContain("-s workspace-write");
    expect(presetCommand("claude")).toContain("--permission-mode dontAsk");
    expect(presetCommand("claude")).not.toContain("Edit");
    expect(presetCommand("claude", true)).toContain("Edit");
    expect(presetCommand("nope")).toBeUndefined();
    // The exported table is the read-only default.
    expect(PRESETS.codex).toContain("read-only");
  });
});
