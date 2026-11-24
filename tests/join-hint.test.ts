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
    expect(body.join).toEqual({ address: `127.0.0.1:${root.server.port}`, caFingerprint: `sha256:${root.daemon.tlsStatus().caFingerprint}` });
    expect(text).not.toContain("t0k");
  }, 30_000);

  it("has no CA fingerprint in plaintext mode and no join hint on a child", async () => {
    const root = await startDaemon("proot", { mode: "root" });
    cleanup.push(root.stop);
    expect((await settings(root.addr)).body.join).toEqual({ address: `127.0.0.1:${root.server.port}` });
    const child = await startDaemon("pchild", { config: { root: root.addr } });
    cleanup.push(child.stop);
    expect((await settings(child.addr)).body.join).toBeUndefined();
  }, 30_000);
});
