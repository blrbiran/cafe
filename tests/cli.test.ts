import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { formatApiError } from "../packages/cli/src/errors.ts";
import { startDaemon } from "./helpers.ts";

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const homes: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "cafe-cli-"));
  homes.push(d);
  return d;
}
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function cafe(h: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: "", CAFE_TOKEN: "" },
  });
}

/** Commands that look at the user's home (extension/skill/command installs). */
function cafeEnv(cafeHome: string, userHome: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: userHome, CAFE_HOME: cafeHome, CAFE_DAEMON: "", CAFE_TOKEN: "" },
  });
}

/** Async: a daemon in this process cannot answer while spawnSync blocks the event loop. */
function cafeAsync(h: string, addr: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: addr, CAFE_TOKEN: "t0k" },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("thread show skipped targets (#111)", () => {
  it.each([
    ["deadline", "did not respond before the deadline"],
    ["skipped: another Barista answered first", "was skipped: another Barista answered first"],
  ])("formats skipped reason %s without calling it a decline", async (reason, expected) => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/threads/t1") {
        return res.end(JSON.stringify({
          meta: {
            threadId: "t1", orderId: "o1", kind: "order", from: { address: "asker" }, targets: ["a1"],
            targetStates: [{ agentId: "a1", state: "skipped" }], status: "done", summary: "task",
            summaryTurn: 1, createdAt: 1, turns: 1, channel: "default",
          },
          events: [{
            eventId: "e1", threadId: "t1", orderId: "o1", host: "stub", at: 2,
            event: { type: "order.declined", agentId: "a1", reason, unavailable: true, skipped: true },
          }],
        }));
      }
      if (req.url === "/api/agents") return res.end("[]");
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found", message: "missing" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const addr = `127.0.0.1:${(server.address() as { port: number }).port}`;

    const r = await cafeAsync(home(), addr, "thread", "t1");

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(expected);
    expect(r.stdout).not.toContain("declined:");
  });
});

describe("daemon API errors", () => {
  it("does not repeat an error code already present in the message", () => {
    expect(formatApiError({ error: "EISDIR", message: "EISDIR: illegal operation on a directory, read" }, 500)).toBe("EISDIR: illegal operation on a directory, read");
  });

  it("keeps the code for a plain human message", () => {
    expect(formatApiError({ error: "no_barista", message: "no barista available" }, 503)).toBe("no_barista: no barista available");
    expect(formatApiError({}, 502)).toBe("502");
  });
});

describe("cafe wait cancellation is honest (#60)", () => {
  /** A daemon stub: health answers, the stream hangs once, the cancel call fails its way. */
  async function stubDaemon(cancelFails: boolean) {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/api/health")) return res.end(JSON.stringify({ ok: true, host: "stub", pid: 1, isRoot: true, version: "0.1.4" }));
      if (url.startsWith("/api/agents")) return res.end("[]");
      if (url === "/api/orders") return res.end(JSON.stringify({ threadId: "t1", orderId: "o1", decision: { mode: "unicast", reason: "stub" } }));
      if (url.endsWith("/cancel")) {
        res.writeHead(cancelFails ? 400 : 200, { "content-type": "application/json" });
        return res.end(JSON.stringify(cancelFails ? { error: "not_found", message: "no open question on thread" } : {}));
      }
      if (url.includes("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ eventId: "e1", threadId: "t1", orderId: "o1", host: "stub", at: 1, event: { type: "order.created", order: { orderId: "o1", threadId: "t1", turn: 1, from: { address: "cli" }, body: "hi", kind: "order" } } })}\n\n`);
        return; // never closes: the CLI's timeout has to end it
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const addr = `127.0.0.1:${(server.address() as { port: number }).port}`;
    return addr;
  }

  it("does not claim the question was cancelled when the cancel request failed", async () => {
    const addr = await stubDaemon(true);
    const r = await cafeAsync(home(), addr, "ask", "--timeout", "1", "hi");
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("cancelled");
    expect(r.stderr).toContain("could not cancel");
  });

  it("still reports a real cancellation", async () => {
    const addr = await stubDaemon(false);
    const r = await cafeAsync(home(), addr, "ask", "--timeout", "1", "hi");
    expect(r.stderr).toContain("cancelled");
    expect(r.stderr).not.toContain("could not cancel");
  });
});

describe("mixed-release preflights (v4-12)", () => {
  /** A pre-v4-11 Daemon: no feature list, no /api/teams. Records every request. */
  async function oldDaemon() {
    const http = await import("node:http");
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      const url = req.url ?? "/";
      res.setHeader("content-type", "application/json");
      if (url.startsWith("/api/health")) return res.end(JSON.stringify({ ok: true, host: "oldbox", version: "0.1.5", isRoot: true }));
      if (url.startsWith("/api/teams")) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "not_found", message: "no such endpoint" }));
      }
      if (url === "/api/orders") return res.end(JSON.stringify({ threadId: "t1", orderId: "o1", decision: { mode: "unicast", targets: ["a1"], reason: "the most available Barista" } }));
      if (url.startsWith("/api/agents")) return res.end("[]");
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    return { addr: `127.0.0.1:${(server.address() as { port: number }).port}`, calls };
  }

  it("refuses a channel on an old daemon before creating the order (v4-13 hard reject)", async () => {
    const { addr, calls } = await oldDaemon();
    const r = await cafeAsync(home(), addr, "ask", "--channel", "dev", "--async", "hello");
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("does not advertise channels");
    expect(calls).not.toContain("POST /api/orders");
  });

  it("refuses team stop before any barista write", async () => {
    const { addr, calls } = await oldDaemon();
    const r = await cafeAsync(home(), addr, "team", "stop");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("team commands are unavailable");
    expect(calls.some((c) => c.startsWith("DELETE /api/baristas"))).toBe(false);
  });
});

