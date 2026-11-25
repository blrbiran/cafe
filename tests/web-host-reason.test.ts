import { describe, expect, it } from "vitest";
import { dictFor } from "../packages/web/src/i18n.ts";
import { hostFailure, hostStatus, savedAddressNote, testNote } from "../packages/web/src/hostReason.ts";

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

// #92: a machine whose uplink is up was "online" in its card and "unreachable" under Test.
describe("Test connection result (#92)", () => {
  const zh = dictFor("zh");
  const en = dictFor("en");

  it("says a machine reached through its uplink is online, and names the address that failed", () => {
    const n = testNote(zh, { online: true, via: "uplink", address: "172.17.0.24:4777", code: "ETIMEDOUT", error: "timed out" });
    expect(n.tone).toBe("warn");
    expect(n.text).toContain("在线");
    expect(n.text).toContain("172.17.0.24:4777");
    expect(n.text).toContain("ETIMEDOUT");
    expect(testNote(en, { online: true, via: "uplink", address: "a:1", error: "x" }).text).toMatch(/^Online/);
  });

  it("keeps the plain wording for a direct success and a real failure", () => {
    expect(testNote(en, { online: true, via: "direct", latencyMs: 3 })).toEqual({ text: `${en.hostReachable} · 3ms`, tone: "ok" });
    expect(testNote(en, { online: true, latencyMs: 0 })).toEqual({ text: `${en.hostReachable} · 0ms`, tone: "ok" });
    expect(testNote(en, { online: false, code: "ECONNREFUSED", error: "x" })).toEqual({ text: hostFailure(en, { code: "ECONNREFUSED", error: "x" }), tone: "danger" });
  });
});

// v4-8: the Network page offers "Remove" only for an offline machine, on the hub, never for this machine
// or a refused plaintext Host (its next attempt would recreate the card at once).
import { canForget, forgetNote } from "../packages/web/src/hostReason.ts";

describe("Network page: remove an offline machine (v4-8)", () => {
  const zh = dictFor("zh");
  const en = dictFor("en");
  it("is offered only for an offline, non-refused machine on the hub", () => {
    expect(canForget({ online: false }, { isThis: false, isRoot: true })).toBe(true);
    expect(canForget({ online: true }, { isThis: false, isRoot: true })).toBe(false);
    expect(canForget({ online: false }, { isThis: true, isRoot: true })).toBe(false);
    expect(canForget({ online: false }, { isThis: false, isRoot: false })).toBe(false);
    expect(canForget({ online: false, refused: { reason: "plaintext", at: 1 } }, { isThis: false, isRoot: true })).toBe(false);
  });
  it("says plainly what removing does and how to keep a machine out", () => {
    expect(zh.hostForgetConfirm("ssh9")).toBe("移除 ssh9？");
    expect(zh.hostForgetExplain).toContain("对话记录保留");
    expect(zh.hostForgetExplain).toContain("cafe config set token");
    expect(en.hostForgetExplain).toContain("conversations are kept");
    expect(forgetNote(zh, { host: "ssh9", agents: 2 })).toEqual({ text: "已移除 ssh9（2 个 Agent）", ok: true });
    expect(forgetNote(en, { host: "ssh9", agents: 1 })).toEqual({ text: "Removed ssh9 (1 agent)", ok: true });
  });
});
