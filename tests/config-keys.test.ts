import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../packages/daemon/src/config.ts";

/**
 * #94: `cafe config set security.tls.port 4999` was saved, but `cafe config get security.tls.port`
 * said "unknown config key": the key list stopped two levels down. The two commands must accept the
 * same keys, and a misspelt key must still fail with suggestions.
 */

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "cafe-keys-"));
  homes.push(h);
  writeFileSync(join(h, "config.yml"), `host: desk\nport: 47841\ntoken: t0k\nsecurity:\n  mode: tls\n  tls:\n    port: 4778\n    caFingerprint: "7F:88:C0:39"\n`);
  return h;
}

function cafe(h: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dirname, "..", "packages", "cli", "bin", "cafe.js"), ...args], {
    env: { ...process.env, CAFE_HOME: h, CAFE_DISCOVERY: "0", CAFE_DAEMON: "127.0.0.1:1" },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("config keys reach every leaf (#94)", () => {
  it("lists third-level keys", () => {
    expect(CONFIG_KEYS).toEqual(expect.arrayContaining(["security.tls.port", "security.tls.caFingerprint", "security.tls.pins", "security.tls.sans", "router.model"]));
  });

  it("reads the TLS keys that config set writes", () => {
    const h = home();
    expect(cafe(h, "config", "get", "security.tls.port").stdout.trim()).toBe("4778");
    expect(cafe(h, "config", "get", "security.tls.caFingerprint").stdout.trim()).toBe("7F:88:C0:39");
    expect(JSON.parse(cafe(h, "config", "get", "security.tls.pins", "--json").stdout)).toEqual({});
  });

  it("every listed key can be read", () => {
    const h = home();
    for (const key of CONFIG_KEYS) {
      const r = cafe(h, "config", "get", key, "--json");
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  }, 120_000);

  it("a misspelt key still fails, with suggestions", () => {
    const h = home();
    const r = cafe(h, "config", "get", "security.tls.prot");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown config key 'security.tls.prot'");
    expect(r.stderr).toContain("security.tls.port");
  });

  it("config set refuses a key config get would not know, instead of saving nothing", () => {
    const h = home();
    const before = readFileSync(join(h, "config.yml"), "utf8");
    const r = cafe(h, "config", "set", "security.tls.prot", "4999");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("security.tls.port");
    expect(readFileSync(join(h, "config.yml"), "utf8")).toBe(before);
  });
});

describe("cafe root show before this Host has the network CA (#94)", () => {
  it("prints the fingerprint it expects, so doctor's 'compare the CA fingerprint' can be done", () => {
    const h = home();
    const r = cafe(h, "root", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("7F:88:C0:39");
    expect(r.stdout).toMatch(/not .*joined|has not joined/i);
  });
});
