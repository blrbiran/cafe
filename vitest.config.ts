import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    // Test daemons must not answer or search mDNS on the real LAN; tests/discovery.test.ts opts back in.
    // The FAST lease is 200 ms × 3 = 600 ms; without this hook a Bridge's default
    // 30 s keepAlive interval loses any Order that takes longer than the lease (#6).
    env: { CAFE_DISCOVERY: "0", CAFE_HEARTBEAT_INTERVAL_MS: "200" },
  },
});
