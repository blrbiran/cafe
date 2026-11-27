import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { request as httpsPostRequest } from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostIdFromCertificate } from "../packages/daemon/src/tls/certs.ts";
import { startDaemon } from "./helpers.ts";
import { httpsRequest } from "./tls-helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function postTls(opts: { host: string; port: number; path: string; ca: string; headers?: Record<string, string>; body: unknown }): Promise<{ status: number; body: any }> {
  const body = JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpsPostRequest({
      host: opts.host,
      port: opts.port,
      path: opts.path,
      method: "POST",
      ca: opts.ca,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...opts.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("Root Host enrollment identity", () => {
  it("persists one Host ID in health, public TLS discovery, and the Root leaf SAN", async () => {
    const root = await startDaemon("hostroot", {
      mode: "root",
      config: { security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(root.stop);
    const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
    const tls = await httpsRequest({ host: "127.0.0.1", port: root.server.tlsPort!, path: "/api/tls", ca });
    const tlsInfo = JSON.parse(tls.body) as { hostId?: string; rootHostId?: string };
    const health = await fetch(`http://${root.addr}/api/health`).then((response) => response.json()) as { hostId?: string };
    const cert = readFileSync(join(root.home, "tls", "hostroot.crt"), "utf8");

    expect(tls.status).toBe(200);
    expect(tlsInfo.hostId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(tlsInfo.rootHostId).toBe(tlsInfo.hostId);
    expect(health.hostId).toBe(tlsInfo.hostId);
    expect(hostIdFromCertificate(cert)).toBe(tlsInfo.hostId);
  }, 30_000);

  it("creates Root Host invites only for the local operator credential", async () => {
    const root = await startDaemon("invite-root", {
      mode: "root",
      config: { security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(root.stop);
    const operatorPath = join(root.home, "operator.key");
    expect(existsSync(operatorPath)).toBe(true);
    if (!existsSync(operatorPath)) return;
    const key = readFileSync(operatorPath, "utf8");
    expect(statSync(operatorPath).mode & 0o777).toBe(0o600);

    const denied = await fetch(`http://${root.addr}/api/host/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "child-host" }),
    });
    expect(denied.status).toBe(403);

    const accepted = await fetch(`http://${root.addr}/api/host/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-operator-key": key },
      body: JSON.stringify({ name: "child-host" }),
    });
    expect(accepted.status).toBe(200);
    const result = await accepted.json() as { inviteCode: string; hostId: string; expiresAt: number };
    expect(result.inviteCode).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hostId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  }, 30_000);

  it("redeems an invite over Root TLS without returning the child's private key", async () => {
    const root = await startDaemon("redeem-root", {
      mode: "root",
      config: { security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(root.stop);
    const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
    const operatorKey = readFileSync(join(root.home, "operator.key"), "utf8");
    const inviteResponse = await fetch(`http://${root.addr}/api/host/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-operator-key": operatorKey },
      body: JSON.stringify({ name: "redeem-child" }),
    });
    expect(inviteResponse.status).toBe(200);
    const invite = await inviteResponse.json() as { inviteCode: string; hostId: string };
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const body = {
      inviteCode: invite.inviteCode,
      requestId: "connect-request-1",
      publicKey: pair.publicKey,
      sans: ["127.0.0.1", "localhost", "redeem-child"],
    };
    const first = await postTls({ host: "127.0.0.1", port: root.server.tlsPort!, path: "/api/tls/leaf", ca,
      headers: { authorization: "Bearer t0k" }, body });
    expect(first.status).toBe(200);
    expect(first.body.hostId).toBe(invite.hostId);
    expect(hostIdFromCertificate(first.body.cert)).toBe(invite.hostId);
    expect(first.body).not.toHaveProperty("key");

    const retry = await postTls({ host: "127.0.0.1", port: root.server.tlsPort!, path: "/api/tls/leaf", ca,
      headers: { authorization: "Bearer t0k" }, body });
    expect(retry.status).toBe(200);
    expect(retry.body.cert).toBe(first.body.cert);
    expect(retry.body.retry).toBe(true);
  }, 30_000);

  it("does not issue a Host leaf to a token-only caller without a one-use invite", async () => {
    const root = await startDaemon("leaf-root", {
      mode: "root",
      config: { security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(root.stop);
    const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
    const response = await postTls({
      host: "127.0.0.1",
      port: root.server.tlsPort!,
      path: "/api/tls/leaf",
      ca,
      headers: { authorization: "Bearer t0k" },
      body: { sans: ["127.0.0.1"] },
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("invite_required");
    expect(response.body.key).toBeUndefined();
  }, 30_000);
});
