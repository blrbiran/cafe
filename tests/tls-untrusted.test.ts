import { createServer } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { CafeClient } from "@cafe/protocol/client";
import { generateCa, issueLeaf } from "../packages/daemon/src/tls/certs.ts";
import { identity } from "./helpers.ts";

/**
 * Fail-closed check. It deliberately does not use `startDaemon`: `runDaemon` adds its own CA to the
 * process-wide trust store, so an in-process daemon would make the client trust it for the wrong
 * reason. Here the server's leaf is signed by CA-A and the client is told to trust CA-B only.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (await cleanup.length) await cleanup.pop()!();
});

describe("CafeClient refuses an untrusted TLS peer", () => {
  it("rejects a leaf the configured CA did not sign", async () => {
    const trusted = await generateCa();
    const other = await generateCa();
    const leaf = await issueLeaf(other, ["127.0.0.1", "localhost"]);
    const server = createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => res.end("{}"));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const c = new CafeClient({ daemon: `127.0.0.1:${port}`, token: "t0k", tls: { ca: trusted.cert }, reconnect: false });
    cleanup.push(() => c.close());
    await expect(c.connect(identity("nope"))).rejects.toThrow();
  }, 30_000);
});