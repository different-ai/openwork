import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import { bindWindowAppearance, windowMaterial } from "./window-appearance.mjs";

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
    filter: ["*.js", "*.wasm", "!*.test.js"],
  });
  // The browser plugin ships bundled with the embedded server (dev's openwork-chrome-devtools), pinned exactly,
  // so a coworker team's cold start never asks the engine to install it.
  const serverPackage = JSON.parse(await readFile(path.resolve(coworkerRoot, "..", "server", "package.json"), "utf8"));
  assert.equal(serverPackage.devDependencies["opencode-chrome-devtools"], "1.0.4");
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
  assert.match(indexHtml, /class="boot-splash"/);
  assert.match(indexHtml, /href="\/open-coworker\.svg"/);
  assert.match(logoSvg, /fill="#f7f8fa"/);
  assert.match(logoSvg, /fill="none" stroke="#11151d"/);
  assert.match(logoSvg, /fill="#d9dde4" stroke="#aeb5c0"/);
  assert.match(logoSvg, /stroke="#aeb5c0"/);
  assert.doesNotMatch(logoSvg, /fill="#5b8dff"/);
  const [iconPng, macIconPng, artwork, iconIcns, iconIco, linuxIcon] = await Promise.all([
    "resources/icons/icon.png",
    "resources/icons/icon-macos.png",
    "resources/icons/open-coworker-app-icon.png",
    "resources/icons/icon.icns",
    "resources/icons/icon.ico",
    "resources/icons/linux/512x512.png",
  ].map((relativePath) => readFile(path.join(coworkerRoot, relativePath))));
  assert.equal(iconPng.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(iconPng.readUInt32BE(16), 1024);
  assert.equal(iconPng.readUInt32BE(20), 1024);
  assert.deepEqual(macIconPng, iconPng, "Dock and cross-platform icons must share the same artwork");
  assert.equal(artwork.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(artwork.readUInt32BE(16) >= 1024);
  assert.equal(artwork.readUInt32BE(16), artwork.readUInt32BE(20));
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
  assert.deepEqual(config.dmg.window, { width: 760, height: 600 });
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
  assert.equal(backgroundPng.readUInt32BE(20), 600);
  const retina = await readFile(path.join(coworkerRoot, "resources", "installer", "dmg-background@2x.png"));
  assert.equal(retina.readUInt32BE(16), 1520);
  assert.equal(retina.readUInt32BE(20), 1200);
  assert.match(backgroundSvg, /data-brand="white-coworker"/);
  assert.match(backgroundSvg, /xlink:href="\.\.\/\.\.\/public\/open-coworker\.svg"/);
  assert.match(backgroundSvg, /Launch Open Coworker from Applications/);
  assert.match(backgroundSvg, /you can eject this installer/);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.installerHeaderIcon, config.win.icon);
  assert.equal(config.nsis.createDesktopShortcut, false);
  assert.equal(config.nsis.runAfterFinish, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("native window materials follow accessibility changes and release their listeners when closed", () => {
  assert.equal(windowMaterial({}, "darwin"), "vibrancy");
  assert.equal(windowMaterial({}, "win32", "10.0.22621"), "mica");
  assert.equal(windowMaterial({}, "win32", "10.0.22000"), "none");
  assert.equal(windowMaterial({}, "linux"), "none");
  for (const preference of ["prefersReducedTransparency", "shouldUseHighContrastColors", "inForcedColorsMode", "shouldUseInvertedColorScheme"]) {
    for (const platform of ["darwin", "win32"]) {
      assert.equal(windowMaterial({ [preference]: true }, platform, "10.0.22621"), "none");
    }
  }

  const calls = [];
  const theme = Object.assign(new EventEmitter(), { prefersReducedTransparency: false });
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: (_channel, appearance) => calls.push(appearance) }),
    isFocused: () => true,
    setVibrancy: (value) => calls.push(value),
    setBackgroundColor: (value) => calls.push(value),
  });
  bindWindowAppearance(window, theme, "darwin");
  assert.deepEqual(calls.slice(-3), ["under-window", "#00000000", { material: "vibrancy", focused: true }]);
  theme.prefersReducedTransparency = true;
  theme.emit("updated");
  assert.deepEqual(calls.slice(-3), [null, "#090c12", { material: "none", focused: true }]);
  window.isFocused = () => false;
  window.emit("blur");
  assert.deepEqual(calls.at(-1), { material: "none", focused: false });
  theme.prefersReducedTransparency = false;
  theme.emit("updated");
  assert.deepEqual(calls.at(-1), { material: "vibrancy", focused: false });
  window.emit("closed");
  const beforeClosed = calls.length;
  theme.emit("updated");
  window.webContents.emit("did-finish-load");
  assert.equal(calls.length, beforeClosed);
  assert.equal(theme.listenerCount("updated"), 0);
});
