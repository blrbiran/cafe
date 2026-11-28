import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { CafeClient, keepAlive } from "@cafe/protocol/client";
import { managedAgentResumeStore } from "@cafe/protocol/cafe-file";
import { FAST, barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";
import { startEnrolledChild } from "./tls-helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const timing = { ...FAST, ackTimeoutMs: 2000, linkConnectTimeoutMs: 1500, linkIdleMs: 60_000 };

async function durableWorker(daemon: Awaited<ReturnType<typeof startDaemon>>) {
  const client = new CafeClient({ daemon: daemon.addr, resumeStore: managedAgentResumeStore(join(daemon.home, "agent-identities", "strict-worker.json")) });
  cleanup.push(() => client.close());
  client.onOrder((h) => {
    const stop = keepAlive(h, FAST.heartbeatIntervalMs);
    void h.ack().then(() => h.reply(`worker says: ${h.order.body}`)).catch(() => {}).finally(stop);
  });
  const rec = await client.connect(identity("worker"));
  return { client, rec: rec! };
}

describe("fixture-gated assignment relay", () => {
  it("keeps strict capabilities out of normal daemons and exposes them only to fixtures", async () => {
    const normal = await startDaemon("relay-normal");
    cleanup.push(normal.stop);
    expect(normal.daemon.features()).not.toContain("assignment-relay-v1");
    expect(normal.daemon.features()).not.toContain("assignment-receipt-v1");

    const fixture = await startDaemon("relay-fixture", { assignmentRelayFixture: true });
    cleanup.push(fixture.stop);
    expect(fixture.daemon.features()).toContain("assignment-relay-v1");
    expect(fixture.daemon.features()).not.toContain("assignment-receipt-v1");
  });

  it.each([false, true])("fails unsupported strict delivery before committing an assignment (capable Host: %s)", async (hostSupportsRelay) => {
    const root = await startDaemon("relay-incompatible-root", { config: { mode: "root", security: { mode: "tls", tls: { port: 0 } } }, assignmentRelayFixture: true, timing });
    cleanup.push(root.stop);
    const child = await startEnrolledChild(root, "relay-incompatible-child", { timing, assignmentRelayFixture: hostSupportsRelay });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((daemon) => daemon.host === "relay-incompatible-child" && daemon.online));
    let deliveries = 0;
    const worker = await barista(child.addr, identity("worker"), async () => { deliveries += 1; });
    cleanup.push(() => worker.client.close());
    await waitFor(() => root.daemon.registry.all().some((agent) => agent.agentId === worker.rec.agentId));

    const caller = await customer(root.addr);
    cleanup.push(() => caller.close());
    const result = await caller.ask({ body: "must not downgrade", to: "worker" });
    const events = await untilClosed(caller, result.threadId, result.orderId);
    expect(events.find((event) => event.orderId === result.orderId && event.event.type === "order.assigned")).toBeUndefined();
    const reason = hostSupportsRelay ? "durable assignment receipts" : "strict assignment relay";
    expect(events.some((event) => event.orderId === result.orderId && event.event.type === "order.failed" && event.event.reason.includes(reason))).toBe(true);
    expect(deliveries).toBe(0);
  });

  it("uses acknowledged strict relay through the Root and records the assignment mode", async () => {
    const root = await startDaemon("relay-root", { config: { mode: "root", security: { mode: "tls", tls: { port: 0 } } }, assignmentRelayFixture: true, timing });
    cleanup.push(root.stop);
    const child = await startEnrolledChild(root, "relay-child", { assignmentRelayFixture: true, timing });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((daemon) => daemon.host === "relay-child" && daemon.online));
    const worker = await durableWorker(child);
    await waitFor(() => root.daemon.registry.all().some((agent) => agent.agentId === worker.rec.agentId));

    const caller = await customer(root.addr);
    cleanup.push(() => caller.close());
    const result = await caller.ask({ body: "strict root delivery", to: "worker" });
    const events = await untilClosed(caller, result.threadId, result.orderId);
    const assigned = events.find((event) => event.orderId === result.orderId && event.event.type === "order.assigned");
    expect(assigned?.event).toMatchObject({ type: "order.assigned", assignment: { relayMode: "strict" } });
    expect(events.some((event) => event.event.type === "order.replied" && event.event.text === "worker says: strict root delivery")).toBe(true);
  });

  it("uses acknowledged strict relay over an authenticated direct route", async () => {
    const root = await startDaemon("direct-root", { config: { mode: "root", security: { mode: "tls", tls: { port: 0 } } }, assignmentRelayFixture: true, timing });
    cleanup.push(root.stop);
    const source = await startEnrolledChild(root, "direct-source", { assignmentRelayFixture: true, timing });
    cleanup.push(source.stop);
    const recipient = await startEnrolledChild(root, "direct-recipient", { assignmentRelayFixture: true, timing });
    cleanup.push(recipient.stop);
    await waitFor(() => source.daemon.rootOnline && recipient.daemon.rootOnline);
    const worker = await durableWorker(recipient);
    await waitFor(() => source.daemon.registry.all().some((agent) => agent.agentId === worker.rec.agentId));
    await waitFor(() => (source.daemon as any).peerUrls.has("direct-recipient"));
    await root.stop();
    await waitFor(() => !source.daemon.rootOnline);

    const caller = await customer(source.addr);
    cleanup.push(() => caller.close());
    const result = await caller.ask({ body: "strict direct delivery", to: "worker" });
    const events = await untilClosed(caller, result.threadId, result.orderId);
    const assigned = events.find((event) => event.orderId === result.orderId && event.event.type === "order.assigned");
    expect(assigned?.event).toMatchObject({ type: "order.assigned", assignment: { relayMode: "strict" } });
    expect(events.some((event) => event.event.type === "order.replied" && event.event.text === "worker says: strict direct delivery")).toBe(true);
  });
});
