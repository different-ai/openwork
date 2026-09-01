import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";

const dirnameHere = path.dirname(fileURLToPath(import.meta.url));
const coworkerRoot = path.resolve(dirnameHere, "..");

test("Open Coworker has its own stable packaged identity and local runtime resources", async () => {
  const packageMetadata = JSON.parse(await readFile(path.join(coworkerRoot, "package.json"), "utf8"));
  const config = YAML.parse(await readFile(path.join(coworkerRoot, "electron-builder.yml"), "utf8"));
  assert.equal(packageMetadata.version, "0.0.0-dev");
  assert.equal(packageMetadata.desktopName, "com.differentai.opencoworker");
  assert.equal(config.appId, "com.differentai.opencoworker");
  assert.equal(config.productName, "Open Coworker");
  assert.equal(config.artifactName, "open-coworker-${os}-${arch}-${version}.${ext}");
  assert.equal(config.extraMetadata.main, "electron-dist/main.mjs");
  assert.ok(config.files.includes("electron-dist/**/*"));
  assert.ok(!config.files.includes("electron/**/*"));
  assert.ok(config.files.includes("server/**/*"));
  assert.ok(config.files.includes("dist/**/*"));
  assert.deepEqual(config.extraResources[0], {
    from: "resources/sidecars",
    to: "sidecars",
    filter: ["opencode", "opencode.exe", "opencode-*", "versions.json", "versions.json-*"],
  });
});

test("Open Coworker mirrors every embedded-server runtime dependency for electron-builder", async () => {
  const coworkerPackage = JSON.parse(await readFile(path.join(coworkerRoot, "package.json"), "utf8"));
  const serverPackage = JSON.parse(await readFile(path.resolve(coworkerRoot, "..", "server", "package.json"), "utf8"));
  for (const [name, version] of Object.entries(serverPackage.dependencies)) {
    assert.equal(
      coworkerPackage.dependencies[name],
      version,
      `Embedded server dependency ${name} must be mirrored in apps/coworker/package.json`,
    );
  }
});
