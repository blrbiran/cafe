import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { startDaemon, waitFor } from "./helpers.ts";
import { enrollTestChild } from "./tls-helpers.ts";

/** Authenticated links bind the CA, signed Host ID, and the Root's current key binding. */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

function fakeFingerprint(): string {
  return Array.from({ length: 32 }, (_, i) => (i % 2 ? "AA" : "11")).join(":");
}

describe("daemon-to-daemon Host identity", () => {
  it("caches the Root's authenticated Host and key binding", async () => {
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

    const binding = (child.daemon.store.getKv<import("@cafe/protocol").HostIdentity[]>("rootHostBindings") ?? [])
      .find((record) => record.hostId === root.daemon.hostId);
    const { keyFingerprintOf } = await import("../packages/daemon/src/tls/certs.ts");
    const served = readFileSync(join(rootHome, "tls", "pinroot.crt"), "utf8");
    expect(binding?.keyFingerprint === keyFingerprintOf(served)).toBe(true);
    expect(binding?.keyFingerprint === new X509Certificate(served).fingerprint256).toBe(false);
  }, 40_000);

  it("refuses a TLS uplink whose leaf has a different Host ID than the pin", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-bad-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-bad-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("badpinroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const ca = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "badpinchild");
    const child = await startDaemon("badpinchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.hostId } } },
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

    // Dial the same Root through its main discovery address after renewal.
    child.daemon.setRoot(root.addr);
    await waitFor(() => child.daemon.rootOnline, 10_000);
    expect((child.daemon as any).uplink?.hostIdentity?.hostId).toBe(root.daemon.hostId);
  }, 40_000);

  it("closes a connected direct link when the Root replaces the remote key", async () => {
    const root = await startDaemon("rekeyroot", { mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const firstHome = mkdtempSync(join(tmpdir(), "cafe-rekey-first-"));
    const secondHome = mkdtempSync(join(tmpdir(), "cafe-rekey-second-"));
    cleanup.push(() => rmSync(firstHome, { recursive: true, force: true }), () => rmSync(secondHome, { recursive: true, force: true }));
    const enroll = (home: string, host: string) => enrollTestChild(root, root.daemon.hostId, home, host);
    const firstId = await enroll(firstHome, "rekey-first");
    const secondId = await enroll(secondHome, "rekey-second");
    const start = (home: string, host: string, identity: typeof firstId) => startDaemon(host, {
      home, config: { root: root.addr, security: { mode: "tls", tls: { port: 0, caFingerprint: identity.caFingerprint, rootHostId: identity.rootHostId } } },
    });
    const first = await start(firstHome, "rekey-first", firstId);
    cleanup.push(first.stop);
    const second = await start(secondHome, "rekey-second", secondId);
    cleanup.push(second.stop);
    await waitFor(() => first.daemon.rootOnline && second.daemon.rootOnline && !!first.daemon.peerUrlFor("rekey-second"), 10_000);
    const direct = await (first.daemon as any).link("rekey-second");
    expect(direct.hostIdentity.hostId).toBe(secondId.hostId);

    // The Root requires its child to be offline for replacement. The peer connection can still exist.
    const secondUplink = (second.daemon as any).uplinkSocket;
    (second.daemon as any).scheduleReconnect = () => {};
    secondUplink.close();
    await waitFor(() => root.daemon.daemons().some((entry) => entry.host === "rekey-second" && !entry.online), 10_000);
    expect(direct.isClosed).toBe(false);
    const invite = root.daemon.createHostInvite({ replaceHost: "rekey-second" });
    const { generateHostKeyPair } = await import("../packages/daemon/src/tls/certs.ts");
    const pair = await generateHostKeyPair();
    const replaced = await root.daemon.redeemHostInvite({ inviteCode: invite.inviteCode, requestId: "rekey-fixture", publicKey: pair.publicKey, sans: ["127.0.0.1"] });
    expect(replaced.hostId).toBe(secondId.hostId);
    await waitFor(() => direct.isClosed, 5_000);
  }, 40_000);

  it("clears a legacy address pin without affecting the authenticated Host binding", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-pin-clear-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-pin-clear-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("pinclearroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const rootAddr = `127.0.0.1:${root.server.tlsPort}`;
    const enrolled = await enrollTestChild(root, root.daemon.hostId, childHome, "pinclearchild");
    const child = await startDaemon("pinclearchild", {
      home: childHome,
      config: { root: rootAddr, security: { mode: "tls", tls: { port: 0, caFingerprint: enrolled.caFingerprint, rootHostId: enrolled.rootHostId, pins: { [rootAddr]: fakeFingerprint() } } } },
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