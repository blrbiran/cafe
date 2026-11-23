import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CafeClient } from "@cafe/protocol/client";
import { daemonHttpUrl, daemonWsUrl } from "@cafe/protocol/urls";
import { identity, startDaemon } from "./helpers.ts";

/**
 * Scheme helpers (v4-6). Every hard-coded `ws://`/`http://` becomes a call so `wss://`/`https://` is
 * expressible. The client trusts the Root CA by extending the default (system) trust store, never
 * by disabling verification.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

describe("daemon URL helpers", () => {
  it("builds ws/http for plaintext and wss/https for TLS", () => {
    expect(daemonWsUrl("desk:4777", { tls: false })).toBe("ws://desk:4777/ws");
    expect(daemonWsUrl("desk:4778", { tls: true })).toBe("wss://desk:4778/ws");
    expect(daemonHttpUrl("desk:4777", { tls: false })).toBe("http://desk:4777");
    expect(daemonHttpUrl("desk:4778", { tls: true })).toBe("https://desk:4778");
  });

  it("never doubles a path onto an address that already has one", () => {
    expect(daemonWsUrl("desk:4778", { tls: true })).toContain("//desk:4778/ws");
    expect(daemonWsUrl("desk:4778", { tls: true })).not.toContain("//ws");
  });
});

describe("CafeClient over TLS", () => {
  it("connects to a TLS daemon with the CA and registers a Barista end to end", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-client-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const d = await startDaemon("tlsclient", { home, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(d.stop);
    const ca = readFileSync(join(home, "tls", "ca.crt"), "utf8");
    const tlsPort = d.server.tlsPort!;

    const c = new CafeClient({ daemon: `127.0.0.1:${tlsPort}`, token: "t0k", tls: { ca } });
    cleanup.push(() => c.close());
    const rec = await c.connect(identity("tlsbarista", { description: "answers over tls" }));
    expect(rec?.address).toContain("tlsbarista");
  }, 30_000);
});
