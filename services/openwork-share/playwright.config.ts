import { defineConfig } from "@playwright/test";

const openworkAppUrl = process.env.OPENWORK_APP_URL
  ? new URL(process.env.OPENWORK_APP_URL)
  : new URL("http://127.0.0.1:5173");

const shouldStartOpenworkApp = process.env.OPENWORK_APP_URL === undefined;
const webServers = [
  {
    command: "OPENWORK_DEV_MODE=1 pnpm exec next dev --hostname 127.0.0.1 --port 3100 --webpack",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
];

if (shouldStartOpenworkApp) {
  webServers.push({
    command:
      `OPENWORK_DEV_MODE=1 pnpm --dir ../../packages/app dev:web -- --host ${openworkAppUrl.hostname} --port ${openworkAppUrl.port || "5173"}`,
    url: openworkAppUrl.origin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  });
}

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
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: webServers,
});
