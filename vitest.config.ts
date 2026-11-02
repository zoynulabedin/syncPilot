import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    env: { SYNC_WRITE_ENABLED: "false", INVENTORY_WRITE_ENABLED: "false" },
  },
});
