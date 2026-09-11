import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Run after @openwork/types build. Workspace symlinks hide Node's prohibition
// on loading TypeScript inside node_modules; copy the actual distributable files.
test("packaged cloud-model-fast imports in plain Node without a TypeScript loader", (t) => {
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
    import { CATALOG_FAST_VARIANT, FAST_DEFAULT_VARIANT, catalogFastVariants,
      nativeModelVariants, materializeLegacyFastProviders } from "@openwork/types/cloud-model-fast";
    assert.ok(import.meta.resolve("@openwork/types/cloud-model-fast").endsWith("/dist/cloud-model-fast.js"));
    const variants = catalogFastVariants({ experimental: { modes: {
      fast: { provider: { body: { service_tier: "priority" } } },
    } } }, "@ai-sdk/openai");
    assert.equal(variants[CATALOG_FAST_VARIANT].disabled, true);
    assert.deepEqual(nativeModelVariants(variants, "@opencode-ai/ai/providers/openai"), [
      { id: FAST_DEFAULT_VARIANT, settings: { providerOptions: { serviceTier: "priority" } } },
    ]);
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
