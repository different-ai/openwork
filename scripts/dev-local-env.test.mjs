import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const turbo = createRequire(import.meta.url).resolve("turbo");
const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packages = ["den-api", "den-web", "gateway"];
const singleton = {
  DEN_SINGLE_ORG_NAME: "Synthetic Organization",
  DEN_SINGLE_ORG_SLUG: "synthetic-org",
  DEN_SINGLE_ORG_OWNER_EMAILS: "owner@example.test,second@example.test",
};
const gateway = {
  GATEWAY_PORT: "18971",
  GATEWAY_PROXY_BASE_URL: "https://gateway.example.test",
  GATEWAY_ADMIN_TOKEN: "synthetic-admin-token",
  GATEWAY_WEBHOOK_SECRET: "synthetic-webhook-secret",
  GATEWAY_UPSTREAM_TIMEOUT_MS: "3456",
  GATEWAY_CREDITS_PER_DOLLAR: "321",
  GATEWAY_EGRESS_ALLOWED_ORIGINS: "https://upstream.example.test",
};
const legacy = Object.fromEntries(Object.keys(gateway).map((key, index) => [
  key.replace("GATEWAY_", "INFERENCE_"), `synthetic-legacy-${index}`,
]));
const unrelated = {
  UNRELATED_SECRET: "synthetic-unrelated-secret",
  DEN_SINGLE_ORG_UNRELATED_SECRET: "synthetic-singleton-secret",
  GATEWAY_UNRELATED_SECRET: "synthetic-gateway-secret",
  INFERENCE_UNRELATED_SECRET: "synthetic-legacy-secret",
};
const keys = [
  "DEN_ORG_MODE", "DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP",
  ...Object.keys(singleton), ...Object.keys(gateway), ...Object.keys(legacy), ...Object.keys(unrelated),
];
const cases = [
  { name: "unset flags preserve private defaults", env: {} },
  { name: "single-org public", env: { ...singleton, DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true" } },
  { name: "single-org private", env: { ...singleton, DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false" } },
  { name: "single-org default private", env: { DEN_ORG_MODE: "single_org" } },
  { name: "multi-org default", env: { DEN_ORG_MODE: "multi_org" } },
  { name: "multi-org explicit true", env: { DEN_ORG_MODE: "multi_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true" } },
  { name: "multi-org explicit false", env: { DEN_ORG_MODE: "multi_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false" } },
  { name: "canonical gateway overrides", env: gateway },
  { name: "legacy gateway aliases", env: legacy },
  { name: "canonical and legacy gateway values stay distinct", env: { ...gateway, ...legacy } },
  { name: "empty canonical gateway values stay empty alongside aliases", env: {
    ...Object.fromEntries(Object.keys(gateway).map((key) => [key, ""])), ...legacy,
  } },
  { name: "web-local command defaults to multi-org signup", viaWebLocal: true, env: {},
    expected: { DEN_ORG_MODE: "multi_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true" } },
  { name: "web-local command preserves explicit private overrides", viaWebLocal: true,
    env: { DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false" } },
];

for (const scenario of cases) {
  test(`dev:web-local strict Turbo propagation: ${scenario.name}`, async () => {
    const pnpm = (process.env.PATH ?? "").split(delimiter)
      .map((directory) => resolve(directory, "pnpm")).find(existsSync);
    assert.ok(pnpm, "pnpm must be installed on PATH to run the Turbo fixture");
    const root = await mkdtemp(join(tmpdir(), "openwork-turbo-env-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await symlink(process.execPath, join(bin, "node"));
      await symlink(pnpm, join(bin, "pnpm"));
      await copyFile(new URL("../turbo.json", import.meta.url), join(root, "turbo.json"));
      const turboArgs = [
        turbo, "run", "dev:local", "--env-mode=strict", "--no-daemon",
        ...packages.map((name) => `--filter=@openwork-ee/${name}`),
      ];
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "synthetic-dev-web-local", private: true, packageManager: "pnpm@11.4.0",
        scripts: {
          "dev:web-local": rootPackage.scripts["dev:web-local"],
          "dev:den": "node launch.cjs",
        },
      }));
      // Exercise the real web-local command, substituting only the downstream
      // launcher so this test never starts the developer's database/services.
      await writeFile(join(root, "launch.cjs"), `
        const { spawnSync } = require("node:child_process");
        const result = spawnSync(process.execPath, ${JSON.stringify(turboArgs)}, { stdio: "inherit" });
        process.exit(result.status ?? 1);
      `);
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n" +
        packages.map((name) => `  packages/${name}: {}\n`).join(""));
      // Observe the child environment, not Turbo's dry-run/hash metadata or a copied policy implementation.
      await writeFile(join(root, "probe.cjs"), `
        const { writeFileSync } = require("node:fs");
        const keys = ${JSON.stringify(keys)};
        writeFileSync("observed.json", JSON.stringify(Object.fromEntries(
          keys.map(key => [key, process.env[key] ?? null])
        )));
      `);
      for (const name of packages) {
        const directory = join(root, "packages", name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({
          name: `@openwork-ee/${name}`, private: true,
          scripts: { "dev:local": "node ../../probe.cjs" },
        }));
      }
      const result = spawnSync(scenario.viaWebLocal ? pnpm : process.execPath,
        scenario.viaWebLocal ? ["run", "dev:web-local"] : turboArgs, {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        // Never inherit the developer's credentials, dotenv files, Turbo config, or running services.
        env: {
          PATH: [bin, "/usr/bin", "/bin"].join(delimiter), HOME: root, TMPDIR: root,
          XDG_CONFIG_HOME: root, CI: "1", TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1",
          ...scenario.env, ...unrelated,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const expected = Object.fromEntries(keys.map((key) => [key, (scenario.expected ?? scenario.env)[key] ?? null]));
      for (const name of packages) {
        const observed = JSON.parse(await readFile(join(root, "packages", name, "observed.json"), "utf8"));
        assert.deepEqual(observed, expected, `${name}: literal values forwarded; absent flags and unrelated secrets absent`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
