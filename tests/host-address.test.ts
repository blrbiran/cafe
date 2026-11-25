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

  it("restores the learned address when the pin is cleared", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));
    await waitFor(() => root.daemon.config.knownDaemons.pc1 === `ws://${child.addr}`);

    // A pin that proves reachable is kept and shown.
    const pinned = await post(root.addr, "/api/hosts/address", { host: "pc1", url: child.addr });
    expect(pinned.body).toMatchObject({ verified: true });
    expect(root.daemon.config.pinnedDaemons?.pc1).toBe(child.addr);

    // Clearing must fall back to the address the Root actually verified, not keep the old pin.
    const cleared = await post(root.addr, "/api/hosts/address", { host: "pc1", url: null });
    expect(cleared.status).toBe(200);
    expect(root.daemon.config.pinnedDaemons?.pc1).toBeUndefined();
    expect(root.daemon.daemons().find((d) => d.host === "pc1")?.url).toBe(`ws://${child.addr}`);
  });

  it("does not hand an unreachable pinned address to other children", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));
    const other = await startDaemon("pc2", { config: { root: root.addr } });
    cleanup.push(other.stop);
    await waitFor(() => other.daemon.rootOnline);
    await waitFor(() => other.daemon.peerUrlFor("pc1") === `ws://${child.addr}`);

    // An address the Root cannot reach must not be saved for an online Host (and never broadcast):
    // saving it would hide the address that currently works (#103).
    const refused = await post(root.addr, "/api/hosts/address", { host: "pc1", url: "10.255.255.1:4777" });
    expect(refused.body).toMatchObject({ verified: false });
    await new Promise((r) => setTimeout(r, 600));
    expect(root.daemon.config.pinnedDaemons?.pc1).toBeUndefined();
    expect(root.daemon.daemons().find((d) => d.host === "pc1")?.url).toBe(`ws://${child.addr}`);
    expect(other.daemon.peerUrlFor("pc1")).toBe(`ws://${child.addr}`);
  });
});
// #83: saving an unreachable address said "Address saved" and Test said only "fetch failed".
// #103: and it persisted over the address of a Host that was online at the time.
describe("host address diagnostics (#83, #103)", () => {
  it("reports a pin that the Root cannot reach, with the reason, and does not save it", async () => {
    const { createServer } = await import("node:net");
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const dead = `127.0.0.1:${(s.address() as any).port}`;
    await new Promise((r) => s.close(r));

    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));

    const saved = await post(root.addr, "/api/hosts/address", { host: "pc1", url: dead });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ host: "pc1", verified: false, code: "ECONNREFUSED" });
    expect(saved.body.error).toContain("ECONNREFUSED");
    // The online Host keeps the address that works (#103).
    expect(saved.body.url).toBe(`ws://${child.addr}`);
    expect(root.daemon.config.pinnedDaemons?.pc1).toBeUndefined();
    expect(root.daemon.daemons().find((d) => d.host === "pc1")?.url).toBe(`ws://${child.addr}`);

    const tested = await post(root.addr, "/api/hosts/test", { host: "pc1" });
    expect(tested.body).toMatchObject({ online: true, via: "direct", address: child.addr });
    expect(tested.body.error).toBeUndefined();

    const good = await post(root.addr, "/api/hosts/address", { host: "pc1", url: child.addr });
    expect(good.body).toMatchObject({ verified: true });
    expect(good.body.error).toBeUndefined();
  });
});
