import { X509Certificate, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateCa, issueLeaf } from "../packages/daemon/src/tls/certs.ts";

/**
 * Renewal must not change the leaf's key (v4-6 §5 A/B). The per-peer pin names the peer's identity;
 * a renewal that generated a fresh RSA key would change that identity, so every already-pinned peer
 * would refuse the renewed leaf — with fail-closed TLS there is no rescue, and the whole fleet stops
 * talking the moment its leaves rotate. Reissuing a certificate for the same public key keeps the
 * identity stable while the certificate (validity, SANs, serial) changes.
 */

const spki = (pem: string): string =>
  createHash("sha256")
    .update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

describe("leaf renewal keeps the key", () => {
  it("reissues a certificate for the supplied private key: same public key, new certificate", async () => {
    const ca = await generateCa();
    const first = await issueLeaf(ca, ["desk", "127.0.0.1"], 3);
    const renewed = await issueLeaf(ca, ["desk", "127.0.0.1"], 90, first.key);

    expect(spki(renewed.cert)).toBe(spki(first.cert));
    const before = new X509Certificate(first.cert);
    const after = new X509Certificate(renewed.cert);
    expect(after.serialNumber).not.toBe(before.serialNumber);
    expect(after.checkIssued(new X509Certificate(ca.cert))).toBe(true);
    expect((Date.parse(after.validTo) - Date.now()) / 86_400_000).toBeGreaterThan(88);
  });

  it("accepts the public key alone, so a Host that only sends its SPKI can be reissued", async () => {
    const ca = await generateCa();
    const first = await issueLeaf(ca, ["desk"], 3);
    const publicPem = new X509Certificate(first.cert).publicKey.export({ type: "spki", format: "pem" }).toString();
    const renewed = await issueLeaf(ca, ["desk"], 90, publicPem);
    expect(spki(renewed.cert)).toBe(spki(first.cert));
  });

  it("generates a new key when no key is supplied (first issuance)", async () => {
    const ca = await generateCa();
    const a = await issueLeaf(ca, ["desk"]);
    const b = await issueLeaf(ca, ["desk"]);
    expect(spki(a.cert)).not.toBe(spki(b.cert));
  });
});