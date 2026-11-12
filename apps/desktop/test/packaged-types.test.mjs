import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compiledTypesExports, stageRuntimeNodeModules } from "../scripts/prepare-runtime-node-modules.mjs";

const checkout = JSON.parse(readFileSync(new URL("../../../packages/types/package.json", import.meta.url), "utf8"));

test("the packaged app can load every @openwork/types export as plain Node, whichever one is imported", (t) => {
  const root = mkdtempSync(join(tmpdir(), "openwork-packaged-types-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  stageRuntimeNodeModules(join(root, "node_modules"));
  const installed = join(root, "node_modules", "@openwork", "types");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

  // Same exports as the checkout, so an import that typechecks also resolves here.
  assert.deepEqual(Object.keys(manifest.exports).sort(), Object.keys(checkout.exports).sort());
  // Node refuses to run TypeScript under node_modules: none may ship.
  const shipped = readdirSync(installed, { recursive: true }).map(String);
  assert.deepEqual(shipped.filter((file) => file.endsWith(".ts")), []);

  const specifiers = Object.keys(manifest.exports).map((subpath) => `@openwork/types${subpath.slice(1)}`);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const failures = [];
    for (const specifier of ${JSON.stringify(specifiers)}) {
      try { await import(specifier); } catch (error) { failures.push(specifier + ": " + error.message); }
    }
    if (failures.length > 0) { console.error(failures.join("\\n")); process.exit(1); }
  `], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("an export without TypeScript source cannot be packaged", () => {
  assert.deepEqual(compiledTypesExports({ "./den/prompts": { development: "./src/den/prompts.ts", default: "./dist/den/prompts.js" } }),
    { "./den/prompts": "./dist/den/prompts.js" });
  assert.throws(() => compiledTypesExports({ "./built-only": { default: "./dist/built-only.js" } }), /built-only has no TypeScript source/);
});
