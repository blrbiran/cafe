import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, waitFor } from "./helpers.ts";
import { generateCa, issueLeaf } from "../packages/daemon/src/tls/certs.ts";

/**
 * A custom `checkServerIdentity` **replaces** Node's default SAN check; it does not run alongside it.
 * The Daemon-to-Daemon link installs one to compare the peer's leaf against its pin, so it must call
 * `tls.checkServerIdentity` itself. Without that, the per-peer pin made every `wss://` link skip SAN
 * verification: a leaf for `some-other-name.example` was accepted when dialling `127.0.0.1`, undoing
 * the exact-SAN guarantee that commit `6524c5e` established.
 *
 * The check is exercised in-process (a real TLS handshake to a scratch server) so the test names the
 * behaviour, not the wiring.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

async function scratchServer(leaf: { cert: string; key: string }) {
  const { createServer } = await import("node:https");
  const server = createServer({ cert: leaf.cert, key: leaf.key }, (_q, r) => r.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return port;
}

function attempt(port: number, ca: string, check: (host: string, cert: import("node:tls").PeerCertificate) => Error | undefined): Promise<string> {
  return new Promise(async (resolve) => {
    const { get, Agent } = await import("node:https");
    const req = get({ host: "127.0.0.1", port, path: "/", ca, agent: new Agent({ keepAlive: false }), checkServerIdentity: check }, (res) => {
      res.resume();
      res.on("end", () => resolve("CONNECTED"));
    });
    req.on("error", (e) => resolve(`REFUSED ${(e as NodeJS.ErrnoException).code ?? e.message}`));
  });
}

describe("the pinned link still verifies the SAN", () => {
  it("refuses a valid CA-signed leaf that does not name the dialled host", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["somewhere.invalid"], 90);
    const port = await scratchServer(leaf);
    const { pinnedIdentityCheck } = await import("../packages/daemon/src/tls/trust.ts");
    // The pin is satisfied (any fingerprint is recorded on first contact), so only the SAN can refuse.
    const check = pinnedIdentityCheck("127.0.0.1:4778", () => ({}), () => {});
    expect(await attempt(port, ca.cert, check)).toMatch(/ALTNAME|ERR_TLS_CERT/);
  }, 30_000);

  it("accepts a leaf that names the dialled host", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["127.0.0.1", "localhost"], 90);
    const port = await scratchServer(leaf);
    const { pinnedIdentityCheck } = await import("../packages/daemon/src/tls/trust.ts");
    expect(await attempt(port, ca.cert, pinnedIdentityCheck("127.0.0.1:4778", () => ({}), () => {}))).toBe("CONNECTED");
  }, 30_000);

  it("a pin-only check (the earlier implementation) would accept the mismatched leaf", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["somewhere.invalid"], 90);
    const port = await scratchServer(leaf);
    // This is the regression, pinned down: returning undefined without asking Node's SAN checker.
    expect(await attempt(port, ca.cert, () => undefined)).toBe("CONNECTED");
  }, 30_000);
});