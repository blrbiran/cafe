import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("host display names", () => {
  it("renames a Host without changing its internal id, and keeps the old name as an alias", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const rec = root.daemon.setHostIdentity("hub");
    expect(rec.host).toBe("root");
    expect(rec.displayName).toBe("hub");
    expect(rec.aliases).toContain("root");
    expect(root.daemon.snapshot()).toMatchObject({ host: "root", displayName: "hub" });
  });

  it("resolves an address that uses a host alias", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());
    root.daemon.setHostIdentity("hub", ["root-alias"]);

    const res = await c.ask({ body: "hello", to: "widgets@root-alias" });
    const events = await untilClosed(c, res.threadId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "widgets says: hello" });
  });
});

describe("agent display names", () => {
  it("renames locally, keeps the Address/agentId, and resolves the new name", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const b = await barista(root.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    const c = await customer(root.addr);
    cleanup.push(() => c.close());

    const renamed = await root.daemon.renameAgentAny("widgets@root", "gadget-owner");
    expect(renamed).toMatchObject({ name: "widgets", displayName: "gadget-owner", address: "widgets#1@root" });
    expect(renamed.aliases).toContain("widgets");
    expect(root.daemon.registry.get(b.rec.agentId)?.displayName).toBe("gadget-owner");

    const res = await c.ask({ body: "hello", to: "gadget-owner@root" });
    const events = await untilClosed(c, res.threadId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ text: "widgets says: hello" });
  });

  it("relays a rename from the Root to the owning child Daemon", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    const b = await barista(child.addr, identity("pcagent"));
    cleanup.push(() => b.client.close());
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "pcagent"));

    const rec = await root.daemon.renameAgentAny("pcagent@pc1", "renamed");
    expect(rec.displayName).toBe("renamed");
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "pcagent" && r.displayName === "renamed"));
  });
});

describe("name conflicts", () => {
  it("rejects a Host name that another Host already uses (id, display name, or alias)", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));

    expect(() => root.daemon.setHostIdentity("pc1")).toThrow(/already used/);
    root.daemon.renameHost("pc1", "pc-one");
    expect(() => root.daemon.setHostIdentity("pc-one")).toThrow(/already used/);
    expect(() => root.daemon.setHostIdentity("hub", ["pc-one"])).toThrow(/already used/);
  });

  it("lets a Host reuse one of its own old names", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    root.daemon.setHostIdentity("hub");
    expect(root.daemon.setHostIdentity("root").displayName).toBe("root");
  });

  it("rejects an Agent name that another Agent on the same Host already uses", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const a = await barista(root.addr, identity("widgets"));
    cleanup.push(() => a.client.close());
    const b = await barista(root.addr, identity("gadgets"));
    cleanup.push(() => b.client.close());

    expect(() => root.daemon.renameAgent(a.rec.agentId, "gadgets")).toThrow(/already used/);
    expect(() => root.daemon.renameAgent(a.rec.agentId, "gadgets#1")).toThrow(/must not contain/);
    expect(() => root.daemon.aliasAgent(a.rec.agentId, "gadgets")).toThrow(/already used/);
  });

  it("allows the same Agent display name on different Hosts", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    const a = await barista(root.addr, identity("widgets"));
    cleanup.push(() => a.client.close());
    const b = await barista(child.addr, identity("widgets"));
    cleanup.push(() => b.client.close());
    await waitFor(() => root.daemon.registry.all().some((r) => r.host === "pc1" && r.name === "widgets"));

    expect(root.daemon.renameAgent(a.rec.agentId, "shared").displayName).toBe("shared");
    await expect(root.daemon.renameAgentAny("widgets#1@pc1", "shared")).resolves.toMatchObject({ displayName: "shared" });
  });
});

describe("host diagnostics", () => {
  it("reports latency for a reachable Host and failure for a stopped one", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1" && d.online));

    const ok = await root.daemon.testHost("pc1");
    expect(ok).toMatchObject({ host: "pc1", online: true });
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);

    await child.stop();
    const bad = await root.daemon.testHost("pc1");
    expect(bad.online).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});

describe("remote host rename", () => {
  it("updates the Root record and the child's own view", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "pc1"));

    const rec = root.daemon.renameHost("pc1", "pc-one");
    expect(rec).toMatchObject({ host: "pc1", displayName: "pc-one" });
    expect(rec.aliases).toContain("pc1");
    await waitFor(() => child.daemon.snapshot().displayName === "pc-one");
    expect(child.daemon.snapshot().host).toBe("pc1");
  });
});
