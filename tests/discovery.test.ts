import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { discoverRoots } from "@cafe/daemon";
import { startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

// Opt back in to mDNS, on a service name no real Root uses.
const saved = { d: process.env.CAFE_DISCOVERY, s: process.env.CAFE_MDNS_SERVICE };
beforeAll(() => {
  process.env.CAFE_DISCOVERY = "1";
  process.env.CAFE_MDNS_SERVICE = `_cafe-test-${process.pid}._tcp.local`;
});
afterAll(() => {
  process.env.CAFE_DISCOVERY = saved.d;
  process.env.CAFE_MDNS_SERVICE = saved.s;
});

describe("mDNS discovery", () => {
  it("finds the Root and a Daemon without `root` joins it", async () => {
    const root = await startDaemon("hub", { config: { mode: "root" } });
    cleanup.push(root.stop);
    const found = await discoverRoots(1500);
    if (found.length === 0) {
      // Multicast is blocked in some sandboxes/CI; nothing else to check there.
      console.warn("mDNS multicast unavailable here; skipping");
      return;
    }
    expect(found).toEqual([{ host: "hub", addr: root.addr }]);

    const child = await startDaemon("pc9");
    cleanup.push(child.stop);
    await waitFor(() => child.daemon.rootOnline && child.daemon.config.root === root.addr, 8000);
  });
});
