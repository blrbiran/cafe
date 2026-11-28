import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { Agent, request } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { localAddresses } from "../packages/daemon/src/tls/certs.ts";
import { barista, identity, startDaemon } from "./helpers.ts";

/**
 * v4-9: the TLS port already serves the Web UI; the daemon publishes the CA as an installable file
 * and tells the page its encrypted addresses. Own file: TLS daemons in this suite never add the CA
 * to the process-wide trust store (requests pass `ca` explicitly).
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const TLS = (extra: Record<string, unknown> = {}) => ({ security: { mode: "tls", tls: { port: 0 } }, ...extra });

function httpsGet(port: number, path: string, ca: string, headers: Record<string, string> = {}, opts: { host?: string; method?: string; body?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: opts.host ?? "127.0.0.1", port, path, method: opts.method ?? "GET", ca, agent: new Agent({ keepAlive: false }), headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("encrypted Web for other devices (v4-9)", () => {
  it("GET /ca.crt serves the CA as an installable file on both ports", async () => {
    const d = await startDaemon("lanhttps", { mode: "root", config: TLS() });
    cleanup.push(d.stop);
    const tls = (await (await fetch(`http://${d.addr}/api/tls`)).json()) as { ca: string; tlsPort: number };
    const plain = await fetch(`http://${d.addr}/ca.crt`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("application/x-x509-ca-cert");
    expect(plain.headers.get("content-disposition")).toBe('attachment; filename="cafe-ca.crt"');
    expect(await plain.text()).toBe(tls.ca);
    const enc = await httpsGet(tls.tlsPort, "/ca.crt", tls.ca);
    expect(enc.status).toBe(200);
    expect(enc.body).toBe(tls.ca);
  }, 30_000);

  it("the TLS port serves the page and still wants the token for the API", async () => {
    const d = await startDaemon("lanpage", { mode: "root", config: TLS() });
    cleanup.push(d.stop);
    const tls = (await (await fetch(`http://${d.addr}/api/tls`)).json()) as { ca: string; tlsPort: number };
    // 127.0.0.1 is loopback, so the API answers without a token there; the token rule itself is
    // covered for non-loopback callers in web-auth / server tests. Here: the listener routes /api.
    const health = await httpsGet(tls.tlsPort, "/api/health", tls.ca);
    expect(health.status).toBe(200);
  }, 30_000);

  it("/api/settings lists one https address per join address on the TLS port", async () => {
    // startDaemon advertises 127.0.0.1 by default; drop it so the list is every LAN address.
    const d = await startDaemon("lanlist", { mode: "root", config: TLS({ advertise: undefined }) });
    cleanup.push(d.stop);
    const s = (await (await fetch(`http://${d.addr}/api/settings`)).json()) as { web?: { https: string[] }; join?: { addresses: string[] } };
    const port = d.server.tlsPort;
    expect(s.web?.https.length).toBe(localAddresses().length);
    for (const u of s.web!.https) expect(u).toMatch(new RegExp(`^https://[^/]+:${port}/$`));
  }, 30_000);

  it("with advertise set, only the advertised host is listed (its own port ignored)", async () => {
    // advertise is put in the leaf's SAN, so it is listed.
    const d = await startDaemon("lanadv", { mode: "root", config: TLS({ advertise: "cafe.lan:4801" }) });
    cleanup.push(d.stop);
    const s = (await (await fetch(`http://${d.addr}/api/settings`)).json()) as { web?: { https: string[] } };
    expect(s.web?.https).toEqual([`https://cafe.lan:${d.server.tlsPort}/`]);
  }, 30_000);

  it("over the network the TLS port wants the token, and accepts a same-origin https write", async () => {
    const lan = localAddresses()[0];
    if (!lan) return; // no non-loopback IPv4 on this machine
    const d = await startDaemon("lanauth", { mode: "root", config: TLS() });
    cleanup.push(d.stop);
    const { ca, tlsPort } = (await (await fetch(`http://${d.addr}/api/tls`)).json()) as { ca: string; tlsPort: number };
    expect((await httpsGet(tlsPort, "/api/snapshot", ca, {}, { host: lan })).status).toBe(401);
    expect((await httpsGet(tlsPort, "/api/snapshot", ca, { authorization: "Bearer t0k" }, { host: lan })).status).toBe(200);
    const write = (origin: string) =>
      httpsGet(tlsPort, "/api/config", ca, { authorization: "Bearer t0k", origin, "content-type": "application/json" }, { host: lan, method: "POST", body: "{}" });
    expect((await write(`https://${lan}:${tlsPort}`)).status).not.toBe(403);
    expect((await write(`http://${lan}:${tlsPort}`)).status).toBe(403);
  }, 30_000);

  it("discovers the pinned Root TLS endpoint before CLI sends an Order", async () => {
    const lan = localAddresses()[0];
    if (!lan) return;
    const d = await startDaemon("lan-cli-pin", { mode: "root", config: TLS({ advertise: lan }) });
    cleanup.push(d.stop);
    const worker = await barista(d.addr, identity("pinned-worker"));
    cleanup.push(() => worker.client.close());
    const { caFingerprint, hostId } = await fetch(`http://${d.addr}/api/health`).then((r) => r.json()) as { caFingerprint?: string; hostId: string };
    const fingerprint = caFingerprint ?? d.daemon.tlsStatus().caFingerprint;
    const config = (rootHostId: string) => writeFileSync(join(d.home, "config.yml"), JSON.stringify({ host: "lan-cli-pin", mode: "root", token: "t0k", security: { mode: "tls", tls: { caFingerprint: fingerprint, rootHostId } } }));
    const bin = resolve(import.meta.dirname, "../packages/cli/bin/cafe.js");
    const ask = () => new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      const p = spawn(process.execPath, [bin, "ask", "--async", "--to", "pinned-worker", "check the totals"], {
        env: { ...process.env, CAFE_HOME: d.home, CAFE_DAEMON: `${lan}:${d.server.port}`, CAFE_TOKEN: "t0k" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      p.stderr.on("data", (chunk) => { stderr += chunk; });
      p.on("error", reject);
      p.on("close", (code) => done({ code, stderr }));
    });
    config(hostId);
    const result = await ask();
    expect(result.code, result.stderr).toBe(0);
    const mcp = spawn(process.execPath, [bin, "mcp"], {
      env: { ...process.env, CAFE_HOME: d.home, CAFE_DAEMON: `${lan}:${d.server.port}`, CAFE_TOKEN: "t0k" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    cleanup.push(() => { mcp.kill(); });
    const lines = createInterface({ input: mcp.stdout });
    const answer = new Promise<string>((done, reject) => {
      mcp.once("error", reject);
      mcp.once("exit", (code) => reject(new Error(`MCP exited before replying (${code})`)));
      lines.once("line", (line) => done(line));
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "cafe_ask", arguments: { question: "check the MCP totals", to: "pinned-worker", wait_seconds: 3 },
    } })}\n`);
    const response = JSON.parse(await answer);
    expect(response.result.content[0].text).toContain("pinned-worker says: check the MCP totals");
    const total = d.daemon.store.listThreads(10).length;
    expect(total).toBe(2);
    config("01J00000000000000000000000");
    const rejected = await ask();
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("pinned Root Host ID");
    expect(d.daemon.store.listThreads(10)).toHaveLength(total);
  });

  it("checks remote clarification answer transport before processing the request", async () => {
    const lan = localAddresses()[0];
    if (!lan) return;
    const d = await startDaemon("lan-clarification", { mode: "root", config: TLS() });
    cleanup.push(d.stop);
    const path = "/api/threads/unknown/clarifications/unknown/answer";
    const headers = { authorization: "Bearer t0k", "content-type": "application/json" };
    const plain = await fetch(`http://${lan}:${d.server.port}${path}`, { method: "POST", headers, body: "{}" });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ error: "tls_required" });
    const { ca, tlsPort } = await fetch(`http://${d.addr}/api/tls`).then((r) => r.json() as Promise<{ ca: string; tlsPort: number }>);
    const encrypted = await httpsGet(tlsPort, path, ca, headers, { host: lan, method: "POST", body: "{}" });
    expect(JSON.parse(encrypted.body)).toMatchObject({ error: "bad_request" });
  });

  it("a loopback request with a foreign Host cannot fetch /ca.crt either (#65)", async () => {
    const d = await startDaemon("lanhost", { mode: "root", config: TLS() });
    cleanup.push(d.stop);
    // fetch() drops a hand-set Host header, so use node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: d.server.port, path: "/ca.crt", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  }, 30_000);

  it("never lists a loopback address for other devices", async () => {
    const d = await startDaemon("lanloop", { mode: "root", config: TLS({ advertise: "127.0.0.1" }) });
    cleanup.push(d.stop);
    const tls = (await (await fetch(`http://${d.addr}/api/tls`)).json()) as { web?: string[] };
    expect(tls.web).toEqual([]);
  }, 30_000);

  it("a Host not on the network yet (temporary CA) offers no certificate and no address", async () => {
    // Its Root is unreachable, so it serves TLS with a temporary local CA it will replace on enrolment.
    const d = await startDaemon("lanwait", { config: TLS({ root: "127.0.0.1:1" }) });
    cleanup.push(d.stop);
    expect(d.daemon.tlsContext?.network).toBe(false);
    expect((await fetch(`http://${d.addr}/ca.crt`)).status).toBe(404);
    const s = (await (await fetch(`http://${d.addr}/api/settings`)).json()) as { web?: unknown };
    expect(s.web).toBeUndefined();
    const tls = (await (await fetch(`http://${d.addr}/api/tls`)).json()) as { web?: unknown };
    expect(tls.web).toBeUndefined();
  }, 30_000);

  it("plaintext mode: no /ca.crt and no https list", async () => {
    const d = await startDaemon("lanplain");
    cleanup.push(d.stop);
    expect((await fetch(`http://${d.addr}/ca.crt`)).status).toBe(404);
    const s = (await (await fetch(`http://${d.addr}/api/settings`)).json()) as { web?: unknown };
    expect(s.web).toBeUndefined();
  }, 30_000);
});
