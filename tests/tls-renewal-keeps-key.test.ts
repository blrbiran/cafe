import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, waitFor } from "./helpers.ts";
import { daemonHttpUrl } from "@cafe/protocol/urls";

/**
 * Renewal keeps the leaf's key on every path (v4-6 §5 A/B): the Root's timer, the Root's
 * `/api/tls/renew`, and a child asking the Root for a leaf. If a renewal generated a fresh key, every
 * peer that already pinned this Host's leaf would refuse the renewed certificate and, because TLS
 * fails closed, the fleet would stop talking on rotation.
 *
 * The observable that survives renewal is the **public key**; the certificate (serial, validity,
 * fingerprint) must change.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

const spkiOf = (pem: string): string =>
  createHash("sha256")
    .update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

describe("renewal keeps the leaf key", () => {
  it("the Root's /api/tls/renew reissues for the same key", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-renewkey-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const d = await startDaemon("renewkey", { home, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(d.stop);
    const before = readFileSync(join(home, "tls", "renewkey.crt"), "utf8");
    const res = await fetch(`${daemonHttpUrl(d.addr, { tls: false })}/api/tls/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sans: ["127.0.0.1", "localhost", "renewkey"] }),
    });
    expect(res.status).toBe(200);
    const after = readFileSync(join(home, "tls", "renewkey.crt"), "utf8");
    expect(after).not.toBe(before);
    expect(spkiOf(after)).toBe(spkiOf(before));
    // The private key on disk still matches the new certificate: TLS can terminate with it.
    const key = readFileSync(join(home, "tls", "renewkey.key"), "utf8");
    const ctx = (await import("node:tls")).createSecureContext({ cert: after, key });
    expect(ctx.context).toBeTruthy();
  }, 40_000);

  it("a child asking the Root for a fresh leaf keeps its existing key", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-tls-kidroot-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-tls-kid-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("kidroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    mkdirSync(join(childHome, "tls"), { recursive: true });
    writeFileSync(join(childHome, "tls", "ca.crt"), readFileSync(join(rootHome, "tls", "ca.crt"), "utf8"));
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    const child = await startDaemon("kid", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 10_000);
    const before = readFileSync(join(childHome, "tls", "kid.crt"), "utf8");

    // The child has no CA key, so its renewal is exactly the Root-issued path.
    await child.daemon.tlsContext!.renew!();
    const after = readFileSync(join(childHome, "tls", "kid.crt"), "utf8");
    expect(after).not.toBe(before);
    expect(spkiOf(after)).toBe(spkiOf(before));
  }, 40_000);
});