describe("cafe commands", () => {
  it("status lists the entry point for each host", () => {
    const r = cafeEnv(home(), home(), "commands", "status");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("pi");
    expect(r.stdout).toContain("omp");
    expect(r.stdout).toContain("claude");
    expect(r.stdout).toContain("$cafe");
  });

  it("installs a /cafe command for Claude without overwriting a user-owned one", () => {
    const h = home();
    const u = home();
    const cmd = join(u, ".claude/commands/cafe.md");
    mkdirSync(dirname(cmd), { recursive: true });
    writeFileSync(cmd, "my own /cafe");

    const refused = cafeEnv(h, u, "commands", "install", "--agent", "claude");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(cmd, "utf8")).toBe("my own /cafe");

    const forced = cafeEnv(h, u, "commands", "install", "--agent", "claude", "--force");
    expect(forced.status, forced.stderr).toBe(0);
    expect(readFileSync(cmd, "utf8")).toContain("Managed by cafe");

    const status = cafeEnv(h, u, "commands", "status");
    expect(status.stdout).toContain("installed");

    const removed = cafeEnv(h, u, "commands", "uninstall", "--agent", "claude");
    expect(removed.status, removed.stderr).toBe(0);
    expect(existsSync(cmd)).toBe(false);
  });

  it("replaces the legacy /cafe-ask file it wrote earlier", () => {
    const h = home();
    const u = home();
    const legacy = join(u, ".claude/commands/cafe-ask.md");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "<!-- Managed by cafe: /cafe-ask -->\nold body");
    const r = cafeEnv(h, u, "commands", "install", "--agent", "claude");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(u, ".claude/commands/cafe.md"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it("dry-run does not write the command file", () => {
    const h = home();
    const u = home();
    const r = cafeEnv(h, u, "commands", "install", "--agent", "claude", "--dry-run");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("cafe.md");
    expect(existsSync(join(u, ".claude/commands/cafe.md"))).toBe(false);
  });
});

describe("daemon status", () => {
  it("shows config.yml changes the running daemon has not applied", async () => {
    const d = await startDaemon("pc1");
    cleanup.push(d.stop);
    writeFileSync(join(d.home, "config.yml"), stringify({ host: "pc1", token: "t0k", port: 0, advertise: "127.0.0.1", mode: "root" }));
    const r = await cafeAsync(d.home, d.addr, "daemon", "status");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("pending:");
    expect(r.stdout).toContain("mode: daemon -> root (restart-required)");
    expect(r.stdout).toContain("cafe daemon restart");
  });
});

describe("config get", () => {
  it("prints (not set) for an unset known value", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "router.model");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("(not set)");
    expect(r.stdout).not.toContain("undefined");
  });

  it("prints null for an unset value with --json", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "router.model", "--json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBeNull();
  });

  it("fails for an unknown key", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "nope");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown config key 'nope'");
  });

  it("still prints a set value", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "get", "port");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("47821");
  });

  it("marks a config change that needs a restart", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "set", "mode", "root");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("restart required");
    expect(r.stdout).toContain("cafe daemon restart");
    expect(parse(readFileSync(join(h, "config.yml"), "utf8")).mode).toBe("root");
  });

  it("connect saves mode, root and token together", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "connect", "10.0.0.5:4777", "--token", "shared");
    expect(r.status).toBe(0);
    const saved = parse(readFileSync(join(h, "config.yml"), "utf8"));
    expect(saved).toMatchObject({ mode: "daemon", root: "10.0.0.5:4777", token: "shared" });
    expect(r.stdout).toContain("restart required");
  });

  // #76: a malformed address used to be written to config.yml first, and only the live API (when
  // a daemon was running) rejected it — so a stopped daemon was pointed at an address it could
  // never parse on the next start.
  it("root set refuses a malformed address without touching config.yml", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\nroot: 10.0.0.5:4777\n");
    const r = cafe(h, "root", "set", "1.2.3.4:4777:4777");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("host:port");
    expect(parse(readFileSync(join(h, "config.yml"), "utf8")).root).toBe("10.0.0.5:4777");
  });

  it("connect refuses a malformed Root address", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "connect", "http://10.0.0.5:4777/x", "--token", "shared");
    expect(r.status).toBe(1);
    expect(parse(readFileSync(join(h, "config.yml"), "utf8")).root).toBeUndefined();
  });

  it("config diff reports that there is no running daemon to compare with", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "diff");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("daemon is not running");
  });
  it("config apply fails when no daemon is running", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\n");
    const r = cafe(h, "config", "apply");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("daemon is not running");
  });
});

