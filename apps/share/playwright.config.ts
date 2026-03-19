import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "../../tmp/openwork-share-playwright",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "OPENWORK_DEV_MODE=1 pnpm exec next dev --hostname 127.0.0.1 --port 3100 --webpack",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
