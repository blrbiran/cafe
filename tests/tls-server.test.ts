import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpsRequest } from "./tls-helpers.ts";
import { afterEach, describe, expect, it } from "vitest";
import { generateCa } from "../packages/daemon/src/tls/certs.ts";
import { startDaemon } from "./helpers.ts";
import { once } from "node:events";
import WebSocket from "ws";
import { CURRENT_FEATURES, Methods, PROTOCOL_VERSION } from "@cafe/protocol";
import { Peer } from "@cafe/protocol/peer";

/**
 * The TLS listener (v4-6 §3.1): a second port that serves the same API and `/ws` over TLS, while
 * the plaintext port keeps serving the Web UI and loopback. A plaintext client dialing the TLS port
 * must fail — there is no fallback.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

/** A Root that generates its own CA and leaf on start, as a real Root does. */
async function tlsDaemon() {
  const home = mkdtempSync(join(tmpdir(), "cafe-tls-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const d = await startDaemon("tls", { home, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
  cleanup.push(d.stop);
  const ca = readFileSync(join(home, "tls", "ca.crt"), "utf8");
  return { d, ca };
}

describe("TLS listener", () => {
  it("serves the API over TLS on its own port and keeps the plaintext port for loopback", async () => {
    const { d, ca } = await tlsDaemon();
    expect(d.server.tlsPort).toBeGreaterThan(0);
    expect(d.server.tlsPort).not.toBe(d.server.port);

    const overTls = await httpsRequest({ host: "127.0.0.1", port: d.server.tlsPort!, path: "/api/health", ca });
    expect(overTls.status).toBe(200);
    expect(JSON.parse(overTls.body)).toMatchObject({ ok: true, host: "tls" });

    // Plaintext still works on the main port (Web UI + loopback CLI).
    const plain = await fetch(`http://127.0.0.1:${d.server.port}/api/health`);
    expect(plain.status).toBe(200);
  }, 30_000);

  it("accepts UI TLS without a client certificate but requires it for Host links", async () => {
    const { d, ca } = await tlsDaemon();
    const dial = async () => {
      const ws = new WebSocket(`wss://127.0.0.1:${d.server.tlsPort}/ws`, { ca });
      const peer = new Peer(ws);
      cleanup.push(() => ws.terminate());
      ws.on("message", (data) => void peer.receive(data.toString()));
      ws.on("close", () => peer.closed());
      await once(ws, "open");
      return peer;
    };
    const ui = await dial();
    await expect(ui.request(Methods.initialize, { kind: "ui", protocolVersion: PROTOCOL_VERSION })).resolves.toMatchObject({ host: "tls" });
    for (const kind of ["daemon", "peer"] as const) {
      const host = await dial();
      await expect(host.request(Methods.initialize, {
        kind,
        protocolVersion: PROTOCOL_VERSION,
        features: CURRENT_FEATURES,
        host: "unenrolled",
        hostAuthVersion: 1,
        rootHostId: d.daemon.hostId,
      })).rejects.toMatchObject({ code: "host_auth_required" });
    }
  }, 30_000);

  it("does not install Host RPC handlers on a failed initialize", async () => {
    const { d, ca } = await tlsDaemon();
    const ws = new WebSocket(`wss://127.0.0.1:${d.server.tlsPort}/ws`, { ca });
    const peer = new Peer(ws);
    cleanup.push(() => ws.terminate());
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("close", () => peer.closed());
    await once(ws, "open");
    await expect(peer.request(Methods.initialize, { kind: "daemon", protocolVersion: PROTOCOL_VERSION })).rejects.toMatchObject({ code: "host_auth_required" });
    await expect(peer.request("registry/sync", { records: [] })).rejects.toMatchObject({ code: "unknown_method" });
    expect(d.daemon.daemons().filter((host) => !host.isRoot)).toHaveLength(0);
  }, 30_000);

  it("refuses a plaintext client on the TLS port", async () => {
    const { d } = await tlsDaemon();
    const err = await fetch(`http://127.0.0.1:${d.server.tlsPort}/api/health`).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
  }, 30_000);

  it("fails the handshake for a CA that did not sign the leaf", async () => {
    const { d } = await tlsDaemon();
    const other = await generateCa();
    const err = await httpsRequest({ host: "127.0.0.1", port: d.server.tlsPort!, path: "/api/health", ca: other.cert }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/self.signed|unable to verify|certificate|issuer/i);
  }, 30_000);

  it("fails startup, rather than starting plaintext, when the configured CA fingerprint does not match", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-badpin-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const err = await startDaemon("tls", {
      home,
      mode: "root",
      config: { security: { mode: "tls", tls: { port: 0, caFingerprint: "AA:BB:CC" } } },
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/fingerprint/i);
  }, 30_000);
});