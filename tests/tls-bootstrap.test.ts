import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsPostRequest } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadEnvelope } from "@cafe/protocol";
import type { Peer } from "@cafe/protocol/peer";
import { fingerprintOf } from "../packages/daemon/src/tls/certs.ts";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

/**
 * CA bootstrap in `runDaemon` (v4-6 §3.3):
 *
 * - A Root with no CA creates one.
 * - A standalone Daemon with no Root creates a local CA (it is its own trust anchor).
 * - A child joins only with a one-use Root invitation; without one it stays local-only and never
 *   silently enrols on its own when the Root later appears.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

/** Redeem an invite over Root TLS and install the child's cert/key before it starts. */
async function enrollChild(root: { home: string; addr: string; server: { tlsPort?: number } }, rootHostId: string, childHome: string, childHost: string) {
  const { generateHostKeyPair, hostIdFromCertificate } = await import("../packages/daemon/src/tls/certs.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const operatorKey = readFileSync(join(root.home, "operator.key"), "utf8");
  const invite = await fetch(`http://${root.addr}/api/host/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cafe-operator-key": operatorKey },
    body: JSON.stringify({ name: childHost }),
  }).then((r) => r.json() as Promise<{ inviteCode: string; hostId: string }>);
  const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
  const keys = await generateHostKeyPair();
  const { localAddresses, sanList } = await import("../packages/daemon/src/tls/certs.ts");
  const sans = sanList({ host: childHost, advertise: "127.0.0.1", lan: localAddresses() });
  const body = JSON.stringify({ inviteCode: invite.inviteCode, requestId: "bootstrap-test-request", publicKey: keys.publicKey, sans });
  const enrolled = await new Promise<{ cert: string; hostId: string }>((resolve, reject) => {
    const req = httpsPostRequest({ host: "127.0.0.1", port: root.server.tlsPort!, path: "/api/tls/leaf", method: "POST", ca,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: "Bearer t0k" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) !== 200) return reject(new Error(`enroll failed: ${text}`));
        resolve(JSON.parse(text));
      });
    });
    req.on("error", reject);
    req.end(body);
  });
  mkdirSync(join(childHome, "tls"), { recursive: true });
  writeFileSync(join(childHome, "tls", `${childHost}.crt`), enrolled.cert, { mode: 0o644 });
  writeFileSync(join(childHome, "tls", `${childHost}.key`), keys.privateKey, { mode: 0o600 });
  expect(hostIdFromCertificate(enrolled.cert)).toBe(invite.hostId);
  return { ca, rootHostId, hostId: invite.hostId };
}

describe("CA bootstrap", () => {
  it("a standalone daemon creates a local CA and still starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "cafe-ca-standalone-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    // Opt into TLS: the test helper defaults to plaintext (production defaults to TLS).
    const d = await startDaemon("alone", { home, config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(d.stop);
    expect(existsSync(join(home, "tls", "ca.crt"))).toBe(true);
    expect(d.server.tlsPort).toBeGreaterThan(0);
  }, 30_000);

  it("an invited child trusts the Root, connects over TLS, and keeps its Host ID", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-ca-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-ca-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("caroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const rootCa = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");

    const enrolled = await enrollChild(root, root.daemon.hostId, childHome, "cachild");
    writeFileSync(join(childHome, "tls", "ca.crt"), rootCa);
    const child = await startDaemon("cachild", {
      home: childHome,
      config: { root: root.addr, security: { mode: "tls", tls: { port: 0, caFingerprint: fingerprintOf(rootCa), rootHostId: enrolled.rootHostId } } },
    });
    cleanup.push(child.stop);

    await waitFor(() => child.daemon.rootOnline, 10_000);
    expect(child.daemon.hostId).toBe(enrolled.hostId);
    expect(child.daemon.rootHostId).toBe(enrolled.rootHostId);

    const b = await barista(root.addr, identity("cabilling", { tags: ["invoice"] }));
    cleanup.push(() => b.client.close());
    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "the invoice total is wrong" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: b.rec.agentId });

    const queuedBeforeDelivery: Array<string | undefined> = [];
    const worker = await barista(child.addr, identity("cold-recipient"), async (h) => {
      const assignment = child.daemon.thread(h.order.threadId)?.events.find(({ event }) => event.type === "order.assigned")?.event;
      const inbox = assignment?.type === "order.assigned" && child.daemon.store.getRecipientAssignment(assignment.assignment.assignmentId);
      queuedBeforeDelivery.push(inbox ? inbox.body : undefined);
      await h.ack();
      await h.reply(`checked: ${h.order.body}`);
    });
    cleanup.push(() => worker.client.close());
    await waitFor(() => root.daemon.registry.get(worker.rec.agentId)?.status === "idle");
    const rootCaller = await customer(root.addr);
    cleanup.push(() => rootCaller.close());
    const outbound = await rootCaller.ask({ body: "check the totals", to: "cold-recipient" });
    const outboundEvents = await untilClosed(rootCaller, outbound.threadId, outbound.orderId);
    const issued = outboundEvents.find(({ event }) => event.type === "order.assigned");
    expect(issued).toBeDefined();
    const recipientEvents = child.daemon.thread(outbound.threadId)?.events ?? [];
    expect(recipientEvents.find(({ event }) => event.type === "order.assigned")?.eventId).toBe(issued?.eventId);
    expect(queuedBeforeDelivery).toEqual(["check the totals"]);

    const uplink = (child.daemon as unknown as { uplink: Peer }).uplink;
    const notify = uplink.notify.bind(uplink);
    let delayed: ThreadEnvelope | undefined;
    const hold = vi.spyOn(uplink, "notify").mockImplementation((method, params) => {
      const env = params as ThreadEnvelope | undefined;
      if (method === "thread/event" && env?.event.type === "order.delivered") delayed = env;
      else notify(method, params);
    });
    cleanup.push(() => { hold.mockRestore(); });
    const reordered = await rootCaller.ask({ body: "check a delayed receipt", to: "cold-recipient" });
    await waitFor(() => root.daemon.store.listPendingEvents(reordered.threadId).some(({ event }) => event.type === "order.replied"));
    expect(root.daemon.thread(reordered.threadId)?.meta.replies).toEqual([]);
    expect(delayed).toBeDefined();
    hold.mockRestore();
    notify("thread/event", delayed);
    const replayed = await untilClosed(rootCaller, reordered.threadId, reordered.orderId);
    expect(replayed.filter(({ event }) => event.type === "order.replied")).toHaveLength(1);
    expect(root.daemon.store.listPendingEvents(reordered.threadId)).toEqual([]);

    const firstTarget = await barista(root.addr, identity("replace-first"), async (h) => { await h.ack(); });
    cleanup.push(() => firstTarget.client.close());
    const previous = await rootCaller.ask({ body: "old task", to: "replace-first" });
    expect(child.daemon.thread(previous.threadId)).toBeUndefined();
    const replacement = await rootCaller.ask({ body: "new task", to: "cold-recipient", threadId: previous.threadId, replaceOrderId: previous.orderId });
    const replacementEvents = await untilClosed(rootCaller, replacement.threadId, replacement.orderId);
    expect(replacementEvents.find(({ event }) => event.type === "order.replied")?.event).toMatchObject({ text: "checked: new task" });
    expect(child.daemon.thread(previous.threadId)?.meta.orderId).toBe(replacement.orderId);
  }, 40_000);

  it("keeps an old child certificate local and gives both re-enrollment steps in Doctor", async () => {
    const root = await startDaemon("legacy-root", { mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    const childHome = mkdtempSync(join(tmpdir(), "cafe-ca-legacy-child-"));
    cleanup.push(() => rmSync(childHome, { recursive: true, force: true }));
    const ca = readFileSync(join(root.home, "tls", "ca.crt"), "utf8");
    const leaf = await root.daemon.tlsContext!.issue!(["legacy-child", "127.0.0.1", "localhost"]);
    const { mkdirSync } = await import("node:fs");
    const tlsDir = join(childHome, "tls");
    mkdirSync(tlsDir);
    writeFileSync(join(tlsDir, "ca.crt"), ca);
    writeFileSync(join(tlsDir, "legacy-child.crt"), leaf.cert);
    writeFileSync(join(tlsDir, "legacy-child.key"), leaf.key, { mode: 0o600 });
    const child = await startDaemon("legacy-child", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0, caFingerprint: fingerprintOf(ca) } } },
    });
    cleanup.push(child.stop);
    expect(child.daemon.rootOnline).toBe(false);
    expect(readFileSync(join(tlsDir, "legacy-child.crt"), "utf8")).toBe(leaf.cert);
    const doctor = await fetch(`http://${child.addr}/api/doctor`).then((r) => r.json() as Promise<{ checks: { name: string; next?: string; detail: string }[] }>);
    const tls = doctor.checks.find(({ name }) => name === "tls");
    expect(tls?.detail).toContain("needs enrollment");
    expect(tls?.next).toContain("cafe host invite");
    expect(tls?.next).toContain("cafe connect <root> --invite <code>");
  }, 30_000);

  it("a child without an invite does not silently join a Root that appears later", async () => {
    // The pre-invite contract let a child enrol by itself as soon as its Root came up. Host identity
    // now requires an explicit one-use invitation, so the child must keep waiting instead.
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-ca-late-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-ca-late-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));

    const { createServer } = await import("node:net");
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const tlsPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const child = await startDaemon("latechild", {
      home: childHome,
      config: { root: `127.0.0.1:${tlsPort}`, security: { mode: "tls", tls: { port: 0 } } },
      timing: { leafCheckIntervalMs: 200, enrolRetryBaseMs: 200, enrolRetryMaxMs: 400 },
    });
    cleanup.push(child.stop);
    expect(child.daemon.rootOnline).toBe(false);
    expect(existsSync(join(childHome, "tls", "ca.crt"))).toBe(false);

    const root = await startDaemon("lateroot", {
      home: rootHome,
      mode: "root",
      config: { security: { mode: "tls", tls: { port: tlsPort } } },
    });
    cleanup.push(root.stop);

    // Give the retry loop time to notice the Root; without an invitation it must stay local-only.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(child.daemon.rootOnline).toBe(false);
    // Any local leaf is signed by the temporary CA, never by the Root's network CA.
    const localLeaf = join(childHome, "tls", "latechild.crt");
    if (existsSync(localLeaf)) {
      const { issuedBy } = await import("../packages/daemon/src/tls/certs.ts");
      expect(issuedBy(readFileSync(join(rootHome, "tls", "ca.crt"), "utf8"), readFileSync(localLeaf, "utf8"))).toBe(false);
    }
  }, 40_000);

  it("refuses to enrol when the configured CA fingerprint does not match the Root's", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-ca-mismatch-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-ca-mismatch-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));
    const root = await startDaemon("mmroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    // A configured pin that does not match the Root's CA must refuse enrolment.
    const err = await startDaemon("mmchild", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0, caFingerprint: "AA:BB:CC" } } },
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/fingerprint/i);
    // Nothing was written: a refused enrolment must not leave a CA on disk.
    expect(existsSync(join(childHome, "tls", "ca.crt"))).toBe(false);
  }, 30_000);
});