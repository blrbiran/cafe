import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { CafeClient, keepAlive, type OrderHandle } from "@cafe/protocol/client";
import type { AgentIdentity, ThreadEnvelope } from "@cafe/protocol";
import { runDaemon, type Running, type RunOptions } from "@cafe/daemon";

export const FAST = { ackTimeoutMs: 300, heartbeatIntervalMs: 200, broadcastDeadlineMs: 800, reconnectMinMs: 50, reconnectMaxMs: 200 };

export async function startDaemon(host: string, opts: Partial<RunOptions> & { config?: Record<string, unknown> } = {}): Promise<Running & { home: string; addr: string }> {
  // A caller may supply its own home (e.g. a TLS test that pre-seeds certs); otherwise a scratch
  // home is created, which the returned stop() removes.
  const supplied = opts.home;
  const home = supplied ?? mkdtempSync(join(tmpdir(), `cafe-${host}-`));
  // Tests default to plaintext transport (the production default is TLS): a fixed TLS port would
  // collide across dozens of parallel test daemons. The TLS suites opt in with an explicit
  // `security` block.
  const config = { security: { mode: "plaintext" }, ...opts.config };
  writeFileSync(join(home, "config.yml"), stringify({ host, token: "t0k", port: 0, advertise: "127.0.0.1", ...(opts.mode ? { mode: opts.mode } : {}), ...config }));
  const r = await runDaemon({ home, timing: FAST, log: () => {}, noLock: true, noSupervisor: true, webDist: join(home, "no-web"), ...opts });
  const addr = `127.0.0.1:${r.server.port}`;
  const stop = r.stop;
  let stopped: Promise<void> | undefined;
  return Object.assign(r, {
    home,
    addr,
    // Only a scratch home this helper created is removed here; a caller-supplied home is theirs.
    stop: () => (stopped ??= (async () => {
      await stop();
      if (!supplied) rmSync(home, { recursive: true, force: true });
    })()),
  });
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
 * run the fake Codex/Claude processes can be slow to start and 5 s flaked.
 *
 * Pass `orderId` for a follow-up: the `ask()` response can beat the WebSocket
 * broadcast of the new `order.created`, and without the id the helper would
 * treat the previous turn's close as this turn's end (#6). */
export function untilClosed(
  c: CafeClient,
  threadId: string,
  orderIdOrTimeout?: string | number,
  timeoutMs = 12_000,
): Promise<ThreadEnvelope[]> {
  const orderId = typeof orderIdOrTimeout === "string" ? orderIdOrTimeout : undefined;
  if (typeof orderIdOrTimeout === "number") timeoutMs = orderIdOrTimeout;
  return new Promise((resolve, reject) => {
    // Start from what the client already saw: a fast Barista can close the
    // Thread between `ask()` resolving and this listener being attached.
    const all = c.recentEvents(threadId);
    const turnStart = orderId
      ? all.findIndex((e) => e.event.type === "order.created" && e.orderId === orderId)
      : all.map((e) => e.event.type).lastIndexOf("order.created");
    // With an orderId that has not arrived yet, collect nothing from older turns.
    const events = turnStart >= 0 ? all.slice(turnStart) : [];
    const done = (env: ThreadEnvelope) => env.event.type === "order.closed" && (!orderId || env.orderId === orderId);
    const seen = new Set(events.map((e) => e.eventId));
    if (events.some(done)) return resolve(events);
    const t = setTimeout(() => reject(new Error(`thread ${threadId} not closed; got ${events.map((e) => e.event.type).join(",")}`)), timeoutMs);
    const off = c.onThreadEvent((env) => {
      if (env.threadId !== threadId || seen.has(env.eventId)) return;
      seen.add(env.eventId);
      events.push(env);
      if (done(env)) {
        clearTimeout(t);
        off();
        resolve(events);
      }
    });
  });
}

/** Poll until true. A predicate that throws (a file the writer has not created yet) counts as "not yet". */
export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out${last ? ` (last error: ${(last as Error).message ?? String(last)})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
