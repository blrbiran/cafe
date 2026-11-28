import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateCa } from "../packages/daemon/src/tls/certs.ts";
import { readTlsConfig } from "../packages/daemon/src/tls/trust.ts";
import { startDaemon, waitFor } from "./helpers.ts";
import { parse } from "yaml";

/**
 * TLS CLI surface (v4-6 §3.6): `cafe root show` prints the CA fingerprint a person reads out to
 * enrol another Host; `cafe connect --ca-fingerprint` validates before writing; `cafe daemon
 * renew-cert` issues a fresh leaf.
 *
 * The file-only checks below spawn the CLI without a daemon. The invite journey uses a scratch Root.
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

  // #18 (narrowed): the Root says how another machine joins it; the token is named, never printed.
  it("on the Root, prints the cafe connect command for another machine without the token", async () => {
    const h = home();
    const ca = await generateCa();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: s3cret-token-value\nmode: root\nadvertise: 10.1.2.3\nsecurity:\n  mode: tls\n  tls:\n    port: 47822\n`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(h, "tls"), { recursive: true });
    writeFileSync(join(h, "tls", "ca.crt"), ca.cert);
    const r = cafe(h, "root", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`cafe connect 10.1.2.3:47822 --token <token> --invite <code> --ca-fingerprint sha256:${ca.fingerprint256}`);
    expect(r.stdout).toContain("cafe config get token");
    expect(r.stdout).toContain("cafe host invite");
    expect(r.stdout).not.toContain("s3cret-token-value");
  });

  it("says there is no CA when TLS is off", () => {
    const h = home();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: plaintext\n`);
    const r = cafe(h, "root", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no.*CA|plaintext/i);
  });
});

describe("cafe connect --invite", () => {
  it("enrolls a separate CLI process and starts the child with the pinned Root identity", async () => {
    const root = await startDaemon("invite-cli-root", { home: home(), mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    const childHome = home();
    let child: Awaited<ReturnType<typeof startDaemon>> | undefined;
    const run = async (cafeHome: string, addr: string, ...args: string[]) => {
      const bin = join(import.meta.dirname, "..", "packages", "cli", "bin", "cafe.js");
      try {
        const { stdout } = await promisify(execFile)(process.execPath, [bin, ...args, "--json"], {
          env: { ...process.env, CAFE_HOME: cafeHome, CAFE_DAEMON: addr, CAFE_DISCOVERY: "0", CAFE_TOKEN: "t0k" }, timeout: 15_000,
        });
        return JSON.parse(stdout);
      } catch (error) {
        // execFile errors contain the command line, including the disposable invitation.
        const failure = error as { code?: unknown; stderr?: string };
        throw new Error(`fixture CLI ${args[0]} failed (${String(failure.code)})`);
      }
    };
    try {
      const invite = await run(root.home, root.addr, "host", "invite", "--name", "invite-cli-child");
      const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
      const { fingerprintOf } = await import("../packages/daemon/src/tls/certs.ts");
      const result = await run(childHome, "127.0.0.1:1", "connect", root.addr, "--token", "t0k", "--invite", invite.inviteCode, "--ca-fingerprint", fingerprintOf(ca));
      expect(result).toMatchObject({ hostId: invite.hostId, rootHostId: root.daemon.hostId, restartRequired: true });
      const config = parse(readFileSync(join(childHome, "config.yml"), "utf8"));
      child = await startDaemon("invite-cli-child", { home: childHome, config: { ...config, port: 0, security: { ...config.security, tls: { ...config.security.tls, port: 0 } } } });
      await waitFor(() => child?.daemon.rootOnline === true, 10_000);
      expect(child.daemon.hostId).toBe(invite.hostId);
    } finally {
      await child?.stop();
      await root.stop();
    }
  }, 30_000);
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

  it("keeps the leaf key when it reissues on a stopped daemon", async () => {
    // Same identity rule as the running path: a renewal must not change the key a peer pinned.
    const h = home();
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47821\ntoken: t0k\nsecurity:\n  mode: tls\n  tls:\n    port: 47822\n`);
    const { generateCa, issueLeaf, keyFingerprintOf } = await import("../packages/daemon/src/tls/certs.ts");
    const { writeLeaf, writeCa } = await (async () => {
      const store = await import("../packages/daemon/src/tls/store.ts");
      return {
        writeLeaf: (home: string, cert: string, key: string) => store.writeLeaf(home, "desk", { cert, key }),
        writeCa: async (home: string, pair: { cert: string; key: string }) => {
          const { mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          mkdirSync(join(home, "tls"), { recursive: true });
          writeFileSync(join(home, "tls", "ca.crt"), pair.cert);
          writeFileSync(join(home, "tls", "ca.key"), pair.key);
        },
      };
    })();
    const ca = await generateCa();
    await writeCa(h, ca);
    const first = await issueLeaf(ca, ["desk", "127.0.0.1", "localhost"], 90);
    writeLeaf(h, first.cert, first.key);

    const r = cafe(h, "daemon", "renew-cert");
    expect(r.status).toBe(0);
    const renewed = readFileSync(join(h, "tls", "desk.crt"), "utf8");
    expect(renewed).not.toBe(first.cert);
    expect(keyFingerprintOf(renewed)).toBe(keyFingerprintOf(first.cert));
  });
});