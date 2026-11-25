import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, waitFor } from "./helpers.ts";

/**
 * #92: on a TLS network the Root showed a connected child as `online` with a plaintext, stale address
 * (`ws://<old container IP>:4777` left in `knownDaemons`), and "Test connection" failed on it. Pins
 * were turned into `ws://`, clearing a pin fell back to the stale entry, and that entry was also what
 * the other children learned.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const TLS = { security: { mode: "tls", tls: { port: 0 } } };
const STALE = "ws://10.255.255.9:4777";

async function network() {
  // The Root remembers an address the child had long ago (a container IP), in plaintext form.
  const root = await startDaemon("addrroot", { mode: "root", config: { ...TLS, knownDaemons: { c1: STALE } } });
  cleanup.push(root.stop);
  // The child is reachable from the Root only through its uplink: the address it reports is not.
  const c1 = await startDaemon("c1", { config: { ...TLS, root: root.addr, advertise: "10.255.255.1" } });
  cleanup.push(c1.stop);
  await waitFor(() => root.daemon.daemons().some((d) => d.host === "c1" && d.online), 15_000);
  return { root, c1 };
}

const urlOf = (d: { daemon: { daemons(): Array<{ host: string; url: string }> } }, host: string) => d.daemon.daemons().find((x) => x.host === host)?.url;

describe("Daemon addresses on a TLS network (#92)", () => {
  it("never hands a stale plaintext address to the other children", async () => {
    const { root } = await network();
    const c2 = await startDaemon("c2", { config: { ...TLS, root: root.addr } });
    cleanup.push(c2.stop);
    await waitFor(() => c2.daemon.rootOnline, 15_000);
    await new Promise((r) => setTimeout(r, 400));
    expect(c2.daemon.peerUrlFor("c1") ?? "").not.toBe(STALE);
    expect(urlOf(root, "c1")).toMatch(/^wss:\/\//);
  }, 40_000);

  it("shows a pinned address as the TLS endpoint, not ws://", async () => {
    const { root, c1 } = await network();
    const r = await root.daemon.setHostAddress("c1", c1.addr);
    expect(r.verified).toBe(true);
    expect(urlOf(root, "c1")).toBe(`wss://127.0.0.1:${c1.server.tlsPort}`);
    expect(root.daemon.config.knownDaemons.c1).toBe(`wss://127.0.0.1:${c1.server.tlsPort}`);
  }, 40_000);

  it("clearing a pin goes back to what the child reports, not a stale remembered address", async () => {
    const { root, c1 } = await network();
    const reported = urlOf(root, "c1");
    expect(reported).toMatch(/^wss:\/\/10\.255\.255\.1:/);
    await root.daemon.setHostAddress("c1", "10.255.255.7:4777");
    await root.daemon.setHostAddress("c1", null);
    expect(urlOf(root, "c1")).toBe(reported);
    void c1;
  }, 40_000);

  it("Test reports a child whose uplink is up as online, and says the direct address failed", async () => {
    const { root } = await network();
    const r = await root.daemon.testHost("c1");
    expect(r.online).toBe(true);
    expect(r.via).toBe("uplink");
    expect(r.error).toBeTruthy();
    expect(r.address).toMatch(/10\.255\.255\.1/);
  }, 40_000);
});
