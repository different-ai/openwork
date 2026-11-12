import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { compiledTypesExports, stageRuntimeNodeModules } from "../scripts/prepare-runtime-node-modules.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
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

// Exercise ASAR's actual lookup with both path implementations on any host.
// Keep archive I/O native; only the lookup and the hook use the simulated path.
function loadWithPath(filename, platformPath, overrides = {}) {
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, "utf8"), {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === "path" || name === "node:path") return platformPath;
      return overrides[name] ?? localRequire(name);
    },
  }, { filename });
  return module.exports;
}

for (const [platform, platformPath] of [["POSIX", path.posix], ["Windows", path.win32]]) {
  for (const scenario of [
    { name: "accepts compiled exports", exports: { "./den/prompts": "./dist/den/prompts.js" } },
    { name: "rejects a missing compiled file", exports: { "./den/prompts": "./dist/den/missing.js" }, error: /not compiled JavaScript: \.\/den\/prompts/ },
    { name: "rejects TypeScript exports", exports: { "./den/prompts": "./src/den/prompts.ts" }, error: /not compiled JavaScript: \.\/den\/prompts/ },
    { name: "rejects conditional exports", exports: { "./den/prompts": { default: "./dist/den/prompts.js" } }, error: /not compiled JavaScript: \.\/den\/prompts/ },
    { name: "rejects stray TypeScript source", exports: { "./den/prompts": "./dist/den/prompts.js" }, source: true, error: /still ships TypeScript source/ },
  ]) {
    test(`${platform}: packaged archive ${scenario.name}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "openwork-types-asar-"));
      const archivePath = join(root, "app.asar");
      t.after(() => {
        asar.uncache(archivePath);
        rmSync(root, { recursive: true, force: true });
      });
      const input = join(root, "input");
      const packageRoot = join(input, "node_modules", "@openwork", "types");
      mkdirSync(join(packageRoot, "dist", "den"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ exports: scenario.exports }));
      writeFileSync(join(packageRoot, "dist", "den", "prompts.js"), "export const prompt = 'ready';\n");
      if (scenario.source) writeFileSync(join(packageRoot, "source.ts"), "export type Prompt = string;\n");
      await asar.createPackage(input, archivePath);

      const { Filesystem } = loadWithPath(require.resolve("@electron/asar/lib/filesystem.js"), platformPath);
      const filesystem = new Filesystem(archivePath);
      const { header, headerSize } = asar.getRawHeader(archivePath);
      filesystem.setHeader(header, headerSize);
      const { verifyCompiledTypes, normalizeAsarEntryPath } = loadWithPath(
        require.resolve("../scripts/electron-after-pack.cjs"), platformPath, {
          "@electron/asar": {
            extractFile: (archive, filename) => {
              filesystem.getFile(filename);
              return asar.extractFile(archive, filename.split(platformPath.sep).join(path.sep));
            },
          },
        },
      );
      const packagedFiles = new Set(filesystem.listFiles().map((entry) => normalizeAsarEntryPath(entry, platformPath.sep)));
      const verify = () => verifyCompiledTypes(archivePath, packagedFiles);
      if (scenario.error) assert.throws(verify, scenario.error);
      else assert.doesNotThrow(verify);
    });
  }
}
