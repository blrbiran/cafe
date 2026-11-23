import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockConnector } from "../packages/connector/src/mock.ts";
import { barista, identity, startDaemon, waitFor } from "./helpers.ts";

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function daemonWithBarista(orders: Array<{ body: string; threadId: string; turn: number; origin?: string; via?: { address: string } }>) {
  const d = await startDaemon("connector");
  cleanups.push(() => d.stop());
  const b = await barista(d.addr, identity("replier", { description: "answers questions" }), async (h) => {
    orders.push({ body: h.order.body, threadId: h.order.threadId, turn: h.order.turn, origin: h.order.origin, via: h.order.via });
    await h.ack();
    await h.reply(`re: ${h.order.body}`);
  });
  cleanups.push(() => b.client.close());
  return d;
}

function mockConfig(d: Awaited<ReturnType<typeof startDaemon>>, stateDir: string, config: Record<string, unknown>) {
  const configPath = join(stateDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return {
    CAFE_DAEMON: d.addr,
    CAFE_TOKEN: "t0k",
    CAFE_CONNECTOR_NAME: "mock",
    CAFE_CONNECTOR_STATE: stateDir,
    CAFE_CONNECTOR_CONFIG: configPath,
  };
}

type Event = { channel: string; user: string; eventId: string; text: string };
type Line = Record<string, any>;

async function runMock(env: Record<string, string>, events: Event[], heartbeatMs = 0): Promise<Line[]> {
  const output: Line[] = [];
  async function* input() {
    for (const e of events) yield `${JSON.stringify(e)}\n`;
  }
  const main = createMockConnector({ env, input: input(), output: (m) => output.push(m as Line), heartbeatMs });
  await main.run();
  return output;
}

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolveP(port));
    });
  });
}

describe("mock connector SDK", () => {
  it("turns a platform event into an Order and sends the final reply back to the channel", async () => {
    const orders: Parameters<typeof daemonWithBarista>[0] = [];
    const d = await daemonWithBarista(orders);
    const stateDir = tempDir("cafe-connector-state-");
    const env = mockConfig(d, stateDir, { allowChannels: ["c1"], allowUsers: ["u1"] });

    const out = await runMock(env, [{ channel: "c1", user: "u1", eventId: "e1", text: "hello" }]);
    const reply = out.find((m) => m.type === "reply");

    expect(reply).toMatchObject({ channel: "c1", final: true });
    expect(reply!.text).toBe("re: hello");
    expect(reply!.threadId).toBeTruthy();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ body: "hello", origin: "agent" });
    expect(orders[0]!.via?.address).toMatch(/^mock@/);

    // The mapping is persisted for the next connector process.
    const threads = JSON.parse(readFileSync(join(stateDir, "threads.json"), "utf8"));
    expect(threads.c1).toBe(reply!.threadId);
  });

  it("executes a duplicate eventId only once", async () => {
    const orders: Parameters<typeof daemonWithBarista>[0] = [];
    const d = await daemonWithBarista(orders);
    const stateDir = tempDir("cafe-connector-dup-");
    const env = mockConfig(d, stateDir, { allowChannels: ["c1"], allowUsers: ["u1"] });
    const event = { channel: "c1", user: "u1", eventId: "same", text: "once" };

    const out = await runMock(env, [event, event]);

    expect(out.filter((m) => m.type === "reply")).toHaveLength(1);
    expect(orders).toHaveLength(1);
  });

  it("keeps follow-ups in the same Thread after the connector restarts", async () => {
    const orders: Parameters<typeof daemonWithBarista>[0] = [];
    const d = await daemonWithBarista(orders);
    const stateDir = tempDir("cafe-connector-restart-");
    const env = mockConfig(d, stateDir, { allowChannels: ["c1"], allowUsers: ["u1"] });

    const first = await runMock(env, [{ channel: "c1", user: "u1", eventId: "e1", text: "first" }]);
    const threadId = first.find((m) => m.type === "reply")!.threadId;
    const second = await runMock(env, [{ channel: "c1", user: "u1", eventId: "e2", text: "again" }]);
    const follow = second.find((m) => m.type === "reply")!;

    expect(follow.threadId).toBe(threadId);
    expect(orders).toHaveLength(2);
    expect(orders[1]).toMatchObject({ body: "again", threadId, turn: 2 });
  });

  it("refuses channels and users outside the allowlist", async () => {
    const orders: Parameters<typeof daemonWithBarista>[0] = [];
    const d = await daemonWithBarista(orders);
    const stateDir = tempDir("cafe-connector-allow-");
    const env = mockConfig(d, stateDir, { allowChannels: ["c1"], allowUsers: ["u1"] });

    const out = await runMock(env, [
      { channel: "other", user: "u1", eventId: "x1", text: "wrong channel" },
      { channel: "c1", user: "intruder", eventId: "x2", text: "wrong user" },
      { channel: "c1", user: "u1", eventId: "x3", text: "allowed" },
    ]);

    expect(orders.map((o) => o.body)).toEqual(["allowed"]);
    expect(out.filter((m) => m.type === "reply")).toHaveLength(1);
  });

  it("accepts events over local HTTP when ingestPort is configured", async () => {
    const orders: Parameters<typeof daemonWithBarista>[0] = [];
    const d = await daemonWithBarista(orders);
    const stateDir = tempDir("cafe-connector-ingest-");
    const port = await freePort();
    const env = mockConfig(d, stateDir, { allowChannels: ["c1"], allowUsers: ["u1"], ingestPort: port });
    const output: Line[] = [];
    async function* noStdin() {}
    const main = createMockConnector({ env, input: noStdin(), output: (m) => output.push(m as Line), heartbeatMs: 0 });
    const running = main.run();
    try {
      await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) })).ok;
        } catch {
          return false;
        }
      }, 3_000);

      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "c1", user: "u1", eventId: "http-1", text: "over http" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, eventId: "http-1" });

      const reply = output.find((m) => m.type === "reply");
      expect(reply).toMatchObject({ channel: "c1", text: "re: over http", final: true });
      expect(orders.map((o) => o.body)).toEqual(["over http"]);
    } finally {
      main.stop();
      await running;
    }
  });
});

