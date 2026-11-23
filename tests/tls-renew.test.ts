import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { httpsRequest } from "./tls-helpers.ts";
import { daemonHttpUrl } from "@cafe/protocol/urls";
import { startDaemon } from "./helpers.ts";

/**
 * Hot renewal (v4-6 §3.5): a reissued leaf is used by the next connection with no restart. The leaf
 * is read through `current()` on every new handshake, so swapping it in place is enough.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

describe("leaf renewal", () => {
  it("reissues over the API and the next TLS connection presents the new leaf", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-renew-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const d = await startDaemon("renew", { home, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(d.stop);
    const ca = (await import("node:fs")).readFileSync(join(home, "tls", "ca.crt"), "utf8");
    const port = d.server.tlsPort!;

    const first = await leafFingerprint(port, ca);
    const res = await fetch(`${daemonHttpUrl(d.addr, { tls: false })}/api/tls/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sans: ["127.0.0.1", "localhost", "renew"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fingerprint256: string };
    expect(body.fingerprint256).not.toBe(first);

    const second = await leafFingerprint(port, ca);
    expect(second).toBe(body.fingerprint256);
    // The CA is the same one: renewal does not change the trust anchor.
    expect(new X509Certificate(await leafPem(port, ca)).checkIssued(new X509Certificate(ca))).toBe(true);
  }, 30_000);
});

/** The leaf a fresh connection sees, as its SHA-256 fingerprint. */
async function leafFingerprint(port: number, ca: string): Promise<string> {
  return new X509Certificate(await leafPem(port, ca)).fingerprint256;
}

async function leafPem(port: number, ca: string): Promise<string> {
  const { get, Agent } = await import("node:https");
  return new Promise((resolve, reject) => {
    // A fresh connection every time: a keep-alive agent would reuse the pre-renewal socket and see
    // the old leaf even though the server already swapped its context.
    const req = get({ host: "127.0.0.1", port, path: "/api/health", ca, servername: undefined, agent: new Agent({ keepAlive: false }) }, (res) => {
      const socket = res.socket as unknown as { getPeerCertificate(): { raw: Buffer } };
      const raw = socket.getPeerCertificate().raw;
      res.resume();
      resolve(`-----BEGIN CERTIFICATE-----\n${raw.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`);
    });
    req.on("error", reject);
  });
}

export { httpsRequest };