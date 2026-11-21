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
    writeFileSync(join(home, "config.yml"), `port: 0\nroot: 127.0.0.1:${port}\ntoken: t0k\n`);
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
