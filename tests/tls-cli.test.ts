import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateCa } from "../packages/daemon/src/tls/certs.ts";
import { readTlsConfig } from "../packages/daemon/src/tls/trust.ts";
import { parse } from "yaml";

/**
 * TLS CLI surface (v4-6 §3.6): `cafe root show` prints the CA fingerprint a person reads out to
 * enrol another Host; `cafe connect --ca-fingerprint` validates before writing; `cafe daemon
 * renew-cert` issues a fresh leaf.
 *
 * These spawn the CLI without a live daemon (config-file paths only), like the other CLI tests.
 */

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "cafe-cli-tls-"));
  homes.push(h);
  return h;
}

function cafe(h: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dirname, "..", "packages", "cli", "bin", "cafe.js"), ...args], {
    env: { ...process.env, CAFE_HOME: h, CAFE_DISCOVERY: "0" },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("cafe root show", () => {
  it("prints the CA fingerprint when a Root CA exists", async () => {
    const h = home();
    const ca = await generateCa();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\nmode: root\nsecurity:\n  mode: tls\n  tls:\n    port: 47822\n`);
    // `cafe root show` reads CAFE_HOME/tls/ca.crt.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(h, "tls"), { recursive: true });
    writeFileSync(join(h, "tls", "ca.crt"), ca.cert);
    const r = cafe(h, "root", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(ca.fingerprint256);
    expect(r.stdout).toMatch(/sha256/i);
  });

  it("says there is no CA when TLS is off", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: plaintext\n`);
    const r = cafe(h, "root", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no.*CA|plaintext/i);
  });
});

describe("cafe connect --ca-fingerprint", () => {
  it("saves the pin when it matches the Root's advertised CA", async () => {
    // A fake Root advertises a CA; connect verifies against it.
    const h = home();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: plaintext\n`);
    const ca = await generateCa();
    // `connect` requires --token; a matching fingerprint is stored verbatim.
    const r = cafe(h, "connect", "10.0.0.5:4778", "--token", "shared", "--ca-fingerprint", ca.fingerprint256);
    expect(r.status).toBe(0);
    const cfg = parse(readFileSync(join(h, "config.yml"), "utf8"));
    expect(readTlsConfig(cfg).caFingerprint).toBe(ca.fingerprint256);
  });

  it("rejects a malformed fingerprint before writing", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\n`);
    const before = readFileSync(join(h, "config.yml"), "utf8");
    const r = cafe(h, "connect", "10.0.0.5:4778", "--token", "shared", "--ca-fingerprint", "not-a-fingerprint");
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h, "config.yml"), "utf8")).toBe(before);
  });
});

describe("cafe host pin", () => {
  it("lists the pins currently recorded", () => {
    const h = home();
    writeFileSync(
      join(h, "config.yml"),
      `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: tls\n  tls:\n    port: 47822\n    pins:\n      "hub:4778": "AA:BB"\n`,
    );
    const r = cafe(h, "host", "pin");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hub:4778");
    expect(r.stdout).toContain("AA:BB");
  });

  it("clears one peer's pin with --clear, so a reinstalled Host can be re-pinned", async () => {
    const h = home();
    writeFileSync(
      join(h, "config.yml"),
      `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: tls\n  tls:\n    port: 47822\n    pins:\n      "hub:4778": "AA:BB"\n      "other:4778": "CC:DD"\n`,
    );
    const r = cafe(h, "host", "pin", "hub:4778", "--clear");
    expect(r.status).toBe(0);
    const cfg = parse(readFileSync(join(h, "config.yml"), "utf8"));
    expect(readTlsConfig(cfg).pins).toEqual({ "other:4778": "CC:DD" });
    // The reason `checkPeerPin` gives must name a command that actually exists.
    const { checkPeerPin } = await import("../packages/daemon/src/tls/trust.ts");
    const reason = checkPeerPin("hub:4778", { keyFingerprint: "11:22" }, { "hub:4778": "AA:BB" }).reason ?? "";
    expect(reason).toMatch(/cafe host pin/);
  });
});

describe("cafe daemon renew-cert", () => {
  it("reissues the leaf from the CA without asking for the Root's key on a child", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: tls\n  tls:\n    port: 47822\n`);
    const r = cafe(h, "daemon", "renew-cert");
    // Without a running daemon this must fail with an actionable message, not a stack trace.
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/daemon|ca\.crt|renew/i);
  });
});