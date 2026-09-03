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
  // The engine loads OpenWork's plugins (Connect steering, extension canaries) from
  // Resources/opencode-plugins when the server runs inside the asar, so they ship
  // beside it exactly as the desktop packages them.
  assert.ok(config.files.includes("!server/dist/opencode-plugins/**"));
  assert.deepEqual(config.extraResources[1], {
    from: "server/dist/opencode-plugins",
    to: "opencode-plugins",
    filter: ["*.js"],
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
  assert.match(appIconSvg, /data-layer="rear-coworker-left"/);
  assert.match(appIconSvg, /data-layer="rear-coworker-right"/);
  assert.match(appIconSvg, /linearGradient id="mint-surface"/);
  assert.match(appIconSvg, /linearGradient id="lavender-surface"/);
  assert.match(appIconSvg, /data-layer="front-coworker"/);
  assert.match(appIconSvg, /linearGradient id="avatar-surface"/);
  assert.match(appIconSvg, /fill="url\(#avatar-surface\)"/);
  assert.match(appIconSvg, /stop-color="#edf0f4"/);
  assert.doesNotMatch(appIconSvg, /radialGradient/);
  const [iconPng, iconIcns, iconIco, linuxIcon] = await Promise.all([
    "resources/icons/icon.png",
    "resources/icons/icon.icns",
    "resources/icons/icon.ico",
    "resources/icons/linux/512x512.png",
  ].map((relativePath) => readFile(path.join(coworkerRoot, relativePath))));
  assert.equal(iconPng.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(iconPng.readUInt32BE(16), 1024);
  assert.equal(iconPng.readUInt32BE(20), 1024);
  assert.equal(iconIcns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(iconIco.readUInt16LE(2), 1);
  assert.equal(iconIco.readUInt16LE(4), 7);
  assert.equal(linuxIcon.readUInt32BE(16), 512);
  assert.equal(linuxIcon.readUInt32BE(20), 512);
});

test("Open Coworker presents a custom, legible drag-to-Applications installer", async () => {
  const config = YAML.parse(await readFile(path.join(coworkerRoot, "electron-builder.yml"), "utf8"));
  const backgroundSvg = await readFile(
    path.join(coworkerRoot, "resources", "installer", "dmg-background.svg"),
    "utf8",
  );
  const backgroundPng = await readFile(
    path.join(coworkerRoot, "resources", "installer", "dmg-background.png"),
  );

  assert.equal(config.dmg.title, "Open Coworker");
  assert.equal(config.dmg.background, "resources/installer/dmg-background.png");
  assert.equal(config.dmg.icon, "resources/icons/icon.icns");
  assert.equal(config.dmg.iconSize, 118);
  assert.equal(config.dmg.iconTextSize, 13);
  assert.deepEqual(config.dmg.window, { width: 760, height: 500 });
  assert.deepEqual(config.dmg.contents, [
    { x: 180, y: 285 },
    { x: 580, y: 285, type: "link", path: "/Applications" },
  ]);
  assert.match(backgroundSvg, /Welcome to your new team/);
  assert.match(backgroundSvg, /Local by default/);
  assert.doesNotMatch(backgroundSvg, /Ready for your Mac/);
  assert.doesNotMatch(backgroundSvg, /(?:linear|radial)Gradient|<filter/);
  assert.equal(backgroundPng.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(backgroundPng.readUInt32BE(16), 760);
  assert.equal(backgroundPng.readUInt32BE(20), 500);
});
