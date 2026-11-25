import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { barista, identity, startDaemon, waitFor } from "./helpers.ts";

// v4-8: remove an offline machine ("forget a Host"). A retired machine stayed on the Root's Network page,
// in `cafe doctor` and in `knownDaemons` with no way to drop it short of editing config.yml and restarting.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

type AnyDaemon = Record<string, any>;
const priv = (d: unknown) => d as AnyDaemon;

async function network() {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  const child = await startDaemon("pc1", { config: { root: root.addr } });
  cleanup.push(child.stop);
  await waitFor(() => child.daemon.rootOnline);
  const b = await barista(child.addr, identity("pcagent"));
  cleanup.push(() => b.client.close());
  await waitFor(() => root.daemon.registry.all().some((r) => r.host === "pc1" && r.name === "pcagent"));
  return { root, child };
}

const forget = async (addr: string, host: string) => {
  const res = await fetch(`http://${addr}/api/hosts/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("forget an offline Host (v4-8)", () => {
  it("refuses while the Host is connected and removes nothing", async () => {
    const { root } = await network();
    const r = await forget(root.addr, "pc1");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("host_online");
    expect(r.body.message).toMatch(/cafe daemon stop/);
    expect(root.daemon.daemons().some((d) => d.host === "pc1")).toBe(true);
    expect(root.daemon.registry.all().some((a) => a.host === "pc1")).toBe(true);
  }, 30_000);

  it("forgets a stopped Host everywhere the Root remembers it", async () => {
    const { root, child } = await network();
    root.daemon.renameHost("pc1", "laptop");
    root.daemon.config.knownDaemons.pc1 = child.addr;
    root.daemon.config.pinnedDaemons.pc1 = child.addr;
    await child.stop();
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1" && !d.online));

    const r = await forget(root.addr, "laptop"); // by display name
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ host: "pc1", agents: 1 });
    expect(root.daemon.daemons().some((d) => d.host === "pc1")).toBe(false);
    expect(root.daemon.registry.all().some((a) => a.host === "pc1")).toBe(false);
    const cfg = parse(readFileSync(join(root.home, "config.yml"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(cfg.knownDaemons?.pc1).toBeUndefined();
    expect(cfg.pinnedDaemons?.pc1).toBeUndefined();
    expect(cfg.hostNames?.pc1).toBeUndefined();
    const machines = (await root.daemon.doctor()).checks.find((c: { name: string }) => c.name === "machines");
    expect(machines?.detail ?? "").not.toContain("pc1");
  }, 30_000);

  it("tells the other children, which drop its address, link and Agents", async () => {
    const { root, child } = await network();
    const other = await startDaemon("pc2", { config: { root: root.addr } });
    cleanup.push(other.stop);
    await waitFor(() => other.daemon.rootOnline);
    await waitFor(() => other.daemon.registry.all().some((a) => a.host === "pc1"));
    priv(other.daemon).peerUrls.set("pc1", `ws://${child.addr}`);
    other.daemon.store.setKv("peerUrls", { pc1: `ws://${child.addr}` });
    await child.stop();
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1" && !d.online));

    expect((await forget(root.addr, "pc1")).status).toBe(200);
    await waitFor(() => !priv(other.daemon).peerUrls.has("pc1"));
    expect((other.daemon.store.getKv("peerUrls") as Record<string, string>)?.pc1).toBeUndefined();
    await waitFor(() => !other.daemon.registry.all().some((a) => a.host === "pc1"));
  }, 30_000);

  it("is not a ban: the machine comes back when it connects again", async () => {
    const { root, child } = await network();
    await child.stop();
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1" && !d.online));
    expect((await forget(root.addr, "pc1")).status).toBe(200);

    const again = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(again.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1" && d.online));
    const b = await barista(again.addr, identity("pcagent"));
    cleanup.push(() => b.client.close());
    await waitFor(() => root.daemon.registry.all().some((a) => a.host === "pc1"));
  }, 30_000);

  it("validates the name and where it runs", async () => {
    const { root, child } = await network();
    expect((await forget(root.addr, "nosuch")).status).toBe(404);
    const self = await forget(root.addr, "root");
    expect(self.status).toBe(400);
    const onChild = await forget(child.addr, "root");
    expect(onChild.status).toBe(400);
    expect(onChild.body.error).toBe("not_root");
  }, 30_000);

  it("forgets a Host that only lingers in config (after a Root restart)", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    root.daemon.config.knownDaemons.ghost = "127.0.0.1:9";
    root.daemon.config.hostNames.ghost = { displayName: "old-box", aliases: [], legacyAliases: [] };
    const r = await forget(root.addr, "old-box");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ host: "ghost", agents: 0 });
    expect(root.daemon.config.knownDaemons.ghost).toBeUndefined();
    expect(root.daemon.config.hostNames.ghost).toBeUndefined();
  }, 30_000);

  it("does not let an address probe that was already running write the Host back", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const slow: Server = createServer((_req, res) => setTimeout(() => res.end(JSON.stringify({ ok: true })), 400));
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => slow.close(() => r())));
    const port = (slow.address() as { port: number }).port;
    root.daemon.config.knownDaemons.ghost = "127.0.0.1:9";
    const probe = priv(root.daemon).rememberChildUrl("ghost", `127.0.0.1:${port}`);
    expect((await forget(root.addr, "ghost")).status).toBe(200);
    await probe;
    expect(root.daemon.config.knownDaemons.ghost).toBeUndefined();
  }, 30_000);

  it("does not remove a Host that reconnected while its uplink was being checked", async () => {
    const { root } = await network();
    const d = priv(root.daemon);
    const real = d.children.get("pc1");
    d.uplinkAlive = async () => {
      d.children.set("pc1", { ...real }); // a new peer arrived meanwhile
      return false;
    };
    const r = await forget(root.addr, "pc1");
    d.children.set("pc1", real);
    expect(r.status).toBe(409);
    expect(root.daemon.registry.all().some((a) => a.host === "pc1")).toBe(true);
  }, 30_000);

  it("treats a connection that no longer answers as offline, closes it, and lets the machine rejoin", async () => {
    const { root, child } = await network();
    const d = priv(root.daemon);
    d.uplinkAlive = async () => false;
    const r = await forget(root.addr, "pc1");
    expect(r.status).toBe(200);
    delete d.uplinkAlive; // back to the prototype method
    // The child was alive after all: it reconnects and registers again.
    await waitFor(() => child.daemon.rootOnline && root.daemon.daemons().some((x) => x.host === "pc1" && x.online), 10_000);
  }, 30_000);
});

describe("a child drops the forgotten Host's TLS pins (v4-8 §3.3)", () => {
  it("removes the pin for the forgotten peer and keeps pins another peer or the Root still uses", async () => {
    const { root, child } = await network();
    const c = priv(child.daemon);
    c.peerUrls.set("gone", "wss://10.0.0.9:4778");
    c.peerUrls.set("alive", "wss://10.0.0.7:4778");
    c.peerUrls.set("reused", "wss://10.0.0.7:4778"); // a reused address shared with a live peer
    child.daemon.config.security.tls.pins = { "10.0.0.9:4778": "sha256:GONE", "10.0.0.7:4778": "sha256:ALIVE", [root.addr]: "sha256:ROOT" };
    c.onHostForgotten({ host: "gone" });
    c.onHostForgotten({ host: "reused" });
    c.onHostForgotten({ host: "root" }); // its own Root: ignored
    expect(child.daemon.config.security.tls.pins).toEqual({ "10.0.0.7:4778": "sha256:ALIVE", [root.addr]: "sha256:ROOT" });
    expect(c.peerUrls.has("gone")).toBe(false);
    expect(c.peerUrls.has("reused")).toBe(false);
    expect(c.peerUrls.has("alive")).toBe(true);
  }, 30_000);
});
