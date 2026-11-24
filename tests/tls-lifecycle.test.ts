import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateCa, issueLeaf } from "../packages/daemon/src/tls/certs.ts";
import { ensureLeaf, readLeaf } from "../packages/daemon/src/tls/store.ts";

/**
 * A 90-day leaf with no renewal path expires and leaves a fail-closed fleet that refuses every
 * connection (v4-6 §5 B). `ensureLeaf` only reissued when the SAN set changed, so a restart did not
 * renew an expiring leaf either. Renewal must also happen before the expiry, not after it.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

const daysLeft = (pem: string): number => (Date.parse(new X509Certificate(pem).validTo) - Date.now()) / 86_400_000;

describe("leaf lifecycle", () => {
  it("reissues a leaf that is too close to expiry even when its SANs still match", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-lifecycle-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const ca = await generateCa();
    // Simulate a leaf issued long ago: 3 days of validity left (below any sane renewal margin).
    const aging = await issueLeaf(ca, ["desk", "127.0.0.1", "localhost"], 3);
    // Write it where `ensureLeaf` looks, so the only reason to reissue is the expiry.
    const { tlsPaths, writeLeaf } = await import("../packages/daemon/src/tls/store.ts");
    const paths = tlsPaths(home, "desk");
    writeLeaf(home, "desk", { cert: aging.cert, key: aging.key });

    const next = await ensureLeaf(home, "desk", ca, { host: "desk", lan: "127.0.0.1" });
    expect(next.cert).not.toBe(aging.cert);
    expect(daysLeft(next.cert)).toBeGreaterThan(80);
    // The file on disk is the renewed leaf, so a restart without the CA key still has a good one.
    expect(readFileSync(paths.leafCertPath, "utf8")).toBe(next.cert);
  }, 60_000);

  it("keeps a healthy leaf instead of reissuing on every start", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-lifecycle-ok-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const ca = await generateCa();
    const first = await ensureLeaf(home, "desk", ca, { host: "desk", lan: "127.0.0.1" });
    const again = await ensureLeaf(home, "desk", ca, { host: "desk", lan: "127.0.0.1" });
    expect(again.cert).toBe(first.cert);
  }, 60_000);

  it("reissues a leaf that a different CA signed, even when its SANs and expiry are fine", async () => {
    // A Host that booted on a temporary local CA (its Root was unreachable), then enrolled the real
    // CA, keeps a leaf no peer will accept — fail-closed, and restarting used to change nothing
    // because only the SAN set and the expiry were checked. The leaf must be replaced.
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-lifecycle-ca-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const stranger = await generateCa();
    const real = await generateCa();
    const staging = await issueLeaf(stranger, ["desk", "127.0.0.1", "localhost"], 90);
    const { writeLeaf } = await import("../packages/daemon/src/tls/store.ts");
    writeLeaf(home, "desk", { cert: staging.cert, key: staging.key });

    const next = await ensureLeaf(home, "desk", real, { host: "desk", lan: "127.0.0.1" });
    expect(next.cert).not.toBe(staging.cert);
    expect(new X509Certificate(next.cert).checkIssued(new X509Certificate(real.cert))).toBe(true);
    // Same key: replacing the issuer must not change the identity a peer may have pinned.
    expect(new X509Certificate(next.cert).publicKey.export({ type: "spki", format: "der" }).equals(
      new X509Certificate(staging.cert).publicKey.export({ type: "spki", format: "der" }),
    )).toBe(true);
  }, 60_000);

  it("renews with no CA key by asking the issuer (a child Host)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-tls-lifecycle-fetch-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const ca = await generateCa();
    // A child: CA certificate only, no key. Its leaf is near expiry.
    const caNoKey = { cert: ca.cert, key: "", fingerprint256: ca.fingerprint256 };
    const aging = await issueLeaf(ca, ["child", "127.0.0.1", "localhost"], 2);
    const { readLeaf: reread, writeLeaf } = await import("../packages/daemon/src/tls/store.ts");
    writeLeaf(home, "child", { cert: aging.cert, key: aging.key });

    const fresh = await issueLeaf(ca, ["child", "127.0.0.1", "localhost"], 90);
    let asked = 0;
    const next = await ensureLeaf(home, "child", caNoKey, { host: "child", lan: "127.0.0.1" }, {
      fetchLeaf: async () => {
        asked++;
        return { cert: fresh.cert, key: fresh.key };
      },
    });
    expect(asked).toBe(1);
    expect(next.cert).toBe(fresh.cert);
    expect(readLeaf(home, "child")?.cert).toBe(fresh.cert);
  }, 60_000);
});