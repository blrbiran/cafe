import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, get } from "node:https";
import { startDaemon } from "./helpers.ts";

/**
 * A Daemon that stays up must renew its own leaf before expiry (v4-6 §5 B). Here the leaf starts
 * already inside the renewal window, the check interval is shortened, and we assert the served leaf
 * changes and the on-disk leaf is replaced — with no restart.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

function leafPem(port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path: "/api/health", ca, agent: new Agent({ keepAlive: false }) }, (res) => {
      const socket = res.socket as unknown as { getPeerCertificate(): { raw: Buffer } };
      const raw = socket.getPeerCertificate().raw;
      res.resume();
      resolve(`-----BEGIN CERTIFICATE-----\n${raw.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`);
    });
    req.on("error", reject);
  });
}

async function waitForFreshLeaf(port: number, ca: string, undated: string, timeoutMs = 8_000): Promise<string> {
  const start = Date.now();
  // Compare fingerprints: the served PEM is re-serialised (CRLF) and never byte-equals the issued one.
  const old = new X509Certificate(undated).fingerprint256;
  for (;;) {
    const pem = await leafPem(port, ca).catch(() => "");
    if (pem) {
      const x = new X509Certificate(pem);
      // A leaf not issued in the setup AND with a long validity is the renewed one: the timer may
      // have already run before the first poll, so requiring "!= setup leaf" alone is not enough.
      const days = (Date.parse(x.validTo) - Date.now()) / 86_400_000;
      if (x.fingerprint256 !== old && days > 80) return pem;
    }
    if (Date.now() - start > timeoutMs) throw new Error("leaf was not renewed while running");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("a running daemon renews its leaf", () => {
  it("reissues a near-expiry leaf on the timer, on disk and in the handshake", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-running-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));

    // Start with a healthy 90-day leaf: `ensureLeaf` does NOT reissue at boot, so only the running
    // timer can renew. Then swap in an expiring leaf while the Daemon is up, as the passage of time
    // would, and watch the timer replace it.
    const d = await startDaemon("renewing", {
      home,
      mode: "root",
      config: { security: { mode: "tls", tls: { port: 0 } } },
      timing: { leafCheckIntervalMs: 150 },
    });
    cleanup.push(d.stop);
    const caPem = readFileSync(join(home, "tls", "ca.crt"), "utf8");
    const port = d.server.tlsPort!;
    const booted = await leafPem(port, caPem);

    const { issueLeaf } = await import("../packages/daemon/src/tls/certs.ts");
    const { tlsPaths } = await import("../packages/daemon/src/tls/store.ts");
    const ca = { cert: caPem, key: readFileSync(join(home, "tls", "ca.key"), "utf8"), fingerprint256: new X509Certificate(caPem).fingerprint256 };
    const expiring = await issueLeaf(ca, ["renewing", "127.0.0.1", "localhost"], 3);
    d.daemon.tlsContext!.replace({ cert: expiring.cert, key: expiring.key });

    // The timer may renew the expiring leaf before we can even read it back, so the observable to
    // assert is "a fresh leaf that is not the one we booted with" — which the start-time check alone
    // cannot produce, because the boot leaf was healthy.
    const renewed = await waitForFreshLeaf(port, caPem, booted);
    const days = (Date.parse(new X509Certificate(renewed).validTo) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(80);
    // Written through, so a later restart keeps the renewed leaf (compare fingerprints, since node's
    // handshake re-serialises PEM with CRLF).
    const onDisk = readFileSync(tlsPaths(home, "renewing").leafCertPath, "utf8");
    expect(new X509Certificate(onDisk).fingerprint256).toBe(new X509Certificate(renewed).fingerprint256);
    expect(onDisk).not.toBe(booted);
    // Same trust anchor: the CA did not change.
    expect(new X509Certificate(renewed).checkIssued(new X509Certificate(caPem))).toBe(true);
  }, 60_000);
});