import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CafeClient } from "@cafe/protocol/client";
import { managedAgentResumeStore } from "@cafe/protocol/cafe-file";
import { FAST, customer, startDaemon, untilClosed, waitFor } from "./helpers.ts";

it("resumes the exact queued assignment after the recipient process exits before receipt confirmation", async () => {
  const d = await startDaemon("receipt-process", { mode: "root", timing: { ...FAST, ackTimeoutMs: 8000 } });
  const file = join(d.home, "agent-identities", "worker.json");
  const env = { ...process.env, CAFE_HOME: d.home, CAFE_DAEMON: d.addr, CAFE_DISCOVERY: "0" };
  const processes: Array<{ child: ReturnType<typeof fork>; exited: Promise<unknown>; messages: Array<{ kind: string; agentId?: string; orderId?: string; message?: string }> }> = [];
  const launch = (phase: string) => {
    const child = fork(join(import.meta.dirname, "fixtures", "receipt-agent.mjs"), [d.addr, file, phase], { env, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const messages: typeof processes[number]["messages"] = [];
    child.on("message", (message) => messages.push(message as typeof messages[number]));
    const state = { child, messages, exited: once(child, "exit") };
    processes.push(state);
    return state;
  };
  const ready = async (state: ReturnType<typeof launch>) => {
    await waitFor(() => state.messages.some(({ kind }) => kind === "ready" || kind === "error"), 5000);
    expect(state.messages.find(({ kind }) => kind === "error")).toBeUndefined();
    return state.messages.find(({ kind }) => kind === "ready")!.agentId;
  };
  let c: CafeClient | undefined;
  try {
    const first = launch("initial");
    const agentId = await ready(first);
    c = await customer(d.addr);
    const target = d.daemon as unknown as { acceptRecipientAssignment: (...args: unknown[]) => Promise<{ active: boolean }> };
    const accept = target.acceptRecipientAssignment.bind(target);
    vi.spyOn(target, "acceptRecipientAssignment").mockImplementationOnce(async (...args) => {
      const result = await accept(...args);
      expect(result.active).toBe(true);
      first.child.disconnect();
      await first.exited;
      throw new Error("simulated lost receipt response");
    });
    const order = await c.ask({ body: "run the assigned fixture", to: "worker" });
    await first.exited;
    await waitFor(() => (d.daemon.registry.get(agentId!)?.status ?? "offline") === "offline");
    expect(first.messages.filter(({ kind }) => kind === "execution")).toEqual([]);
    expect(managedAgentResumeStore(file)?.queue?.list()).toHaveLength(1);
    const resumed = launch("resume");
    expect(await ready(resumed)).toBe(agentId);
    const events = await untilClosed(c, order.threadId, order.orderId);
    expect(events.filter(({ event }) => event.type === "order.delivered")).toHaveLength(1);
    expect(events.filter(({ event }) => event.type === "order.replied").map(({ event }) => event)).toEqual([
      expect.objectContaining({ text: "finished after receipt recovery", final: true }),
    ]);
    await waitFor(() => resumed.messages.some(({ kind }) => kind === "execution"));
    expect(resumed.messages.filter(({ kind }) => kind === "execution")).toEqual([{ kind: "execution", orderId: order.orderId }]);
  } finally {
    vi.restoreAllMocks();
    c?.close();
    for (const { child, exited } of processes) {
      if (child.connected) child.disconnect();
      await exited;
    }
    await d.stop();
  }
}, 20_000);
