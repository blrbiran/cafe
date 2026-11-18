import { describe, expect, it } from "vitest";
import { CafeClient, defaultReconnectMaxMs } from "@cafe/protocol/client";
import { identity, startDaemon, waitFor } from "./helpers.ts";

describe("client reconnect", () => {
  it("keeps retrying while the daemon stays down, then re-registers", async () => {
    const first = await startDaemon("rc", { config: { mode: "root" } });
    const port = first.server.port;
    const c = new CafeClient({ daemon: first.addr, token: "t0k", reconnect: true });
    let connects = 0;
    c.onConnect(() => void connects++);
    const rec = await c.connect(identity("echo"));
    await first.stop();
    // Long enough for several failed attempts: Node's WebSocket reports a refused
    // connection with `error` only, which used to end the retry chain.
    await new Promise((r) => setTimeout(r, 1800));
    const second = await startDaemon("rc", { config: { mode: "root", port } });
    try {
      await waitFor(() => connects >= 2, 8000);
      expect(c.record?.agentId).toBe(rec!.agentId);
    } finally {
      c.close();
      await second.stop();
    }
  }, 15000);

  it("waits at most 5 s between attempts for a local daemon, 30 s for a remote one", () => {
    expect(defaultReconnectMaxMs("127.0.0.1:4777")).toBe(5000);
    expect(defaultReconnectMaxMs("localhost:4777")).toBe(5000);
    expect(defaultReconnectMaxMs("[::1]:4777")).toBe(5000);
    expect(defaultReconnectMaxMs("192.168.3.129:4777")).toBe(30000);
  });
});
