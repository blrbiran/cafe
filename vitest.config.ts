import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    // Test daemons must not answer or search mDNS on the real LAN; tests/discovery.test.ts opts back in.
    env: { CAFE_DISCOVERY: "0" },
  },
});