describe("cafe status", () => {
  it("summarizes the daemon, traffic and pending config in one screen", async () => {
    const d = await startDaemon("root", { mode: "root" });
    cleanup.push(d.stop);
    const r = await cafeAsync(home(), d.addr, "status");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("daemon:");
    expect(r.stdout).toContain("router:");
    expect(r.stdout).toContain("traffic:");
    expect(r.stdout).toContain("pending: none");
  });
});

describe("config get redaction", () => {
  it("redacts the token when printing the whole file", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\ntoken: super-secret\n");
    const r = cafe(h, "config", "get");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("super-secret");
    expect(r.stdout).toContain("redacted");
    const j = cafe(h, "config", "get", "--json");
    expect(JSON.parse(j.stdout).token).toContain("redacted");
  });

  it("still prints the token when asked for it explicitly, and with --reveal", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), "port: 47821\ntoken: super-secret\n");
    expect(cafe(h, "config", "get", "token").stdout.trim()).toBe("super-secret");
    expect(cafe(h, "config", "get", "--reveal").stdout).toContain("super-secret");
  });
});

describe("barista command aliases", () => {
  it("shows the ls alias in help", () => {
    const r = cafe(home(), "barista", "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("list|ls");
  });
});

describe("Node version precheck", () => {
  it("prints the requirement instead of ERR_UNKNOWN_FILE_EXTENSION on an old Node", () => {
    const url = pathToFileURL(resolve(import.meta.dirname, "../packages/cli/bin/node-check.mjs")).href;
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `Object.defineProperty(process.versions, "node", { value: "18.20.8" }); const m = await import(${JSON.stringify(url)}); m.checkNode();`],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cafe requires Node >= 22.19");
    expect(r.stderr).toContain("18.20.8");
    expect(r.stderr).not.toContain("ERR_UNKNOWN_FILE_EXTENSION");
  });
});


describe("connector command aliases (#59)", () => {
  it("accepts `cafe connector ls` like `list`", () => {
    const h = home();
    const r = cafe(h, "connector", "ls");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no connectors installed");
  });

  it("shows list|ls in every noun help that has a list subcommand", () => {
    // Keeps the convention from drifting again (#59): every `<noun> list` must accept `ls`.
    const h = home();
    for (const noun of ["barista", "connector"]) {
      const r = cafe(h, noun, "--help");
      expect(r.status, `${noun} --help: ${r.stderr}`).toBe(0);
      expect(r.stdout, `${noun} --help`).toContain("list|ls");
    }
  });
});

