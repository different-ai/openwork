import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Run after @openwork/types build. Workspace symlinks hide Node's prohibition
// on loading TypeScript inside node_modules; copy the actual distributable files.
test("packaged runtime exports import in plain Node without a TypeScript loader", (t) => {
  const root = mkdtempSync(join(tmpdir(), "openwork-types-packaged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const destination = join(root, "node_modules/@openwork/types");
  mkdirSync(destination, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  copyFileSync(join(source, "package.json"), join(destination, "package.json"));
  for (const directory of manifest.files) {
    cpSync(join(source, directory), join(destination, directory), { recursive: true });
  }
  cpSync(join(source, "node_modules/zod"), join(root, "node_modules/zod"), {
    recursive: true, dereference: true,
  });

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { CATALOG_FAST_VARIANT, FAST_DEFAULT_VARIANT, catalogFastVariants, catalogModelVariants,
      nativeModelVariants, materializeLegacyFastProviders } from "@openwork/types/cloud-model-fast";
    import { gatewayUsagePolicyWriteSchema, gatewayUsageTimeframes,
      gatewayUsdToMicroUsd } from "@openwork/types/den/gateway-usage-limits";
    assert.ok(import.meta.resolve("@openwork/types/cloud-model-fast").endsWith("/dist/cloud-model-fast.js"));
    assert.ok(import.meta.resolve("@openwork/types/den/gateway-usage-limits").endsWith("/dist/den/gateway-usage-limits.js"));
    assert.deepEqual(gatewayUsageTimeframes, ["day", "week", "month"]);
    assert.equal(gatewayUsdToMicroUsd("1.25"), 1250000);
    assert.equal(gatewayUsagePolicyWriteSchema.parse({
      name: "Packaged runtime", limits: [{ timeframe: "day", costUsd: "1.25" }],
    }).hardLimit, true);
    const variants = catalogFastVariants({ experimental: { modes: {
      fast: { provider: { body: { service_tier: "priority" } } },
    } } }, "@ai-sdk/openai");
    assert.equal(variants[CATALOG_FAST_VARIANT].disabled, true);
    assert.deepEqual(nativeModelVariants(variants, "@opencode-ai/ai/providers/openai"), [
      { id: FAST_DEFAULT_VARIANT, settings: { providerOptions: { serviceTier: "priority" } } },
    ]);
    const anthropic = { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      variants: { low: { disabled: true }, high: { effort: "high", temperature: 0.5 } } };
    const efforts = catalogModelVariants(anthropic, "@ai-sdk/anthropic");
    assert.deepEqual(efforts, { low: { disabled: true }, high: { effort: "high", temperature: 0.5 },
      medium: { effort: "medium" }, xhigh: { effort: "xhigh" }, max: { effort: "max" } });
    assert.deepEqual(nativeModelVariants(efforts, "@opencode-ai/ai/providers/anthropic"), [
      { id: "high", settings: { providerOptions: { effort: "high", temperature: 0.5 } } },
      ...["medium", "xhigh", "max"].map(effort => ({ id: effort, settings: { providerOptions: { effort } } })),
    ]);
    for (const config of [{}, { ...anthropic, reasoning: false }, { ...anthropic, provider: { npm: "@ai-sdk/openai" } },
      { reasoning_options: [{ type: "effort", values: ["invented"] }] }, { reasoning_options: [{ type: "budget_tokens" }] }]) {
      assert.equal(catalogModelVariants(config, "@ai-sdk/anthropic"), undefined);
    }
    assert.equal(catalogModelVariants(anthropic, "@ai-sdk/openai-compatible"), undefined);
    const legacy = materializeLegacyFastProviders({ synthetic: {
      npm: "@ai-sdk/openai", models: { model: { variants } },
    } });
    assert.deepEqual(legacy.synthetic.models.model.variants, {
      [FAST_DEFAULT_VARIANT]: { serviceTier: "priority" },
    });
  `], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Bun imports usage-limit schemas from a clean source-only package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "openwork-types-bun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const destination = join(root, "node_modules/@openwork/types");
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(source, "package.json"), join(destination, "package.json"));
  cpSync(join(source, "src"), join(destination, "src"), { recursive: true });
  cpSync(join(source, "node_modules/zod"), join(root, "node_modules/zod"), { recursive: true, dereference: true });
  assert.equal(existsSync(join(destination, "dist")), false);
  const result = spawnSync("bun", ["--eval", `
    import assert from "node:assert/strict";
    import { gatewayUsdToMicroUsd, gatewayUsageTimeframes } from "@openwork/types/den/gateway-usage-limits";
    assert.ok(import.meta.resolve("@openwork/types/den/gateway-usage-limits").endsWith("/src/den/gateway-usage-limits.ts"));
    assert.equal(gatewayUsdToMicroUsd("1.25"), 1250000);
    assert.deepEqual(gatewayUsageTimeframes, ["day", "week", "month"]);
  `], { cwd: root, encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NODE_OPTIONS: "", NODE_PATH: "" } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const workspacePackages = {
  "@openwork/types": "packages/types",
  "@openwork/ui": "packages/ui",
  "@openwork-ee/utils": "ee/packages/utils",
};
const productionEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);
Object.assign(productionEnv, { NODE_ENV: "production", CI: "1", NEXT_TELEMETRY_DISABLED: "1" });

function writeFixture(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function copyPackage(root, path, files = []) {
  const source = join(workspace, path);
  const target = join(root, path);
  mkdirSync(target, { recursive: true });
  for (const file of ["package.json", ...files]) {
    cpSync(join(source, file), join(target, file), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const dependencies = new Set([
    ".bin", ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const name of dependencies) {
    const installed = join(source, "node_modules", name);
    if (!existsSync(installed)) continue;
    const link = join(target, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(workspacePackages[name] ? join(root, workspacePackages[name]) : realpathSync(installed), link, "junction");
  }
  return manifest;
}

function runProduction(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", env: productionEnv, timeout: 180_000, maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

for (const [path, script] of [
  ["ee/apps/den-web", "build"],
  ["apps/app", "build"],
  ["apps/app", "build:web"],
]) {
  test(`${path} ${script} builds runtime exports from clean outputs without development conditions`, () => {
    const root = mkdtempSync(join(workspace, ".gateway-production-test-"));
    try {
      mkdirSync(join(root, "node_modules"));
      symlinkSync(join(workspace, "node_modules/.pnpm"), join(root, "node_modules/.pnpm"), "junction");
      const rootManifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
      writeFixture(root, "package.json", JSON.stringify({
        name: "production-build-fixture", private: true, packageManager: rootManifest.packageManager,
      }));
      writeFixture(root, "pnpm-workspace.yaml", `${readFileSync(join(workspace, "pnpm-workspace.yaml"), "utf8")}\nverifyDepsBeforeRun: false\n`);
      copyPackage(root, "packages/types", ["src", "tsconfig.json", "tsup.config.ts"]);
      copyPackage(root, "packages/ui", ["src", "tsconfig.react.json", "tsup.config.react.ts"]);
      copyPackage(root, "ee/packages/utils", ["src", "tsconfig.json", "tsup.config.ts"]);
      const manifest = copyPackage(root, path);
      const app = join(root, path);
      const entry = `
        import { gatewayUsageTimeframes, gatewayUsagePolicyWriteSchema,
          gatewayUsdToMicroUsd } from "@openwork/types/den/gateway-usage-limits";
        const policy = gatewayUsagePolicyWriteSchema.parse({
          name: "Production fixture", limits: [{ timeframe: "day", costUsd: "1.25" }],
        });
        const value = gatewayUsageTimeframes.join("/") + ":" + gatewayUsdToMicroUsd(policy.limits[0].costUsd);
      `;
      if (path === "ee/apps/den-web") {
        writeFixture(app, "next.config.js", `module.exports = { turbopack: { root: ${JSON.stringify(workspace)} } };`);
        writeFixture(app, "app/layout.jsx", 'export default function Layout({ children }) { return <html><body>{children}</body></html>; }');
        writeFixture(app, "app/client.jsx", `"use client"; ${entry} export default function Client() { return <p>{value}</p>; }`);
        writeFixture(app, "app/page.jsx", `${entry} import Client from "./client"; export default function Page() { return <main>{value}<Client /></main>; }`);
      } else {
        writeFixture(app, "vite.config.js", 'export default { build: { modulePreload: false } };');
        writeFixture(app, "index.html", '<html><body><script type="module" src="/main.js"></script></body></html>');
        writeFixture(app, "main.js", `${entry} document.body.textContent = value;`);
      }
      for (const packagePath of Object.values(workspacePackages)) {
        assert.equal(existsSync(join(root, packagePath, "dist")), false);
      }
      runProduction("pnpm", ["--filter", manifest.name, script], root);
      assert.ok(existsSync(join(root, "packages/types/dist/den/gateway-usage-limits.js")));
      runProduction(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { gatewayUsdToMicroUsd } from "@openwork/types/den/gateway-usage-limits";
        assert.ok(import.meta.resolve("@openwork/types/den/gateway-usage-limits").endsWith("/dist/den/gateway-usage-limits.js"));
        assert.equal(gatewayUsdToMicroUsd("1.25"), 1250000);
      `], app);
      if (path === "ee/apps/den-web") {
        const html = readFileSync(join(app, ".next/server/app/index.html"), "utf8");
        assert.ok(html.includes("day/week/month:1250000"));
      } else {
        const html = readFileSync(join(app, "dist/index.html"), "utf8");
        const asset = html.match(/src="([^"]+\.js)"/)?.[1];
        assert.ok(asset, html);
        runProduction(process.execPath, ["--input-type=module", "-e", `
          import assert from "node:assert/strict";
          globalThis.document = { body: { textContent: "" } };
          await import(${JSON.stringify(`./dist${asset}`)});
          assert.equal(document.body.textContent, "day/week/month:1250000");
        `], app);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
