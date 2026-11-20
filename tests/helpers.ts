import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";
import type { AgentIdentity, ThreadEnvelope } from "@cafe/protocol";
import { runDaemon, type Running, type RunOptions } from "@cafe/daemon";

export const FAST = { ackTimeoutMs: 300, heartbeatIntervalMs: 200, broadcastDeadlineMs: 800, reconnectMinMs: 50, reconnectMaxMs: 200 };

export async function startDaemon(host: string, opts: Partial<RunOptions> & { config?: Record<string, unknown> } = {}): Promise<Running & { home: string; addr: string }> {
  const home = mkdtempSync(join(tmpdir(), `cafe-${host}-`));
  writeFileSync(join(home, "config.yml"), stringify({ host, token: "t0k", port: 0, advertise: "127.0.0.1", ...(opts.mode ? { mode: opts.mode } : {}), ...opts.config }));
  const r = await runDaemon({ home, timing: FAST, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "no-web"), ...opts });
  const addr = `127.0.0.1:${r.server.port}`;
  const stop = r.stop;
  let stopped: Promise<void> | undefined;
  return Object.assign(r, { home, addr, stop: () => (stopped ??= (async () => { await stop(); rmSync(home, { recursive: true, force: true }); })()) });
}

export function identity(name: string, extra: Partial<AgentIdentity> = {}): AgentIdentity {
  return { name, description: "", tags: [], scope: [], role: "barista", concurrency: 1, mode: "headless", cwd: "/tmp", ...extra };
}

/** A scripted Barista. `behave` decides what to do with each Order. */
export async function barista(
  addr: string,
  id: AgentIdentity,
  behave: (h: OrderHandle) => Promise<void> = async (h) => {
    await h.ack();
    await h.reply(`${id.name} says: ${h.order.body}`);
  },
) {
  const c = new CafeClient({ daemon: addr });
  // Keep the Order alive while `behave` runs: the daemon arms its 600 ms lease on ack
  // (FAST.heartbeatIntervalMs × HEARTBEAT_MISSES), so a slow scripted Barista would
  // otherwise be declared lost before it replies. Heartbeats before ack are ignored.
  c.onOrder((h) => {
    const stopBeat = keepAlive(h, FAST.heartbeatIntervalMs);
    void behave(h)
      .catch(() => {})
      .finally(stopBeat);
  });
  const rec = await c.connect(id);
  return { client: c, rec: rec! };
}

export async function customer(addr: string) {
  const c = new CafeClient({ daemon: addr });
  await c.connect();
  return c;
}

/** Collect thread events until `order.closed`. 12 s, not 5 s: under a full parallel
 * run the fake Codex/Claude processes can be slow to start and 5 s flaked. */
export function untilClosed(c: CafeClient, threadId: string, timeoutMs = 12_000): Promise<ThreadEnvelope[]> {
  return new Promise((resolve, reject) => {
    // Start from what the client already saw: a fast Barista can close the
    // Thread between `ask()` resolving and this listener being attached. For a
    // follow-up, only the latest turn counts.
    const all = c.recentEvents(threadId);
    const turnStart = all.map((e) => e.event.type).lastIndexOf("order.created");
    const events = turnStart >= 0 ? all.slice(turnStart) : all;
    const seen = new Set(events.map((e) => e.eventId));
    if (events.some((e) => e.event.type === "order.closed")) return resolve(events);
    const t = setTimeout(() => reject(new Error(`thread ${threadId} not closed; got ${events.map((e) => e.event.type).join(",")}`)), timeoutMs);
    const off = c.onThreadEvent((env) => {
      if (env.threadId !== threadId || seen.has(env.eventId)) return;
      seen.add(env.eventId);
      events.push(env);
      if (env.event.type === "order.closed") {
        clearTimeout(t);
        off();
        resolve(events);
      }
    });
  });
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
