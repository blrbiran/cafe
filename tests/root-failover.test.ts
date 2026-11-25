import { createServer } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Peer } from "../packages/protocol/src/peer.ts";
import { Methods, PROTOCOL_VERSION } from "../packages/protocol/src/index.ts";
import { FAST, startDaemon, waitFor } from "./helpers.ts";

/**
 * #104: `config.root` was the only address a child ever redialled, discovery ran only when it was
 * empty, and `root/moved` existed in the protocol without an implementation. A Root whose DHCP/VPN
 * address changed therefore needed a person on every child.
 *
 * v4-10: the Root hands out its address set (`root/moved`), children keep it as reconnect candidates
 * and rotate them; the address that finally works becomes the new `config.root`.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe("Root address failover (#104)", () => {
  it("reconnects through a learned address and persists it as the new root", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const dead = `127.0.0.1:${await closedPort()}`;
    const child = await startDaemon("pc1", { config: { root: dead }, timing: FAST });
    cleanup.push(child.stop);
    expect(child.daemon.rootOnline).toBe(false);

    child.daemon.rememberRootAddresses([root.addr]);
    await waitFor(() => child.daemon.rootOnline, 8000);
    // No person ran `cafe root set`. The working address is remembered as a candidate (`lastRoot`),
    // while the person's configured `root:` is left alone.
    expect(child.daemon.config.root).toBe(dead);
    expect(child.daemon.store.getKv("lastRoot")).toBe(root.addr);
    const health = (await (await fetch(`http://${child.addr}/api/health`)).json()) as { rootConnected?: string };
    expect(health.rootConnected).toBe(root.addr);
  });

  // A rotated candidate may answer from a different Root (same token, sibling network). Only an
  // address the person set may change which Root this Host belongs to.
  it("refuses a learned address that answers as a different Root", async () => {
    const root1 = await startDaemon("root1", { mode: "root" });
    cleanup.push(root1.stop);
    const root2 = await startDaemon("root2", { mode: "root" });
    cleanup.push(root2.stop);
    const logs: string[] = [];
    const child = await startDaemon("pc1", { config: { root: root1.addr }, timing: FAST, log: (m) => logs.push(m) });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 8000);

    child.daemon.rememberRootAddresses([root2.addr]);
    await root1.stop();
    await waitFor(() => logs.some((l) => l.includes("answers as root 'root2'")), 8000);
    expect(child.daemon.rootOnline).toBe(false);

    // An explicit choice is honoured: the person may really be moving this Host.
    child.daemon.setRoot(root2.addr);
    await waitFor(() => child.daemon.rootOnline, 8000);
    expect(child.daemon.rootConnected).toBe(root2.addr);
  }, 20_000);

  it("merges, dedupes and bounds the candidate list", async () => {
    const child = await startDaemon("pc1", { config: { root: "127.0.0.1:1" }, timing: FAST });
    cleanup.push(child.stop);
    child.daemon.rememberRootAddresses(["10.0.0.1:4777", "10.0.0.1:4777", "10.0.0.2:4777"]);
    expect(child.daemon.rootCandidates().filter((c) => c === "10.0.0.1:4777")).toHaveLength(1);
    child.daemon.rememberRootAddresses(Array.from({ length: 12 }, (_, i) => `10.1.0.${i}:4777`));
    const candidates = child.daemon.rootCandidates();
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(candidates[0]).toBe("127.0.0.1:1"); // the configured address stays first
  });

  it("the Root tells a newly connected child where it can be reached", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const ws = new WebSocket(`ws://${root.addr}/ws`);
    cleanup.push(() => ws.close());
    const peer = new Peer(ws);
    ws.on("message", (d) => void peer.receive(d.toString()));
    ws.on("error", () => {});
    let moved: string[] | undefined;
    peer.on(Methods.rootMoved, (x: { addresses: string[] }) => {
      moved = x.addresses;
    });
    await new Promise<void>((r) => ws.once("open", () => r()));
    void peer.request(Methods.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      cafeVersion: "test",
      kind: "daemon",
      token: "t0k",
      host: "watcher",
      displayName: "watcher",
      aliases: [],
      url: "ws://127.0.0.1:1",
      registryVersion: 0,
    });
    await waitFor(() => (moved?.length ?? 0) > 0, 5000);
    expect(moved).toContain(root.addr);
  });
});
