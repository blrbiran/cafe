import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { barista, identity, startDaemon } from "./helpers.ts";
import { callerCredentialTransport } from "../packages/protocol/src/urls.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("HTTP caller identity and idempotency", () => {
  it("classifies where caller capabilities can be sent", () => {
    expect(callerCredentialTransport("http://127.0.0.1:4777")).toBe("loopback");
    expect(callerCredentialTransport("http://[::1]:4777")).toBe("loopback");
    expect(callerCredentialTransport("https://cafe.example:4778")).toBe("verified-tls");
    expect(callerCredentialTransport("http://192.0.2.8:4777")).toBe("remote-plaintext");
  });

  it("does not share a raw idempotency key across human owner credentials", async () => {
    const d = await startDaemon("caller-scope");
    cleanups.push(d.stop);
    const post = async (owner: string) => {
      const response = await fetch(`http://${d.addr}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cafe-order-owner": owner },
        body: JSON.stringify({ body: "same payload", idempotencyKey: "same-platform-id", as: "claimed" }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ orderId: string; threadId: string }>;
    };

    const first = await post("a".repeat(64));
    const second = await post("b".repeat(64));

    expect(second.orderId).not.toBe(first.orderId);
    expect(second.threadId).not.toBe(first.threadId);
  });

  it("rejects a changed canonical payload under the same caller key", async () => {
    const d = await startDaemon("caller-conflict");
    cleanups.push(d.stop);
    const post = (body: string) => fetch(`http://${d.addr}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-order-owner": "c".repeat(64) },
      body: JSON.stringify({ body, idempotencyKey: "same-key" }),
    });

    expect((await post("first payload")).status).toBe(200);
    const conflict = await post("changed payload");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency_conflict" });
  });

  it("records asserted provenance separately from the authenticated human principal", async () => {
    const d = await startDaemon("caller-provenance");
    cleanups.push(d.stop);
    const result = await d.daemon.createOrder({
      body: "claimed agent request",
      kind: "order",
      as: "another-agent",
      origin: "agent",
      via: { address: "forged-agent@remote" },
    }, undefined, "d".repeat(64));
    const meta = d.daemon.thread(result.threadId)!.meta;
    const created = d.daemon.store.readEvents(meta.file).find((event) => event.event.type === "order.created")!;

    expect(meta.origin).toBe("agent");
    expect(meta.via?.address).toBe("forged-agent@remote");
    expect(meta.provenanceVerified).toBe(false);
    expect(created.actor).toMatchObject({ kind: "human" });
    expect(created.actor?.principalId).not.toContain("d".repeat(64));
  });

  it("accepts only a locally provisioned connector capability", async () => {
    const d = await startDaemon("connector-principal");
    cleanups.push(d.stop);
    const credential = "7".repeat(64);
    const post = (key: string) => fetch(`http://${d.addr}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cafe-connector-key": key },
      body: JSON.stringify({ body: "connector task", idempotencyKey: "event-1", as: "claimed connector" }),
    });

    expect((await post(credential)).status).toBe(401);
    const credentialDigest = createHash("sha256").update(credential).digest("hex");
    d.daemon.store.putCallerPrincipal({ kind: "connector", credentialDigest, principalId: "connector:installed" });
    expect(d.daemon.store.getCallerPrincipal("connector", credentialDigest)).toBe("connector:installed");
    const accepted = await post(credential);
    const acceptedBody = await accepted.json();
    expect(accepted.status, JSON.stringify(acceptedBody)).toBe(200);
  });

  it("requires a local operator credential for HTTP replyAs", async () => {
    const d = await startDaemon("operator-reply", { mode: "root" });
    cleanups.push(d.stop);
    let agentOrder: import("@cafe/protocol/client").OrderHandle | undefined;
    const target = await barista(d.addr, identity("target"), async (handle) => { agentOrder = handle; await handle.ack(); });
    cleanups.push(() => target.client.close());
    const order = await d.daemon.createOrder({ body: "operator test", kind: "order", to: target.rec.address }, undefined, "f".repeat(64));
    const path = `/api/threads/${order.threadId}/orders/${order.orderId}/reply`;
    const body = JSON.stringify({ agent: target.rec.address, text: "operator answer" });
    const post = (operatorKey?: string) => fetch(`http://${d.addr}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(operatorKey ? { "x-cafe-operator-key": operatorKey } : {}) },
      body,
    });

    expect((await post()).status).toBe(403);
    expect((await post("0".repeat(64))).status).toBe(403);
    const key = readFileSync(`${d.home}/operator.key`, "utf8");
    expect((await post(key)).status).toBe(200);
    await agentOrder!.reply("late Agent result");
    const thread = d.daemon.thread(order.threadId)!;
    expect(thread.events.find(({ event }) => event.type === "order.overridden")).toMatchObject({
      actor: { kind: "operator" }, event: { targetAgentId: target.rec.agentId, text: "operator answer", final: true },
    });
    expect(thread.events.find(({ event }) => event.type === "order.replied" && event.text === "late Agent result")?.event).toMatchObject({ auditOnly: true });
    expect(thread.meta.replies.map((reply) => reply.text)).toEqual(["operator answer"]);
  });

  it("requires an authenticated caller for HTTP order creation", async () => {
    const d = await startDaemon("caller-required");
    cleanups.push(d.stop);
    const response = await fetch(`http://${d.addr}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "no caller", idempotencyKey: "unscoped" }),
    });

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(401);
    expect(body).toMatchObject({ error: "caller_identity_required" });
  });
});
