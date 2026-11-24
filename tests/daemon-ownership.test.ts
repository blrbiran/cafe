// #88: `cafe daemon stop|restart` must only stop the daemon that belongs to this CAFE_HOME.
// A decoy HTTP server stands in for "some other daemon on the port"; no real daemon is
// started here, because /api/shutdown on an in-process daemon would SIGTERM the test worker.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { homeId } from "../packages/daemon/src/config.ts";

const BIN = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "cafe-own-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

type Decoy = { port: number; hits: string[] };
async function decoy(health: Record<string, unknown>): Promise<Decoy> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/health" ? { ok: true, isRoot: true, pid: 4242, version: "0.0.0", ...health } : { ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { port: (server.address() as any).port, hits };
}

function cafe(home: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, CAFE_HOME: home, CAFE_DAEMON: "", CAFE_TOKEN: "" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => done({ status, stdout, stderr }));
  });
}

function initHome(port: number, host = "mine"): string {
  const home = scratch();
  writeFileSync(join(home, "config.yml"), stringify({ host, port, token: "t", security: { mode: "plaintext" } }));
  return home;
}

describe("daemon stop/restart only touch this CAFE_HOME's daemon (#88)", () => {
  it("refuses to stop a daemon that reports another CAFE_HOME", async () => {
    const d = await decoy({ host: "mine", homeId: "0000000000000000" });
    const home = initHome(d.port);
    const r = await cafe(home, "daemon", "stop");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/another CAFE_HOME/);
    expect(d.hits).not.toContain("POST /api/shutdown");
  });

  it("refuses to restart a daemon that reports another CAFE_HOME", async () => {
    const d = await decoy({ host: "mine", homeId: "0000000000000000" });
    const home = initHome(d.port);
    const r = await cafe(home, "daemon", "restart");
    expect(r.status).toBe(1);
    expect(d.hits).not.toContain("POST /api/shutdown");
  });

  it("stops the daemon whose homeId matches this CAFE_HOME", async () => {
    const home = scratch();
    const d = await decoy({ host: "mine", homeId: homeId(home) });
    writeFileSync(join(home, "config.yml"), stringify({ host: "mine", port: d.port, token: "t", security: { mode: "plaintext" } }));
    const r = await cafe(home, "daemon", "stop");
    expect(r.status).toBe(0);
    expect(d.hits).toContain("POST /api/shutdown");
  });

  it("falls back to the host name for an older daemon without homeId", async () => {
    const other = await decoy({ host: "someone-else" });
    const r1 = await cafe(initHome(other.port), "daemon", "stop");
    expect(r1.status).toBe(1);
    expect(other.hits).not.toContain("POST /api/shutdown");

    const same = await decoy({ host: "mine" });
    const r2 = await cafe(initHome(same.port), "daemon", "stop");
    expect(r2.status).toBe(0);
    expect(same.hits).toContain("POST /api/shutdown");
  });

  it("refuses on an uninitialized CAFE_HOME without creating config.yml", async () => {
    const home = scratch();
    const r = await cafe(home, "daemon", "stop");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not initialized/);
    expect(existsSync(join(home, "config.yml"))).toBe(false);
  });

  it("start does not claim another CAFE_HOME's daemon as its own", async () => {
    const d = await decoy({ host: "mine", homeId: "0000000000000000" });
    const home = initHome(d.port);
    const r = await cafe(home, "daemon", "start");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/another CAFE_HOME/);
  });

  it("a read-only command does not create config.yml", async () => {
    const home = scratch();
    const r = await cafe(home, "config", "get", "port");
    expect(r.status).toBe(0);
    expect(existsSync(join(home, "config.yml"))).toBe(false);
  });
});
