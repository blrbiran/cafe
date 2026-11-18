import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