// #87: a misspelt top-level command had no suggestion (subcommands did), and --json printed
// plain text for both, so a script parsing --json output crashed on a typo.
describe("unknown commands suggest and honour --json (#87)", () => {
  it("suggests the nearest top-level command", () => {
    const r = cafe(home(), "agentz");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command 'agentz'");
    expect(r.stderr).toMatch(/did you mean: cafe agents/i);
  });

  it("keeps the subcommand suggestion", () => {
    const r = cafe(home(), "barista", "lsit");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Did you mean list\?/);
  });

  it("prints a JSON error for a top-level typo under --json", () => {
    const r = cafe(home(), "--json", "agentz");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ error: "unknown_command", message: "unknown command 'agentz'" });
    expect(j.suggestions[0]).toBe("agents");
  });

  it("prints a JSON error for a subcommand typo under --json", () => {
    const r = cafe(home(), "--json", "barista", "lsit");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "unknown_command", suggestions: ["list"] });
  });

  it("prints a JSON error when a command fails under --json", () => {
    const r = cafe(home(), "config", "get", "no.such.key", "--json");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "failed", message: expect.stringContaining("no.such.key") });
  });

  it("still fails a typo with --help (#7)", () => {
    const r = cafe(home(), "agentz", "--help");
    expect(r.status).toBe(1);
  });
});

// A daemon that cannot bind used to leave `cafe daemon start` waiting 5 s and then saying only "see
// daemon.log"; the reason (which port, which setting moves it) was in daemon.stdout.log.
describe("cafe daemon start reports why the daemon did not start", () => {
  it("prints the port-in-use reason without waiting for the full timeout", async () => {
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "0.0.0.0", r));
    cleanup.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const port = (blocker.address() as { port: number }).port;
    // A free main port (bind, read, release) and the TLS port taken: the second-daemon-on-one-machine case.
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const main = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const h = home();
    writeFileSync(join(h, "config.yml"), stringify({ host: "busy", token: "t0k", port: main, mode: "root", security: { mode: "tls", tls: { port } } }));
    const t0 = Date.now();
    const r = await new Promise<{ code: number | null; stderr: string }>((resolveP) => {
      const p = spawn(process.execPath, [BIN, "daemon", "start"], { env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: "", CAFE_TOKEN: "" } });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("exit", (code) => resolveP({ code, stderr }));
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`TLS port ${port} is already in use`);
    expect(r.stderr).toContain("cafe config set security.tls.port");
    expect(Date.now() - t0).toBeLessThan(4_500);
  }, 20_000);
});

// A daemon whose startup is slow (the LLM router can take tens of seconds to load) holds the lock but does
// not answer yet. `cafe daemon start` used to give up after 5 s ("did not start"), and a second try spawned
// another daemon that died with "already running". Wait for the one that is starting, and say so.
describe("cafe daemon start with a daemon still starting", () => {
  it("waits for the lock holder instead of spawning a second daemon, then names it", async () => {
    const { createServer } = await import("node:net");
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const port = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const h = home();
    writeFileSync(join(h, "config.yml"), stringify({ host: "slow", token: "t0k", port, mode: "root", security: { mode: "plaintext" } }));
    // Stand-in for a daemon that is still loading: alive, holds the lock, not listening.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    cleanup.push(() => void holder.kill());
    writeFileSync(join(h, "daemon.lock"), String(holder.pid));
    const r = await new Promise<{ code: number | null; stderr: string }>((resolveP) => {
      const p = spawn(process.execPath, [BIN, "daemon", "start"], { env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: "", CAFE_TOKEN: "", CAFE_DAEMON_START_WAIT_MS: "1500" } });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("exit", (code) => resolveP({ code, stderr }));
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`pid ${holder.pid}`);
    expect(r.stderr).toMatch(/still starting|not answering/);
    // No second daemon was spawned: nothing wrote "already running".
    expect(existsSync(join(h, "daemon.stdout.log")) ? readFileSync(join(h, "daemon.stdout.log"), "utf8") : "").not.toContain("already running");
  }, 20_000);
});

describe("cafe daemon start right after a stop", () => {
  it("starts a new daemon once the old lock holder exits", async () => {
    const { createServer } = await import("node:net");
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const port = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const h = home();
    writeFileSync(join(h, "config.yml"), stringify({ host: "restart", token: "t0k", port, mode: "root", security: { mode: "plaintext" } }));
    // Stand-in for a daemon that is shutting down: holds the lock for 3 s (longer than the CLI takes to boot), then exits.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"]);
    writeFileSync(join(h, "daemon.lock"), String(holder.pid));
    await new Promise<void>((r) => holder.once("spawn", () => r()));
    const r = await new Promise<{ code: number | null; stderr: string }>((resolveP) => {
      const p = spawn(process.execPath, [BIN, "daemon", "start"], { env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: "", CAFE_TOKEN: "" } });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("exit", (code) => resolveP({ code, stderr }));
    });
    cleanup.push(() => void spawnSync(process.execPath, [BIN, "daemon", "stop"], { env: { ...process.env, CAFE_HOME: h, CAFE_DAEMON: "", CAFE_TOKEN: "" } }));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
  }, 30_000);
});
