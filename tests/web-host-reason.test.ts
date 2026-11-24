import { describe, expect, it } from "vitest";
import { dictFor } from "../packages/web/src/i18n.ts";
import { hostFailure, hostStatus, savedAddressNote } from "../packages/web/src/hostReason.ts";

// #83: the Network page showed "Unreachable: fetch failed" for every cause, and "Address saved"
// even when the Root had just failed to reach the new address.
describe("Network page host diagnostics (#83)", () => {
  const zh = dictFor("zh");
  const en = dictFor("en");

  it("explains a refused connection in plain language, with the code for troubleshooting", () => {
    const text = hostFailure(zh, { code: "ECONNREFUSED", error: "connection refused (ECONNREFUSED): …" });
    expect(text).toContain("Docker");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain("fetch failed");
    expect(hostFailure(en, { code: "ECONNREFUSED", error: "x" })).toMatch(/Docker/);
  });

  it("covers the other common causes", () => {
    for (const code of ["ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "UNAUTHORIZED"]) {
      expect(hostFailure(en, { code, error: "raw" })).not.toBe(`${en.hostUnreachable}: raw`);
    }
    expect(hostFailure(en, { code: "CERT_HAS_EXPIRED", error: "raw" })).toMatch(/certificate/i);
  });

  it("falls back to the daemon's own message for an unknown cause", () => {
    expect(hostFailure(en, { error: "HTTP 502" })).toBe(`${en.hostUnreachable}: HTTP 502`);
  });

  it("does not say plainly 'saved' when the Root could not reach the new address", () => {
    const bad = savedAddressNote(zh, { verified: false, code: "ECONNREFUSED", error: "…" });
    expect(bad.ok).toBe(false);
    expect(bad.text).not.toBe(zh.hostAddressSaved);
    expect(bad.text).toContain("Docker");
    expect(savedAddressNote(zh, { verified: true })).toEqual({ text: zh.hostAddressSaved, ok: true });
    // An older daemon without the field: keep the previous wording.
    expect(savedAddressNote(zh, {})).toEqual({ text: zh.hostAddressSaved, ok: true });
  });
});

// #89 and #83 (4): "online" means the machine is connected to the hub; a machine whose plaintext
// connection the TLS hub refused says so, with what to do, instead of looking merely offline.
describe("Network page host status", () => {
  const zh = dictFor("zh");
  const en = dictFor("en");
  it("names a refused plaintext machine and how to fix it", () => {
    const s = hostStatus(zh, { online: false, refused: { reason: "plaintext", at: 1 } }, "ssh1");
    expect(s.tone).toBe("danger");
    expect(s.label).toBe(zh.hostRefused);
    expect(s.detail).toContain("ssh1");
    expect(s.detail).toContain("cafe config set security.mode tls");
  });
  it("keeps online and offline plain, and explains what online means", () => {
    expect(hostStatus(en, { online: true }, "pc1")).toMatchObject({ tone: "ok", label: en.online, title: en.onlineHint });
    expect(hostStatus(en, { online: false }, "pc1")).toMatchObject({ tone: undefined, label: en.mOffline });
    expect(hostStatus(en, { online: false }, "pc1").detail).toBeUndefined();
  });
});
