import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("knownDaemons", () => {
  it("saves a child's address only after the Root can reach it", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    const child = await startDaemon("pc1", { config: { root: root.addr } });
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline);
    await waitFor(() => root.daemon.config.knownDaemons["pc1"] !== undefined);
    expect(root.daemon.config.knownDaemons["pc1"]).toContain("127.0.0.1");
  });

  it("does not poison knownDaemons with an address the Root cannot reach", async () => {
    const root = await startDaemon("root", { mode: "root" });
    cleanup.push(root.stop);
    // TEST-NET-1: never routable; the probe must time out and the address must not be saved.
    const child = await startDaemon("bad", { config: { root: root.addr, advertise: "192.0.2.1" } });
    cleanup.push(child.stop);
    await waitFor(() => root.daemon.daemons().some((d) => d.host === "bad" && d.online));
    await new Promise((r) => setTimeout(r, 1600));
    expect(root.daemon.config.knownDaemons["bad"]).toBeUndefined();
  }, 15_000);
});
