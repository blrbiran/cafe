import { createServer } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Peer } from "../packages/protocol/src/peer.ts";
import { Methods, PROTOCOL_VERSION } from "../packages/protocol/src/index.ts";
import { watchLiveness } from "../packages/daemon/src/liveness.ts";
import { FAST, startDaemon, waitFor } from "./helpers.ts";

/**
 * #99: a Daemon link with no application-level liveness never noticed a half-open socket. The child
 * kept saying "root: online" while the Root had long forgotten it, and only a restart fixed it.
 * v4-10: every Daemon↔Daemon socket sends a WebSocket ping and expects a pong; two misses kill the
 * socket locally so the existing close handlers reconnect / mark the Host offline.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

const PING_MS = 150;

/** A Root stand-in that completes the handshake but never answers pings (`autoPong: false`). */
async function silentRoot(): Promise<{ addr: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => {
    const peer = new Peer(ws);
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("error", () => {});
    peer.on(Methods.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, cafeVersion: "test", host: "fakeroot", displayName: "fakeroot", aliases: [], isRoot: true }));
    peer.on("registry/sync", () => ({}));
  });
  const port = (wss.address() as { port: number }).port;
  return {
    addr: `127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

describe("link liveness (#99)", () => {
  // A dial that is still resolving (a black-holed SYN, slow TLS discovery) is CONNECTING, where
  // `ws.ping()` throws. The watcher must start only on `open`, or every slow dial dies after one tick.
  it("does not count a socket that is still connecting as dead", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const hole = createServer((s) => {
      // Accept the TCP connection and never answer the WebSocket handshake.
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((r) => hole.listen(0, "127.0.0.1", r));
    const port = (hole.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", () => {});
    let dead = false;
    watchLiveness(ws, { intervalMs: 60, onDead: () => (dead = true) });
    await new Promise((r) => setTimeout(r, 400));
    expect(dead).toBe(false);
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    ws.terminate();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hole.close(() => r()));
  }, 8000);

  it("the child notices a Root that stopped answering and reconnects", async () => {
    const fake = await silentRoot();
    cleanup.push(fake.close);
    const logs: string[] = [];
    const child = await startDaemon("pc1", {
      config: { root: fake.addr },
      timing: { ...FAST, linkPingMs: PING_MS },
      log: (m) => logs.push(m),
    });
    cleanup.push(child.stop);

    await waitFor(() => logs.some((l) => l.includes("connected to root")), 5000);
    // Two missed pongs: the socket is killed locally, which runs the normal reconnect path.
    await waitFor(() => logs.some((l) => l.includes("root connection lost")), 5000);
  });

  it("the Root drops a child that stopped answering pings", async () => {
    const root = await startDaemon("root", { mode: "root", timing: { ...FAST, linkPingMs: PING_MS } });
    cleanup.push(root.stop);
    const ws = new WebSocket(`ws://${root.addr}/ws`, { autoPong: false });
    cleanup.push(() => ws.close());
    const peer = new Peer(ws);
    ws.on("message", (d) => void peer.receive(d.toString()));
    ws.on("error", () => {});
    await new Promise<void>((r) => ws.once("open", () => r()));
    void peer.request(Methods.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      cafeVersion: "test",
      kind: "daemon",
      token: "t0k",
      host: "silentpc",
      displayName: "silentpc",
      aliases: [],
      url: "ws://127.0.0.1:1",
      registryVersion: 0,
    });
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "silentpc" && d.online), 5000);
    await waitFor(() => root.daemon.daemons().find((d) => d.host === "silentpc")?.online === false, 5000);
  });

  it("leaves a healthy idle link alone and does not create Thread events", async () => {
    const root = await startDaemon("root", { mode: "root", timing: { ...FAST, linkPingMs: PING_MS } });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr }, timing: { ...FAST, linkPingMs: PING_MS } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline, 5000);
    const health = async () => (await (await fetch(`http://${child.addr}/api/health`)).json()) as { eventsSinceStart?: number };
    const before = await health();
    await new Promise((r) => setTimeout(r, PING_MS * 5));
    expect(child.daemon.rootOnline).toBe(true);
    const after = await health();
    // Pings are transport-level: an idle link must not look like traffic.
    expect(after.eventsSinceStart ?? 0).toBe(before.eventsSinceStart ?? 0);
  });
});
