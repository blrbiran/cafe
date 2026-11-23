import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { barista, customer, identity, startDaemon, untilClosed, waitFor } from "./helpers.ts";

/**
 * A TLS child Daemon reaching a TLS Root over `wss://` (v4-6). In its own file: the child adds the
 * Root's CA to the process-wide trust store, which would otherwise make other TLS tests in the same
 * worker pass for the wrong reason.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

describe("a TLS child daemon reaches a TLS Root", () => {
  it("connects over wss and relays a question to a Barista on the Root", async () => {
    const rootHome = mkdtempSync(join(tmpdir(), "cafe-tls-root-"));
    const childHome = mkdtempSync(join(tmpdir(), "cafe-tls-child-"));
    cleanup.push(() => rmSync(rootHome, { recursive: true, force: true }), () => rmSync(childHome, { recursive: true, force: true }));

    const root = await startDaemon("tlsroot", { home: rootHome, mode: "root", config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(root.stop);
    // A child copies the Root's CA on enrolment (what `cafe connect` will do for a person).
    const ca = readFileSync(join(rootHome, "tls", "ca.crt"), "utf8");
    mkdirSync(join(childHome, "tls"), { recursive: true });
    writeFileSync(join(childHome, "tls", "ca.crt"), ca);
    const child = await startDaemon("tlschild", {
      home: childHome,
      config: { root: `127.0.0.1:${root.server.tlsPort}`, security: { mode: "tls", tls: { port: 0 } } },
    });
    cleanup.push(child.stop);

    await waitFor(() => child.daemon.rootOnline, 10_000);
    const b = await barista(root.addr, identity("tlsbilling", { tags: ["invoice"] }));
    cleanup.push(() => b.client.close());
    const c = await customer(child.addr);
    cleanup.push(() => c.close());
    const res = await c.ask({ body: "the invoice total is wrong" });
    const events = await untilClosed(c, res.threadId, res.orderId);
    expect(events.find((e) => e.event.type === "order.replied")?.event).toMatchObject({ agentId: b.rec.agentId });
  }, 40_000);
});