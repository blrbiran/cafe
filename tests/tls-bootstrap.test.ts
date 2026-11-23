import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

/**
 * CA bootstrap in `runDaemon` (v4-6 §3.3):
 *
 * - A Root with no CA creates one.
 * - A standalone Daemon with no Root creates a local CA (it is its own trust anchor for now).
 * - A Daemon with a Root and no CA fetches the Root's public `ca.crt`; a configured fingerprint is
 *   enforced (fail-closed), and a first contact without one is TOFU and records the fingerprint.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

describe("CA bootstrap", () => {
  it("a standalone daemon creates a local CA and still starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-ca-standalone-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    // Opt into TLS: the test helper defaults to plaintext (production defaults to TLS).
    const d = await startDaemon("alone", { home, config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(d.stop);
    expect(existsSync(join(home, "tls", "ca.crt"))).toBe(true);
    expect(d.server.tlsPort).toBeGreaterThan(0);
  }, 30_000);

  it("a child with a Root but no CA fetches the Root's CA, and the link works", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-ca-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-ca-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("caroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const rootCa = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");

    const child = await startDaemon("cachild", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(child.stop);

    // The child trusted the Root's CA (no local one was invented).
    expect(readFileSync(join(childHome, "tls", "ca.crt"), "utf8")).toBe(rootCa);
    await waitFor(() => child.daemon.rootOnline, 10_000);

    const b = await barista(root.addr, identity("cabilling", { tags: ["invoice"] }));
    cleanup.push(() => b.client.close());
    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "the invoice total is wrong" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: b.rec.agentId });

    // TOFU recorded the Root's CA fingerprint so a later mismatch is refused.
    const cfg = readFileSync(join(childHome, "config.yml"), "utf8");
    expect(cfg).toContain("caFingerprint");
  }, 40_000);

  it("refuses to enrol when the configured CA fingerprint does not match the Root's", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-ca-mismatch-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-ca-mismatch-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("mmroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    // A configured pin that does not match the Root's CA must refuse enrolment.
    const err = await startDaemon("mmchild", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0, caFingerprint: "AA:BB:CC" } } },
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/fingerprint/i);
    // Nothing was written: a refused enrolment must not leave a CA on disk.
    expect(existsSync(join(childHome, "tls", "ca.crt"))).toBe(false);
  }, 30_000);
});