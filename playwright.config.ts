import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3210" },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3210/health",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "3210",
      SHOPIFY_API_KEY: "synthetic-contract-test-key",
      SHOPIFY_API_SECRET:
        "synthetic-contract-test-secret-for-local-verification-only",
      SHOPIFY_APP_URL: "http://127.0.0.1:3210",
      SYNC_WRITE_ENABLED: "false",
      INVENTORY_WRITE_ENABLED: "false",
    },
  },
});
