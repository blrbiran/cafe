import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function doctor(cwd: string, home: string, addr: string, userHome: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "doctor", ...args], {
      cwd,
      env: { ...process.env, HOME: userHome, CAFE_HOME: home, CAFE_DAEMON: addr, CAFE_TOKEN: "t0k" },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("cafe doctor", () => {
  it("passes the checks it can verify and points at the next command", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const cwd = join(tmp, "work");
    const home = join(tmp, "cafe-home");
    const userHome = join(tmp, "user-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(userHome, { recursive: true });    writeFileSync(join(cwd, ".cafe"), "name: widgets\ndescription: answers widget questions\n");

    const r = await doctor(cwd, home, root.addr, userHome);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("daemon");
    expect(r.stdout).toContain("identity");
    expect(r.stdout).toContain("cafe extension install");
    expect(r.stdout).toContain("all checks passed");
  });

  it("tells a directory without .cafe to run cafe init", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const cwd = join(tmp, "work");
    const userHome = join(tmp, "user-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(userHome, { recursive: true });

    const r = await doctor(cwd, join(tmp, "cafe-home"), root.addr, userHome);
    expect(r.stdout).toContain("cafe init");
  });

  it("fails when the daemon cannot be reached", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const r = await doctor(tmp, join(tmp, "cafe-home"), "127.0.0.1:9", join(tmp, "user-home"));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/daemon[\s\S]*fail/);
  });

  it("uses the saved config token when CAFE_TOKEN is unset (#52)", async () => {
    const local = await startDaemon("child");
    cleanup.push(local.stop);
    // A fake Root that only answers with the saved token; the real root check would 401 without it.
    const fake = createServer((req, res) => {
      if (req.headers.authorization === "Bearer t0k") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: "root", isRoot: true, version: "0.1.3" }));
      } else {
        res.writeHead(401, { "content-type": "application/json" }).end("{}");
      }
    });
    await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", () => ok()));
    cleanup.push(() => new Promise<void>((ok) => fake.close(() => ok())));
    const port = (fake.address() as { port: number }).port;
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const home = join(tmp, "cafe-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yml"), `port: 0\nroot: 127.0.0.1:${port}\ntoken: t0k\nsecurity:\n  mode: plaintext\n`);
    const userHome = join(tmp, "user-home");
    mkdirSync(userHome, { recursive: true });

    const r = await new Promise<{ status: number | null; stdout: string }>((done) => {
      const p = spawn(process.execPath, [BIN, "doctor"], {
        cwd: tmp,
        env: { ...process.env, HOME: userHome, CAFE_HOME: home, CAFE_DAEMON: local.addr },
      });
      let stdout = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.on("close", (status) => done({ status, stdout }));
    });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/ok\s+root\s+127\.0\.0\.1/);
  });

  it("reports a /cafe command file it does not own", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const cwd = join(tmp, "work");
    const home = join(tmp, "cafe-home");
    const userHome = join(tmp, "user-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(userHome, ".claude/commands"), { recursive: true });
    writeFileSync(join(cwd, ".cafe"), "name: widgets\ndescription: answers widget questions\n");
    const own = join(userHome, ".claude/commands/cafe.md");
    writeFileSync(own, "my command");

    const r = await doctor(cwd, home, root.addr, userHome);
    expect(r.stdout).toContain("/cafe");
    expect(r.stdout).toContain("not managed by cafe");
    expect(r.stdout).toContain("cafe commands install --agent claude --force");
    expect(readFileSync(own, "utf8")).toBe("my command");
  });
});

