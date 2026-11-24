import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateCa, issueLeaf } from "../packages/daemon/src/tls/certs.ts";
import { ensureLeaf, writeLeaf } from "../packages/daemon/src/tls/store.ts";

/**
 * `ensureLeaf` reissues when the requested SANs are not covered by the leaf on disk. That check was a
 * substring test, so `IP Address:127.0.0.1` "covered" a leaf issued for `127.0.0.10`, and `DNS:desk`
 * covered `desk.example`. The changed name then kept the old leaf and every connection to the new
 * name failed closed with `ERR_TLS_CERT_ALTNAME_INVALID`.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

const sanOf = (pem: string): string => new X509Certificate(pem).subjectAltName ?? "";

describe("leaf SAN coverage is exact", () => {
  it("reissues when 127.0.0.1 is only a prefix of an address already in the leaf", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-san-ip-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const ca = await generateCa();
    const old = await issueLeaf(ca, ["10.0.0.10", "127.0.0.1", "localhost"], 90);
    writeLeaf(home, "desk", { cert: old.cert, key: old.key });

    // `127.0.0.1` is a prefix of `10.0.0.10`? No; use the real trap: ask for 127.0.0.1 while the leaf
    // has 127.0.0.10.
    const trap = await issueLeaf(ca, ["Desk", "127.0.0.10", "localhost"], 90);
    writeLeaf(home, "desk", { cert: trap.cert, key: trap.key });

    const next = await ensureLeaf(home, "desk", ca, { host: "Desk", lan: "127.0.0.1" });
    expect(next.cert).not.toBe(trap.cert);
    expect(sanOf(next.cert)).toContain("IP Address:127.0.0.1");
  }, 60_000);

  it("reissues when the desired DNS name is only a prefix of one in the leaf", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-san-dns-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const ca = await generateCa();
    const trap = await issueLeaf(ca, ["desk.example", "127.0.0.1", "localhost"], 90);
    writeLeaf(home, "desk", { cert: trap.cert, key: trap.key });

    const next = await ensureLeaf(home, "desk", ca, { host: "desk", lan: "127.0.0.1" });
    expect(next.cert).not.toBe(trap.cert);
    expect(sanOf(next.cert)).toContain("DNS:desk");
  }, 60_000);

  it("keeps a leaf whose SANs match exactly", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-san-exact-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const ca = await generateCa();
    const first = await ensureLeaf(home, "desk", ca, { host: "desk", lan: "127.0.0.1" });
    const again = await ensureLeaf(home, "desk", ca, { host: "desk", lan: "127.0.0.1" });
    expect(again.cert).toBe(first.cert);
  }, 60_000);
});