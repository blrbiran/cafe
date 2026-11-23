import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprintOf, generateCa, issueLeaf, sanList } from "../packages/daemon/src/tls/certs.ts";

describe("cafe TLS certificates", () => {
  it("generates a CA and a leaf the CA verifies", async () => {
    const ca = await generateCa();
    expect(ca.cert).toContain("BEGIN CERTIFICATE");
    expect(fingerprintOf(ca.cert)).toBe(ca.fingerprint256);

    const leaf = await issueLeaf(ca, ["127.0.0.1", "localhost", "desk"], 90);
    const leafX = new X509Certificate(leaf.cert);
    const caX = new X509Certificate(ca.cert);
    // The chain verifies against the CA and the leaf is a leaf, not a CA.
    expect(leafX.checkIssued(caX)).toBe(true);
    expect(leafX.verify(caX.publicKey)).toBe(true);
    expect(leafX.ca).toBe(false);
    expect(fingerprintOf(leaf.cert)).toBe(leaf.fingerprint256);
    expect(leaf.fingerprint256).not.toBe(ca.fingerprint256);
  });

  it("puts every requested name into the SAN, with IPs as IP entries", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["127.0.0.1", "10.0.0.5", "desk.example", "localhost"]);
    const x = new X509Certificate(leaf.cert);
    expect(x.subjectAltName).toContain("DNS:desk.example");
    expect(x.subjectAltName).toContain("DNS:localhost");
    expect(x.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(x.subjectAltName).toContain("IP Address:10.0.0.5");
  });

  it("computes the SAN list from a host, its advertise address and its LAN IP", () => {
    const sans = sanList({ host: "desk", advertise: "10.0.0.5:4777", lan: "192.168.1.20" });
    expect(sans).toEqual(expect.arrayContaining(["desk", "10.0.0.5", "192.168.1.20", "127.0.0.1", "localhost"]));
    // Duplicates collapse.
    expect(new Set(sans).size).toBe(sans.length);
  });

  it("issues a 90-day leaf by default and a shorter one when asked", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["localhost"]);
    const xs = new X509Certificate(leaf.cert);
    const days = (Date.parse(xs.validTo) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThan(91);
    const short = await issueLeaf(ca, ["localhost"], 5);
    const shortDays = (Date.parse(new X509Certificate(short.cert).validTo) - Date.now()) / 86_400_000;
    expect(shortDays).toBeLessThan(6);
  });

  it("emits a leaf key the daemon can actually use to terminate TLS", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["localhost"]);
    const { createPrivateKey } = await import("node:crypto");
    expect(() => createPrivateKey(leaf.key)).not.toThrow();
    expect(() => createPrivateKey(ca.key)).not.toThrow();
  });
});