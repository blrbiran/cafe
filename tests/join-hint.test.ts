import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

// #18 (narrowed): the Web does not edit the token (rotating it drops every child at once). Instead the
// Root's Settings shows how to add another machine: its main address and CA fingerprint. The token itself
// never leaves the API (safe-by-default); the hint says where to read it.
//
// Own file: a TLS Daemon adds its CA to the process-wide trust store.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const settings = async (addr: string) => {
  const res = await fetch(`http://${addr}/api/settings`);
  return { text: await res.clone().text(), body: (await res.json()) as { join?: { address: string; caFingerprint?: string } } };
};

describe("Settings shows how to join this Root", () => {
  it("gives the Root's main address and CA fingerprint, never the token", async () => {
    const root = await startDaemon("jroot", { mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const { text, body } = await settings(root.addr);
    expect(body.join).toEqual({ address: `127.0.0.1:${root.server.port}`, addresses: [`127.0.0.1:${root.server.port}`], advertised: true, caFingerprint: `sha256:${root.daemon.tlsStatus().caFingerprint}` });
    expect(text).not.toContain("t0k");
  }, 30_000);

  it("has no CA fingerprint in plaintext mode and no join hint on a child", async () => {
    const root = await startDaemon("proot", { mode: "root" });
    cleanup.push(root.stop);
    expect((await settings(root.addr)).body.join).toEqual({ address: `127.0.0.1:${root.server.port}`, addresses: [`127.0.0.1:${root.server.port}`], advertised: true });
    const child = await startDaemon("pchild", { config: { root: root.addr } });
    cleanup.push(child.stop);
    expect((await settings(child.addr)).body.join).toBeUndefined();
  }, 30_000);
});

// #95: a Root with several interfaces (LAN + VPN) is reached at a different address from each network.
// Offer every candidate unless the person set `advertise`, and the leaf must name all of them (#91).
import { joinAddresses } from "../packages/daemon/src/daemon.ts";
import { sanList } from "../packages/daemon/src/tls/certs.ts";

describe("join addresses on a multi-interface Root (#95)", () => {
  it("lists every local IPv4 address when advertise is not set, and the leaf names each", () => {
    const lan = ["192.168.3.132", "192.0.2.85"];
    expect(joinAddresses({ port: 4777, lan })).toEqual({ addresses: ["192.168.3.132:4777", "192.0.2.85:4777"], advertised: false });
    const sans = sanList({ host: "root", lan });
    for (const ip of lan) expect(sans).toContain(ip);
  });

  it("gives only the advertised address when advertise is set", () => {
    expect(joinAddresses({ port: 4777, lan: ["192.168.3.132", "192.0.2.85"], advertise: "cafe.lan" })).toEqual({ addresses: ["cafe.lan:4777"], advertised: true });
  });

  it("keeps the single-interface case unchanged", () => {
    expect(joinAddresses({ port: 4777, lan: ["192.168.3.132"] })).toEqual({ addresses: ["192.168.3.132:4777"], advertised: false });
    expect(joinAddresses({ port: 4777, lan: [] })).toEqual({ addresses: ["127.0.0.1:4777"], advertised: false });
  });
});
