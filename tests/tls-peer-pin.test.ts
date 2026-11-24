import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { startDaemon, waitFor } from "./helpers.ts";

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

    const child = await startDaemon("pinchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 10_000);

    // First contact recorded the Root's leaf under its `host:port`.
    const saved = (await import("yaml")).parse(readFileSync(join(childHome, "config.yml"), "utf8"));
    const pin = saved.security?.tls?.pins?.[rootAddr];
    expect(pin, "the child should pin the Root's leaf on first contact").toBeTruthy();
    // The pin names the leaf the Root actually serves (not the CA).
    expect(pin).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }, 40_000);

  it("refuses a peer whose leaf does not match the stored pin", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-bad-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-bad-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("badpinroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const ca = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    // The CA is trusted, but the child has a *wrong* leaf pin for the Root: this must fail closed.
    const child = await startDaemon("badpinchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, pins: { [rootAddr]: fakeFingerprint() } } } },
    });
    cleanup.push(child.stop);

    // Give the child several reconnect attempts; it must never come online.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(child.daemon.rootOnline).toBe(false);
  }, 40_000);
});