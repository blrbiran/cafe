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
