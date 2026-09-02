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
  // Den handoffs deep-link back into this app, never into OpenWork's scheme.
  assert.deepEqual(config.protocols, [{ name: "Open Coworker", schemes: ["opencoworker"] }]);
  assert.ok(config.files.includes("electron-dist/**/*"));
  assert.ok(!config.files.includes("electron/**/*"));
  assert.ok(config.files.includes("server/**/*"));
  assert.ok(config.files.includes("dist/**/*"));
  assert.ok(config.files.includes("resources/icons/**/*"));
  assert.equal(config.mac.icon, "resources/icons/icon.icns");
  assert.equal(config.linux.icon, "resources/icons/linux");
  assert.equal(config.win.icon, "resources/icons/icon.ico");
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

test("Open Coworker owns a branded boot surface and cross-platform icon set", async () => {
  const indexHtml = await readFile(path.join(coworkerRoot, "index.html"), "utf8");
  const logoSvg = await readFile(path.join(coworkerRoot, "public", "open-coworker.svg"), "utf8");
  const appIconSvg = await readFile(path.join(coworkerRoot, "resources", "icons", "open-coworker-app-icon.svg"), "utf8");
  assert.match(indexHtml, /class="boot-splash"/);
  assert.match(indexHtml, /href="\/open-coworker\.svg"/);
  assert.match(logoSvg, /fill="#f7f8fa"/);
  assert.match(logoSvg, /fill="none" stroke="#11151d"/);
  assert.match(logoSvg, /fill="#d9dde4" stroke="#aeb5c0"/);
  assert.match(logoSvg, /stroke="#aeb5c0"/);
  assert.doesNotMatch(logoSvg, /fill="#5b8dff"/);
  assert.match(appIconSvg, /fill="#5b8dff"/);
  assert.match(appIconSvg, /fill="#f7f8fa"/);
  await Promise.all([
    "resources/icons/icon.png",
    "resources/icons/icon.icns",
    "resources/icons/icon.ico",
    "resources/icons/linux/512x512.png",
  ].map((relativePath) => readFile(path.join(coworkerRoot, relativePath))));
});
