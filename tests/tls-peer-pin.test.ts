import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { startDaemon, waitFor } from "./helpers.ts";
import { enrollTestChild } from "./tls-helpers.ts";

/**
 * v4-6 §5 A: the CA pin authenticates the trust anchor, but rejecting an unexpected leaf *issued
 * under that CA* needs a separate per-peer leaf pin. The pure check existed (`checkPeerPin`) with no
 * caller, so a compromised CA key or the wrong machine on an address was accepted silently.
 *
 * The Daemon-to-Daemon link is where the pins live (`security.tls.pins`, keyed `host:port`).
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

function fakeFingerprint(): string {
  return Array.from({ length: 32 }, (_, i) => (i % 2 ? "AA" : "11")).join(":");
}

describe("daemon-to-daemon leaf pin (v4-6 §5 A)", () => {
  it("records a peer leaf on first contact and keeps trusting it afterwards", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("pinroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const ca = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "pinchild");

    const child = await startDaemon("pinchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId } } },
    });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 10_000);

    // First contact recorded the Root's leaf under its `host:port`.
    const saved = (await import("yaml")).parse(readFileSync(join(childHome, "config.yml"), "utf8"));
    const pin = saved.security?.tls?.pins?.[rootAddr];
    expect(pin, "the child should pin the Root's leaf on first contact").toBeTruthy();
    // The pin is the leaf's **key** fingerprint, so a renewal (same key, new certificate) keeps it.
    const { keyFingerprintOf } = await import("../packages/daemon/src/tls/certs.ts");
    const served = readFileSync(join(rootHome, "tls", "pinroot.crt"), "utf8");
    expect(pin).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(pin).toBe(keyFingerprintOf(served));
    // And it is not the certificate fingerprint, which changes on every renewal.
    expect(pin).not.toBe(new X509Certificate(served).fingerprint256);
  }, 40_000);

  it("refuses a peer whose leaf does not match the stored pin", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-bad-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-bad-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("badpinroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const ca = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    // The CA is trusted and the child is enrolled, but it holds a *wrong* leaf pin for the Root.
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "badpinchild");
    const child = await startDaemon("badpinchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId, pins: { [rootAddr]: fakeFingerprint() } } } },
    });
    cleanup.push(child.stop);

    // Give the child several reconnect attempts; it must never come online.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(child.daemon.rootOnline).toBe(false);
  }, 40_000);

  it("keeps the link up across a real renewal of the Root's leaf", async () => {
    // The whole point of the key pin: a renewal reshapes the certificate but not the key, so the
    // child's pin still matches and the live link (and the next reconnect) keep working.
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-renew-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-renew-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("pinrenewroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "pinrenewchild");
    const child = await startDaemon("pinrenewchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId } } },
    });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 10_000);
    const before = readFileSync(join(rootHome, "tls", "pinrenewroot.crt"), "utf8");

    // Renew the Root's served leaf the way the timer would.
    await root.daemon.tlsContext!.renew!();
    const after = readFileSync(join(rootHome, "tls", "pinrenewroot.crt"), "utf8");
    expect(after).not.toBe(before);

    // Force a fresh dial: re-point at the same Root, which drops the uplink and reconnects through the pin.
    child.daemon.setRoot(rootAddr);
    await waitFor(() => child.daemon.rootOnline, 10_000);
    expect(child.daemon.rootOnline).toBe(true);
  }, 40_000);

  it("forgets a pin on request so a reinstalled Host can be trusted again", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-clear-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-clear-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("pinclearroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "pinclearchild");
    const child = await startDaemon("pinclearchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId } } },
    });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 10_000);
    expect(child.daemon.config.security.tls.pins[rootAddr]).toBeTruthy();

    const res = await fetch(`http://${child.addr}/api/tls/pins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer: rootAddr, clear: true }),
    });
    expect(res.status).toBe(200);
    expect(child.daemon.config.security.tls.pins[rootAddr]).toBeUndefined();
    // Persisted: the running config and config.yml agree.
    const saved = (await import("yaml")).parse(readFileSync(join(childHome, "config.yml"), "utf8"));
    expect(saved.security?.tls?.pins?.[rootAddr]).toBeUndefined();
  }, 40_000);
});