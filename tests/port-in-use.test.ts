import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./helpers.ts";

/**
 * A second Daemon on the same machine used to fail with a bare `listen EADDRINUSE 0.0.0.0:4778`. The
 * user does not know 4778 is the TLS port or which setting moves it; say so.
 *
 * Own file: a TLS Daemon adds its CA to the process-wide trust store.
 */
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("a port already in use is reported with the setting that moves it", () => {
  it("names security.tls.port when the TLS port is taken", async () => {
    const first = await startDaemon("tfirst", { config: { security: { mode: "tls", tls: { port: 0 } } } });
    cleanup.push(first.stop);
    const taken = first.server.tlsPort!;
    const err = await startDaemon("tsecond", { config: { security: { mode: "tls", tls: { port: taken } } } }).then(
      (d) => (cleanup.push(d.stop), undefined),
      (e: Error) => e,
    );
    expect(err?.message).toContain(`TLS port ${taken} is already in use`);
    expect(err?.message).toContain("cafe config set security.tls.port");
  }, 30_000);

  it("names port when the main port is taken", async () => {
    const first = await startDaemon("pfirst");
    cleanup.push(first.stop);
    const taken = first.server.port;
    const err = await startDaemon("psecond", { config: { security: { mode: "plaintext" }, port: taken } }).then(
      (d) => (cleanup.push(d.stop), undefined),
      (e: Error) => e,
    );
    expect(err?.message).toContain(`port ${taken} is already in use`);
    expect(err?.message).toContain("cafe config set port");
  }, 30_000);
});
