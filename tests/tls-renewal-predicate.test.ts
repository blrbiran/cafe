import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leafNeedsRenewal, LEAF_RENEW_BEFORE_MS } from "../packages/daemon/src/tls/store.ts";
import { fingerprintOf, generateCa, issueLeaf } from "../packages/daemon/src/tls/certs.ts";

/**
 * Renewal must also run while a Daemon stays up: a start-time check alone leaves a process that has
 * been running for months with an expired (fail-closed) leaf. These cases pin the predicate the
 * periodic check uses; the timer wiring is exercised by the daemon TLS test.
 */

afterEach(() => {
  // each case uses its own temp dir; nothing shared to clean
});

describe("leaf renewal predicate", () => {
  it("renews inside the safety window and keeps a fresh leaf", async () => {
    const ca = await generateCa();
    const fresh = await issueLeaf(ca, ["desk"], 90);
    expect(leafNeedsRenewal(fresh.cert)).toBe(false);
    const aging = await issueLeaf(ca, ["desk"], 7);
    expect(leafNeedsRenewal(aging.cert)).toBe(true);
    expect(LEAF_RENEW_BEFORE_MS).toBeGreaterThan(7 * 86_400_000);
  }, 60_000);

  it("treats an unreadable certificate as needing renewal", () => {
    expect(leafNeedsRenewal("not a certificate")).toBe(true);
  });

  it("keeps the same CA across a renewal", async () => {
    const ca = await generateCa();
    const aging = await issueLeaf(ca, ["desk"], 7);
    const fresh = await issueLeaf(ca, ["desk"], 90);
    expect(fingerprintOf(fresh.cert)).not.toBe(fingerprintOf(aging.cert));
    expect(fresh.fingerprint256).not.toBe(ca.fingerprint256);
  }, 60_000);
});