import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentRecord } from "@cafe/protocol";
import { Peer } from "@cafe/protocol/peer";
import { CafeClient } from "@cafe/protocol/client";
import { barista, identity, startDaemon, waitFor } from "./helpers.ts";

// v4-12: a new client may not silently inherit an old Daemon's semantics. The fake below speaks
// protocol 1 like a pre-v4-11 daemon: it advertises nothing and its register echo drops new fields.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

interface FakeOptions {
  features?: string[];
  keepIdentity?: boolean;
  decision?: Record<string, unknown>;
}

async function fakeDaemon(opts: FakeOptions = {}): Promise<{ addr: string; registers: () => number; orders: () => number }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const state = { registers: 0, orders: 0 };
  wss.on("connection", (ws: WebSocket) => {
    const peer = new Peer(ws);
    ws.on("message", (data) => void peer.receive(data.toString()));
    ws.on("close", () => peer.closed());
    peer.on("initialize", () => ({ protocolVersion: 1, cafeVersion: "0.1.5", host: "oldbox", ...(opts.features ? { features: opts.features } : {}) }));
    peer.on("agent/register", (raw: Record<string, unknown>) => {
      state.registers++;
      const { resumeAgentId: _drop, ...identity } = raw as Record<string, unknown>;
      const kept = opts.keepIdentity ? identity : { name: identity.name, description: "", tags: [], scope: [], role: "barista", concurrency: 1, mode: "headless", cwd: "/tmp" };
      return { ...kept, agentId: "a1", address: `${String(identity.name)}#1@oldbox`, host: "oldbox", status: "idle", registeredAt: Date.now() };
    });
    peer.on("order/create", () => {
      state.orders++;
      return { orderId: "o1", threadId: "t1", decision: opts.decision ?? { mode: "unicast", targets: ["a1"], reason: "asked the most available Barista", router: "rules", candidates: [] } };
    });
  });
  cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
  await new Promise<void>((r) => wss.once("listening", () => r()));
  return { addr: `127.0.0.1:${(wss.address() as { port: number }).port}`, registers: () => state.registers, orders: () => state.orders };
}

describe("mixed-release client behaviour (v4-12)", () => {
  it("refuses channel, collect and escalate before creating an Order when the daemon advertises nothing", async () => {
    const { addr, orders } = await fakeDaemon();
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    await c.connect();
    const before = orders();

    await expect(c.ask({ body: "in dev", channel: "dev" })).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(c.ask({ body: "ask all", collect: "all" })).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(c.ask({ body: "clarify", escalate: true, parentOrderId: "o0", parentThreadId: "t0" })).rejects.toMatchObject({ code: "unsupported_capability" });
    // Nothing was sent: no Order exists for a field the old daemon would silently drop.
    expect(orders()).toBe(before);
  });

  it("accepts escalate when the daemon advertises it and does not warn", async () => {
    const { addr } = await fakeDaemon({
      features: ["teams", "channels", "escalate", "collect", "digests", "team-sessions"],
      decision: { mode: "unicast", targets: ["a9"], reason: "escalate to parent boss#1@oldbox", router: "explicit", candidates: [] },
    });
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    await c.connect();
    await c.ask({ body: "clarify", escalate: true, parentOrderId: "o0", parentThreadId: "t0" });
    expect(c.drainWarnings()).toEqual([]);
  });

  it("refuses an observer after the registration echo proves it was stripped", async () => {
    const { addr } = await fakeDaemon();
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    await expect(c.connect(identity("watch", { observer: true, channels: ["team"] }))).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(c.connected).toBe(false);
  });

  it("refuses an observer before registering when the daemon advertises without digests", async () => {
    const { addr } = await fakeDaemon({ features: ["teams", "channels", "escalate", "collect"], keepIdentity: true });
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    await expect(c.connect(identity("watch", { observer: true, channels: ["team"] }))).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("accepts an observer when the daemon advertises digests", async () => {
    const { addr } = await fakeDaemon({ features: ["teams", "channels", "escalate", "collect", "digests"], keepIdentity: true });
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    const rec = await c.connect(identity("watch", { observer: true, channels: ["team"] }));
    expect(rec?.observer).toBe(true);
    expect(c.drainWarnings()).toEqual([]);
  });

  it("refuses a team identity when the daemon advertises no team-sessions", async () => {
    const { addr } = await fakeDaemon();
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    await expect(c.connect(identity("dev1", { team: "repo", teamChannel: "repo-dev", member: "dev1", channels: ["repo-dev"] }))).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(c.connected).toBe(false);
  });

  it("warns when a team-sessions daemon still drops the team identity", async () => {
    const { addr } = await fakeDaemon({ features: ["teams", "channels", "escalate", "collect", "digests", "team-sessions"] });
    const c = new CafeClient({ daemon: addr });
    cleanup.push(() => c.close());
    await c.connect(identity("dev1", { team: "repo", teamChannel: "repo-dev", member: "dev1", channels: ["repo-dev"] }));
    expect(c.drainWarnings().join("\n")).toMatch(/did not keep team, channels/);
    expect(c.connected).toBe(true);
  });
});

describe("feature advertisement (v4-12)", () => {
  it("advertises on initialize, health and snapshot; no warnings against a current daemon", async () => {
    const d = await startDaemon("cap1", { mode: "root" });
    cleanup.push(d.stop);
    const health = (await (await fetch(`http://${d.addr}/api/health`)).json()) as { features?: string[] };
    expect(health.features).toEqual(expect.arrayContaining(["teams", "channels", "escalate", "collect", "digests"]));
    const snap = (await (await fetch(`http://${d.addr}/api/snapshot`)).json()) as { features?: string[] };
    expect(snap.features).toContain("channels");

    const c = new CafeClient({ daemon: d.addr });
    cleanup.push(() => c.close());
    await c.connect(identity("dev", { channels: ["team"], team: "repo", teamChannel: "repo-dev", member: "dev" }));
    expect(c.features).toEqual(expect.arrayContaining(["teams", "digests"]));
    expect(c.drainWarnings()).toEqual([]);
  });

  it("does not publish observers or channel-only agents to a peer that advertises nothing", async () => {
    const d = await startDaemon("capreg", { mode: "root" });
    cleanup.push(d.stop);
    const ws = new WebSocket(`ws://${d.addr}/ws`);
    const peer = new Peer(ws);
    ws.on("message", (data) => void peer.receive(data.toString()));
    const seen: AgentRecord[] = [];
    peer.on("registry/snapshot", (x: { records: AgentRecord[] }) => seen.push(...x.records));
    peer.on("registry/delta", (x: { upsert: AgentRecord[] }) => seen.push(...x.upsert));
    peer.on("root/moved", () => ({}));
    await new Promise<void>((r) => ws.on("open", () => r()));
    cleanup.push(() => ws.terminate());
    await peer.request("initialize", { protocolVersion: 1, kind: "daemon", token: "t0k", host: "oldbox", url: "ws://oldbox:1" });

    const obs = new CafeClient({ daemon: d.addr });
    cleanup.push(() => obs.close());
    await obs.connect(identity("obs", { observer: true, channels: ["team"] }));
    const dev = await barista(d.addr, identity("dev", { channels: ["team"] }));
    cleanup.push(() => dev.client.close());
    const norm = await barista(d.addr, identity("norm"));
    cleanup.push(() => norm.client.close());

    await waitFor(() => seen.some((r) => r.name === "norm"), 5000);
    const names = new Set(seen.map((r) => r.name));
    expect(names.has("norm")).toBe(true);
    expect(names.has("obs")).toBe(false);
    expect(names.has("dev")).toBe(false);
  });
});