// #81A: `cafe doctor` said nothing about TLS, so "connected, but in plaintext" could not be seen.
describe("cafe doctor reports TLS (#81A)", () => {
  function dirs() {
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-tls-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const cwd = join(tmp, "work");
    const userHome = join(tmp, "user-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(userHome, { recursive: true });
    return { tmp, cwd, userHome };
  }

  it("shows the TLS port and leaf lifetime of a TLS daemon", async () => {
    const root = await startDaemon("root", { mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const { tmp, cwd, userHome } = dirs();
    const r = await doctor(cwd, join(tmp, "cafe-home"), root.addr, userHome);
    expect(r.stdout).toMatch(new RegExp(`tls\\s+on :${root.server.tlsPort}`));
    expect(r.stdout).toMatch(/leaf valid \d+ more days/);
  });

  it("says TLS is off instead of staying silent", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const { tmp, cwd, userHome } = dirs();
    const r = await doctor(cwd, join(tmp, "cafe-home"), root.addr, userHome);
    expect(r.stdout).toMatch(/tls\s+TLS is off/);
  });
});

describe("cafe daemon status shows TLS (#81A)", () => {
  it("prints the TLS port and whether daemon links use wss", async () => {
    const root = await startDaemon("root", { mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const tmp = mkdtempSync(join(tmpdir(), "cafe-status-tls-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const r = await new Promise<{ stdout: string }>((done) => {
      const p = spawn(process.execPath, [BIN, "daemon", "status"], { env: { ...process.env, CAFE_HOME: tmp, CAFE_DAEMON: root.addr, CAFE_TOKEN: "t0k" } });
      let stdout = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.on("close", () => done({ stdout }));
    });
    expect(r.stdout).toMatch(new RegExp(`tls:\\s+on :${root.server.tlsPort} \\(daemon links use wss\\)`));
  });
});

// TLS invariant: the CLI never talks to the Root in plaintext. With TLS on, `cafe doctor` reports the
// hub as the local daemon sees it (it holds the wss uplink) instead of dialling http://<root> with the token.
describe("cafe doctor on a TLS machine", () => {
  async function fakeRoot() {
    const hits: string[] = [];
    const fake = createServer((req, res) => {
      hits.push(`${req.url} ${req.headers.authorization ?? ""}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: "root", isRoot: true }));
    });
    await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", () => ok()));
    cleanup.push(() => new Promise<void>((ok) => fake.close(() => ok())));
    return { hits, port: (fake.address() as { port: number }).port };
  }
  function tlsHome(rootPort: number) {
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-tls-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const home = join(tmp, "cafe-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yml"), `port: 0\nroot: 127.0.0.1:${rootPort}\ntoken: t0k\nsecurity:\n  mode: tls\n`);
    const userHome = join(tmp, "user-home");
    mkdirSync(userHome, { recursive: true });
    return { tmp, home, userHome };
  }

  it("reports the hub from the daemon's view and never sends the token to the Root in plaintext", async () => {
    const local = await startDaemon("child");
    cleanup.push(local.stop);
    const root = await fakeRoot();
    const { tmp, home, userHome } = tlsHome(root.port);
    const r = await doctor(tmp, home, local.addr, userHome);
    expect(root.hits).toEqual([]);
    expect(r.stdout).toMatch(/root\s+hub offline/);
  });

  it("says it cannot check the hub while the daemon is down, still without dialling it", async () => {
    const root = await fakeRoot();
    const { tmp, home, userHome } = tlsHome(root.port);
    const r = await doctor(tmp, home, "127.0.0.1:1", userHome);
    expect(root.hits).toEqual([]);
    expect(r.stdout).toMatch(/root\s+.*daemon is not running/);
  });

  it("shows the plaintext links a TLS hub refused (#89)", async () => {
    const root = await startDaemon("root", { mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const child = await startDaemon("oldbox", { config: { root: root.addr } });
    cleanup.push(child.stop);
    const until = Date.now() + 10_000;
    while (!root.daemon.tlsStatus().refused && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const tmp = mkdtempSync(join(tmpdir(), "cafe-doc-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const userHome = join(tmp, "user-home");
    mkdirSync(userHome, { recursive: true });
    const r = await doctor(tmp, join(tmp, "cafe-home"), root.addr, userHome);
    expect(r.stdout).toMatch(/fail\s+tls-links\s+refused plaintext links from oldbox/);
    expect(r.status).toBe(1);
  });
});
