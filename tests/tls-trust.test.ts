import { describe, expect, it } from "vitest";
import { checkPeerPin, enrollFingerprint, normalizeFingerprint, readTlsConfig } from "../packages/daemon/src/tls/trust.ts";

/**
 * Trust bootstrap (v4-6 §3.3). The CA fingerprint authenticates the trust **anchor** at enrolment;
 * the pin names one **peer's** leaf. They are different values with different lifetimes and must
 * never be compared to each other.
 */

describe("TLS config surface", () => {
  it("defaults to TLS on port 4778", () => {
    expect(readTlsConfig({})).toMatchObject({ mode: "tls", port: 4778, pins: {} });
  });

  it("honours plaintext and a custom port", () => {
    expect(readTlsConfig({ security: { mode: "plaintext" } })).toMatchObject({ mode: "plaintext" });
    expect(readTlsConfig({ security: { tls: { port: 9999 } } })).toMatchObject({ mode: "tls", port: 9999 });
  });

  it("carries the CA path, the CA pin and peer pins through", () => {
    const cfg = readTlsConfig({
      security: { tls: { ca: "/tmp/ca.crt", caFingerprint: "AA:BB", pins: { "desk:4778": "CC:DD" } } },
    });
    expect(cfg).toMatchObject({ ca: "/tmp/ca.crt", caFingerprint: "AA:BB", pins: { "desk:4778": "CC:DD" } });
  });
});

describe("fingerprint normalisation", () => {
  it("accepts the colon form and a bare hex string and compares case-insensitively", () => {
    expect(normalizeFingerprint("aa:bb:cc")).toBe("AA:BB:CC");
    expect(normalizeFingerprint("aabbcc")).toBe("AA:BB:CC");
    expect(normalizeFingerprint("aa:bb:cc")).toBe(normalizeFingerprint("AA:BB:CC"));
  });

  it("tolerates a leading sha256: label", () => {
    expect(normalizeFingerprint("sha256:aa:bb")).toBe("AA:BB");
  });
});

describe("CA enrolment (TOFU with an explicit pin)", () => {
  const ca = "AA:BB:CC";

  it("enrols on first contact when no fingerprint is expected", () => {
    expect(enrollFingerprint(ca, undefined)).toEqual({ ok: true, firstSeen: true });
  });

  it("accepts a matching explicit fingerprint", () => {
    expect(enrollFingerprint(ca, "aabbcc")).toEqual({ ok: true, firstSeen: false });
  });

  it("refuses a mismatch unconditionally and names both fingerprints", () => {
    const r = enrollFingerprint(ca, "DD:EE:FF");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/AA:BB:CC/);
    expect(r.reason).toMatch(/DD:EE:FF/);
  });
});

describe("per-peer identity pin", () => {
  const leaf = "11:22:33";

  it("records the leaf on first contact with that peer", () => {
    expect(checkPeerPin("desk:4778", { keyFingerprint: leaf }, {})).toEqual({ ok: true, firstSeen: true });
  });

  it("accepts the same leaf again", () => {
    expect(checkPeerPin("desk:4778", { keyFingerprint: leaf }, { "desk:4778": "112233" })).toEqual({ ok: true, firstSeen: false });
  });

  it("refuses a different leaf for a pinned peer", () => {
    const r = checkPeerPin("desk:4778", { keyFingerprint: leaf }, { "desk:4778": "99:88:77" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pinned/);
  });

  it("accepts a renewal: the key is unchanged, so the pin still matches", () => {
    // Renewal keeps the key and changes the certificate, so a key pin survives rotation (v4-6 §5 B).
    const pins = { "desk:4778": "11:22:33" };
    expect(checkPeerPin("desk:4778", { keyFingerprint: "11:22:33", certFingerprint: "FF:EE" }, pins)).toEqual({
      ok: true,
      firstSeen: false,
    });
  });

  it("accepts a pin recorded before the switch that named the certificate fingerprint, and upgrades it", () => {
    // Existing networks upgraded in place: their pin is a certificate fingerprint. While that leaf is
    // unchanged it must still be accepted, otherwise the upgrade itself locks everyone out. The key is
    // reported as `upgrade` so the caller rewrites the pin before the leaf next rotates.
    const pins = { "desk:4778": "AB:CD:EF" };
    expect(checkPeerPin("desk:4778", { keyFingerprint: "11:22:33", certFingerprint: "AB:CD:EF" }, pins)).toEqual({
      ok: true,
      firstSeen: false,
      upgrade: "11:22:33",
    });
  });

  it("names a command that exists when it refuses", () => {
    const r = checkPeerPin("desk:4778", { keyFingerprint: "11:22:33" }, { "desk:4778": "99:88:77" });
    expect(r.reason).toMatch(/cafe host pin/);
  });
});