describe("/api/orders idempotencyKey", () => {
  async function post(addr: string, body: Record<string, unknown>) {
    const res = await fetch(`http://${addr}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return JSON.parse(text) as { orderId: string; threadId: string };
  }

  it("returns the same Order for a repeated key and creates a new one for a new key", async () => {
    const orders: Parameters<typeof daemonWithBarista>[0] = [];
    const d = await daemonWithBarista(orders);

    const [a, b] = await Promise.all([
      post(d.addr, { body: "same question", idempotencyKey: "k1", as: "test" }),
      post(d.addr, { body: "same question", idempotencyKey: "k1", as: "test" }),
    ]);
    expect(a.orderId).toBe(b.orderId);
    expect(a.threadId).toBe(b.threadId);
    await waitFor(() => orders.length === 1);

    const c = await post(d.addr, { body: "same question", idempotencyKey: "k2", as: "test" });
    expect(c.threadId).not.toBe(a.threadId);
    await waitFor(() => orders.length === 2);
  });
});

describe("cafe connector CLI", () => {
  function cli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveP) => {
      const p = spawn(process.execPath, [BIN, ...args], {
        env: { ...process.env, CAFE_HOME: home, CAFE_DAEMON: "", CAFE_TOKEN: "", ...extraEnv },
      });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolveP({ status, stdout, stderr }));
    });
  }

  function fixtureConnector(name: string): string {
    const dir = tempDir(`cafe-conn-${name}-`);
    writeFileSync(
      join(dir, "cafe-connector.json"),
      JSON.stringify({
        name,
        kind: "customer-connector",
        version: "0.1.0",
        entry: "./index.ts",
        permissions: ["orders:write", "threads:read"],
        configSchema: { allowChannels: { type: "array", items: "string", default: [] } },
        health: { type: "stdio", heartbeatMs: 150 },
      }),
    );
    writeFileSync(
      join(dir, "index.ts"),
      [
        'process.stdout.write(JSON.stringify({ type: "hello", daemon: process.env.CAFE_DAEMON, name: process.env.CAFE_CONNECTOR_NAME, config: process.env.CAFE_CONNECTOR_CONFIG, state: process.env.CAFE_CONNECTOR_STATE }) + "\\n");',
        'const beat = () => process.stdout.write(JSON.stringify({ type: "heartbeat", at: Date.now(), ok: true }) + "\\n");',
        "beat();",
        "const timer = setInterval(beat, 150);",
        'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
      ].join("\n"),
    );
    return dir;
  }

  /** Heartbeats, but exits 1 the first time it runs (a marker file), then stays up: one crash, then healthy. */
  function crashedConnector(name: string): string {
    const dir = tempDir(`cafe-conn-crash-${name}-`);
    writeFileSync(
      join(dir, "cafe-connector.json"),
      JSON.stringify({ name, kind: "customer-connector", version: "0.1.0", entry: "./index.ts", permissions: ["orders:write"], health: { type: "stdio", heartbeatMs: 150 } }),
    );
    writeFileSync(
      join(dir, "index.ts"),
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const dir = process.env.CAFE_CONNECTOR_STATE;',
        'const marker = join(dir, "crashed-once");',
        'process.stdout.write(JSON.stringify({ type: "hello", crashedBefore: existsSync(marker) }) + "\\n");',
        "if (!existsSync(marker)) { writeFileSync(marker, \"1\"); process.stderr.write(\"first run fails on purpose\\n\"); process.exit(1); }",
        'const beat = () => process.stdout.write(JSON.stringify({ type: "heartbeat", at: Date.now(), ok: true }) + "\\n");',
        "beat();",
        "const timer = setInterval(beat, 150);",
        'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
      ].join("\n"),
    );
    return dir;
  }

  /** Exits immediately, every time: the supervisor must give up after the crash-loop window. */
  function alwaysCrashConnector(name: string): string {
    const dir = tempDir(`cafe-conn-loop-${name}-`);
    writeFileSync(join(dir, "cafe-connector.json"), JSON.stringify({ name, kind: "customer-connector", version: "0.1.0", entry: "./index.ts", permissions: ["orders:write"] }));
    writeFileSync(join(dir, "index.ts"), 'process.stderr.write("boom\\n"); process.exit(3);\n');
    return dir;
  }

  it("installs, starts, reports status, tails logs and removes only cafe-owned connectors", async () => {
    const home = tempDir("cafe-connector-home-");
    const source = fixtureConnector("fixture");
    const installed = join(home, "connectors", "fixture");

    const install = await cli(home, ["connector", "install", source]);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain("installed");
    expect(existsSync(join(installed, "cafe-connector.json"))).toBe(true);
    expect(existsSync(join(home, "connector-data", "fixture", "config.json"))).toBe(true);

    const stopped = await cli(home, ["connector", "status", "fixture"]);
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("stopped");

    try {
      const start = await cli(home, ["connector", "start", "fixture"], { CAFE_DAEMON: "127.0.0.1:1", CAFE_TOKEN: "t0k" });
      expect(start.status, start.stderr).toBe(0);
      expect(start.stdout).toContain("running");

      // Wait for a real value, not the `heartbeat:` label: `cafe connector status` always prints that
// line (with `(none)` when there is no heartbeat yet), so matching the word passed instantly and the
// log read raced the connector's first write (#57).
      await waitFor(async () => {
        const s = await cli(home, ["connector", "status", "fixture"]);
        const line = /heartbeat:\s*(.+)/.exec(s.stdout)?.[1]?.trim();
        return s.stdout.includes("running") && !!line && line !== "(none)";
      }, 5_000);

      // Read the log only once the connector has actually written its heartbeat.
      await waitFor(async () => {
        const l = await cli(home, ["connector", "logs", "fixture"]);
        return l.stdout.includes('"type":"heartbeat"');
      }, 5_000);

      const logs = await cli(home, ["connector", "logs", "fixture"]);
      expect(logs.status, logs.stderr).toBe(0);
      expect(logs.stdout).toContain('"type":"heartbeat"');
      expect(logs.stdout).toContain('"name":"fixture"');
      expect(logs.stdout).toContain(join(home, "connector-data", "fixture", "config.json"));
      expect(logs.stdout).toContain(join(home, "connector-data", "fixture", "state"));

      const stop = await cli(home, ["connector", "stop", "fixture"]);
      expect(stop.status, stop.stderr).toBe(0);
      const after = await cli(home, ["connector", "status", "fixture"]);
      expect(after.stdout).toContain("stopped");
    } finally {
      await cli(home, ["connector", "stop", "fixture"]).catch(() => {});
    }

    const remove = await cli(home, ["connector", "remove", "fixture"]);
    expect(remove.status, remove.stderr).toBe(0);
    expect(existsSync(installed)).toBe(false);

    // A directory cafe did not install is refused unless --force is given.
    const foreign = join(home, "connectors", "foreign");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "note.txt"), "not ours");
    const refused = await cli(home, ["connector", "remove", "foreign"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toMatch(/--force/);
    expect(existsSync(foreign)).toBe(true);
    const forced = await cli(home, ["connector", "remove", "foreign", "--force"]);
    expect(forced.status, forced.stderr).toBe(0);
    expect(existsSync(foreign)).toBe(false);
  });

  it("restarts a crashed connector and reports it running again", async () => {
    const home = tempDir("cafe-connector-super-");
    const source = crashedConnector("crasher"); // exits once on the first run, then stays alive
    const install = await cli(home, ["connector", "install", source]);
    expect(install.status, install.stderr).toBe(0);
    try {
      const start = await cli(home, ["connector", "start", "crasher"], { CAFE_DAEMON: "127.0.0.1:1", CAFE_TOKEN: "t0k" });
      expect(start.status, start.stderr).toBe(0);
      // The supervisor restarts the child (first exit is unexpected) and it stays running.
      await waitFor(async () => {
        const s = await cli(home, ["connector", "status", "crasher"]);
        return s.stdout.includes("running") && Number(/restarts:\s+(\d+)/.exec(s.stdout)?.[1] ?? 0) >= 1;
      }, 8_000);
      const status = await cli(home, ["connector", "status", "crasher"]);
      expect(status.stdout).toContain("running");
      const logs = await cli(home, ["connector", "logs", "crasher"]);
      expect(logs.stdout).toContain('"type":"heartbeat"');
    } finally {
      const stop = await cli(home, ["connector", "stop", "crasher"]);
      expect(stop.status, stop.stderr).toBe(0);
    }
    const after = await cli(home, ["connector", "status", "crasher"]);
    expect(after.stdout).toContain("stopped");
  });

  it("gives up after a crash loop instead of restarting forever", async () => {
    const home = tempDir("cafe-connector-loop-");
    const source = alwaysCrashConnector("loop");
    const install = await cli(home, ["connector", "install", source]);
    expect(install.status, install.stderr).toBe(0);
    try {
      const start = await cli(home, ["connector", "start", "loop"], { CAFE_DAEMON: "127.0.0.1:1", CAFE_TOKEN: "t0k", CAFE_CONNECTOR_MAX_RESTARTS: "2", CAFE_CONNECTOR_BACKOFF_MS: "50", CAFE_CONNECTOR_WINDOW_MS: "60000" });
      await waitFor(async () => {
        const s = await cli(home, ["connector", "status", "loop"]);
        return s.stdout.includes("crash loop") || s.stdout.includes("crashed");
      }, 20_000);
      const status = await cli(home, ["connector", "status", "loop"]);
      expect(status.stdout).toMatch(/crashed|crash loop/);
      // The supervisor exited: its pid is gone from run.json.
      expect(status.stdout).toContain("pid:       -");
    } finally {
      await cli(home, ["connector", "stop", "loop"]).catch(() => {});
    }
  }, 30_000);
});