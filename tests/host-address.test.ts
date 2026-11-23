import { afterEach, describe, expect, it } from "vitest";
import { barista, identity, startDaemon, waitFor } from "./helpers.ts";

// #75: the Root took a child's self-reported address as the only truth, so a Docker/container address
// could never be corrected from the Root side and was broadcast to every child as the direct-link target.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function post(addr: string, path: string, body: unknown) {
  const res = await fetch(`http://${addr}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

describe("host address overrides (#75)", () => {
  it("lets the Root pin an address, use it for testHost and keep it across reconnects", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: "127.0.0.1:1", advertise: "10.255.255.1" } });
    cleanup.push(child.stop);
    await child.daemon.setRoot(root.addr);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));

    const pinned = await post(root.addr, "/api/hosts/address", { host: "pc1", url: child.addr });
    expect(pinned.status).toBe(200);
    expect(root.daemon.daemons().find((d) => d.host === "pc1")?.url).toBe(`ws://${child.addr}`);
    expect((await root.daemon.testHost("pc1")).online).toBe(true);

    // A reconnect reports the (wrong) advertise again; the pinned address must win.
    await child.daemon.setRoot(root.addr);
    await new Promise((r) => setTimeout(r, 300));
    expect(root.daemon.daemons().find((d) => d.host === "pc1")?.url).toBe(`ws://${child.addr}`);
    expect(root.daemon.config.pinnedDaemons?.pc1).toBe(child.addr);
  });

  it("rejects a malformed address and is Root-only", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    const bad = await post(root.addr, "/api/hosts/address", { host: "pc1", url: "1.2.3.4:4777:4777" });
    expect(bad.status).toBe(400);
    const notRoot = await post(child.addr, "/api/hosts/address", { host: "pc1", url: "1.2.3.4:4777" });
    expect(notRoot.status).toBe(400);
  });

  it("does not broadcast an unverified child address to other children", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    // `10.255.255.1` is not reachable from the Root, so it never earns a place in knownDaemons.
    const child = await startDaemon("pc1", { config: { root: root.addr, advertise: "10.255.255.1" } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));
    const other = await startDaemon("pc2", { config: { root: root.addr } });
    cleanup.push(other.stop);
    await waitFor(() => other.daemon.rootOnline);
    await waitFor(() => root.daemon.daemons().filter((d) => !d.isRoot).length === 2);
    await new Promise((r) => setTimeout(r, 300));

    const learned = other.daemon.peerUrlFor("pc1");
    expect(learned ?? "").not.toContain("10.255.255.1");

    // A pinned, reachable address is what children learn instead.
    await post(root.addr, "/api/hosts/address", { host: "pc1", url: child.addr });
    await waitFor(() => other.daemon.peerUrlFor("pc1") === `ws://${child.addr}`);
  });
});