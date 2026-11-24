import { describe, expect, it } from "vitest";
import { dictFor } from "../packages/web/src/i18n.ts";
import { hostFailure, savedAddressNote } from "../packages/web/src/hostReason.ts";

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
