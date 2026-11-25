import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generateCa, issueLeaf, localAddresses, missingSans, sanList } from "../packages/daemon/src/tls/certs.ts";
import { startDaemon, waitFor } from "./helpers.ts";

// Made-up addresses come from 192.0.2.0/24 (TEST-NET-1, RFC 5737). A real one (a tester's VPN
// address) made "the leaf lacks this address" fail on the one machine that has it.

/**
 * #91: a machine with more than one network (office LAN + VPN, a Docker bridge) is dialled on any of
 * them, but the leaf named only the first interface. A child that could only reach the Root over the
 * VPN failed with "IP address mismatch" while `cafe doctor` said `ok`.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const sanOf = (pem: string): string => new X509Certificate(pem).subjectAltName ?? "";
const TLS = (extra: Record<string, unknown> = {}) => ({ security: { mode: "tls", tls: { port: 0, ...extra } } });

// The shape `os.networkInterfaces()` returns, trimmed to what matters.
const ni = (address: string, family: "IPv4" | "IPv6", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null });

describe("every local address is a SAN", () => {
  it("lists every non-internal IPv4 address, not just the first", () => {
    const addrs = localAddresses({
      lo0: [ni("127.0.0.1", "IPv4", true), ni("::1", "IPv6", true)],
      en0: [ni("fe80::1", "IPv6"), ni("192.168.3.132", "IPv4")],
      utun5: [ni("192.0.2.85", "IPv4")],
    } as never);
    expect(addrs).toEqual(["192.168.3.132", "192.0.2.85"]);
  });

  it("puts all of them, plus configured extra names, into the SAN list once each", () => {
    const sans = sanList({ host: "desk", advertise: "192.168.3.132:4777", lan: ["192.168.3.132", "192.0.2.85"], extra: ["desk.vpn.example", "192.0.2.85"] });
    expect(sans).toEqual(expect.arrayContaining(["desk", "192.168.3.132", "192.0.2.85", "desk.vpn.example", "127.0.0.1", "localhost"]));
    expect(new Set(sans).size).toBe(sans.length);
  });

  it("names the addresses a leaf does not cover", async () => {
    const ca = await generateCa();
    const leaf = await issueLeaf(ca, ["desk", "192.168.3.132", "127.0.0.1", "localhost"], 90);
    expect(missingSans(leaf.cert, ["desk", "192.168.3.132", "192.0.2.85"])).toEqual(["192.0.2.85"]);
  }, 30_000);
});

describe("a running Daemon keeps its leaf in step with its addresses", () => {
  it("issues the boot leaf for security.tls.sans too", async () => {
    const root = await startDaemon("sansroot", { mode: "root", config: TLS({ sans: ["192.0.2.85"] }) });
    cleanup.push(root.stop);
    expect(sanOf(root.daemon.tlsContext!.current().cert)).toContain("IP Address:192.0.2.85");
  }, 30_000);

  it("doctor names an address the leaf misses instead of reporting ok", async () => {
    const root = await startDaemon("sansdoc", { mode: "root", config: TLS() });
    cleanup.push(root.stop);
    expect(root.daemon.doctor().checks.find((c) => c.name === "tls")?.level).toBe("ok");
    // A VPN came up (or a person added a name) after the leaf was issued.
    root.daemon.config.security.tls.sans = ["192.0.2.85"];
    const tls = root.daemon.doctor().checks.find((c) => c.name === "tls");
    expect(tls?.level).toBe("warn");
    expect(tls?.detail).toContain("192.0.2.85");
    expect(tls?.next).toContain("cafe daemon renew-cert");
  }, 30_000);

  it("reissues the leaf in place when a new address appears, keeping its key", async () => {
    const root = await startDaemon("sansdrift", { mode: "root", config: TLS(), timing: { leafCheckIntervalMs: 150 } });
    cleanup.push(root.stop);
    const before = root.daemon.tlsContext!.current().cert;
    root.daemon.config.security.tls.sans = ["192.0.2.85"];
    await waitFor(() => sanOf(root.daemon.tlsContext!.current().cert).includes("IP Address:192.0.2.85"), 10_000);
    const after = root.daemon.tlsContext!.current().cert;
    expect(new X509Certificate(after).publicKey.export({ type: "spki", format: "der" })).toEqual(new X509Certificate(before).publicKey.export({ type: "spki", format: "der" }));
    expect(root.daemon.doctor().checks.find((c) => c.name === "tls")?.level).toBe("ok");
  }, 30_000);

  it("a child renews through its Root when asked over the API", async () => {
    const root = await startDaemon("sansparent", { mode: "root", config: TLS() });
    cleanup.push(root.stop);
    const child = await startDaemon("sanschild", { config: { ...TLS(), root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 15_000);
    const res = await fetch(`http://${child.addr}/api/tls/renew`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t0k" },
      body: JSON.stringify({ sans: ["sanschild", "10.20.30.40", "127.0.0.1", "localhost"] }),
    });
    expect(res.status).toBe(200);
    expect(sanOf(child.daemon.tlsContext!.current().cert)).toContain("IP Address:10.20.30.40");
  }, 40_000);
});

describe("cafe daemon renew-cert --san", () => {
  it("records the extra name in security.tls.sans and puts it into the leaf", async () => {
    const h = mkdtempSync(join(tmpdir(), "cafe-sans-cli-"));
    cleanup.push(() => rmSync(h, { recursive: true, force: true }));
    writeFileSync(join(h, "config.yml"), `host: desk\nport: 47831\ntoken: t0k\nmode: root\nsecurity:\n  mode: tls\n  tls:\n    port: 47832\n`);
    const ca = await generateCa();
    mkdirSync(join(h, "tls"), { recursive: true });
    writeFileSync(join(h, "tls", "ca.crt"), ca.cert);
    writeFileSync(join(h, "tls", "ca.key"), ca.key);
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "packages", "cli", "bin", "cafe.js"), "daemon", "renew-cert", "--san", "192.0.2.85", "--san", "desk.vpn.example"], {
      env: { ...process.env, CAFE_HOME: h, CAFE_DISCOVERY: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(parse(readFileSync(join(h, "config.yml"), "utf8")).security.tls.sans).toEqual(["192.0.2.85", "desk.vpn.example"]);
    const san = sanOf(readFileSync(join(h, "tls", "desk.crt"), "utf8"));
    expect(san).toContain("IP Address:192.0.2.85");
    expect(san).toContain("DNS:desk.vpn.example");
  }, 30_000);
});
