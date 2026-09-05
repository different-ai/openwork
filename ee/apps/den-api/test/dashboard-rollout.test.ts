import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function probeDashboard(enabled?: string) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify({ enabled: env.dashboardsEnabled }))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.openwork.test",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(enabled === undefined ? {} : { DEN_DASHBOARDS_ENABLED: enabled }),
    },
  });
}

test("Dashboard availability is fail-closed and controlled by the deployment flag", () => {
  const unset = probeDashboard();
  const disabled = probeDashboard("false");
  const enabled = probeDashboard("true");

  expect(unset.status, unset.stderr).toBe(0);
  expect(unset.stdout.trim()).toBe('{"enabled":false}');
  expect(disabled.status, disabled.stderr).toBe(0);
  expect(disabled.stdout.trim()).toBe('{"enabled":false}');
  expect(enabled.status, enabled.stderr).toBe(0);
  expect(enabled.stdout.trim()).toBe('{"enabled":true}');
});

test("Desktop config advertises the effective Dashboard flag", () => {
  const meRoutes = readFileSync(path.join(denApiRoot, "src/routes/me/index.ts"), "utf8");
  expect(meRoutes).toContain("dashboardEnabled: env.dashboardsEnabled");
});
