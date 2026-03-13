import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: "list",
  outputDir: "../../tmp/openwork-app-playwright",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "OPENWORK_DEV_MODE=1 pnpm exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/skills-launcher-harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
