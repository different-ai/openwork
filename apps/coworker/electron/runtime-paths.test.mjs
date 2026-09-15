import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import { resolveBundledOpencodeV2Binary, resolveUserDataDir } from "./runtime-paths.mjs";
import { beforePack, stageNativeServer } from "../scripts/electron-build.mjs";
import nativeRuntime from "../native-runtime.json" with { type: "json" };
import { NATIVE_PLUGIN_DEPENDENCIES, configureNativePluginBundles, verifyNativePluginBundles } from "./native-plugin.mjs";

test("packaging selects only the pinned native target without changing staging and rejects invalid inputs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-sidecars-"));
  const projectDir = path.join(root, "apps/coworker");
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousFilter = process.env.pnpm_config_filter;
  t.after(() => {
    if (previousFilter === undefined) delete process.env.pnpm_config_filter;
    else process.env.pnpm_config_filter = previousFilter;
  });
  const staging = path.join(projectDir, "resources/sidecars");
  await mkdir(staging, { recursive: true });
  const constants = JSON.parse(await readFile(new URL("../../../constants.json", import.meta.url), "utf8"));
  assert.equal(constants.opencodeV2Version, "0.0.0-beta-19086", "Desktop retains its own optional-v2 pin");
  assert.equal(nativeRuntime.opencodeV2Version, "0.0.0-beta-19271");
  await writeFile(path.join(root, "constants.json"), JSON.stringify(constants));
  await writeFile(path.join(projectDir, "native-runtime.json"), JSON.stringify(nativeRuntime));
  const files = ["opencode", "opencode-aarch64-apple-darwin", "versions.json-aarch64-apple-darwin", "opencode2", "opencode2.exe", "versions.json"];
  for (const name of files) await writeFile(path.join(staging, name), name);
  await mkdir(path.join(staging, ".verified-v2"));
  await writeFile(path.join(staging, ".verified-v2/cache"), "retain staging cache");
  const config = YAML.parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const plugins = config.extraResources.find((resource) => resource.to === "native-plugins");
  assert.ok(plugins);
  const helpers = structuredClone(config.mac.extraResources);
  config.extraResources.push({ from: "server/dist/opencode-plugins", to: "opencode-plugins" });
  const packager = { projectDir, config };
  const metadataFile = path.join(staging, "versions.json");
  const metadata = (platform, arch) => ({ opencode2: { version: nativeRuntime.opencodeV2Version, platform, arch } });
  const snapshot = async () => Promise.all(files.map((name) => readFile(path.join(staging, name), "utf8")));
  for (const [electronPlatformName, arch, targetArch] of [["darwin", 3, "arm64"], ["win32", 1, "x64"], ["linux", "x64", "x64"]]) {
    await writeFile(metadataFile, JSON.stringify(metadata(electronPlatformName, targetArch)));
    const before = await snapshot();
    await beforePack({ packager, electronPlatformName, arch });
    assert.equal(process.env.pnpm_config_filter, "@openwork/coworker");
    assert.deepEqual(packager.config.extraResources, [plugins,
      { from: staging, to: "sidecars", filter: [electronPlatformName === "win32" ? "opencode2.exe" : "opencode2", "versions.json"] },
    ]);
    assert.deepEqual(await snapshot(), before);
  }
  assert.deepEqual(config.mac.extraResources, helpers);
  const context = { packager, electronPlatformName: "darwin", arch: 3 };
  const selected = structuredClone(config.extraResources);
  for (const invalid of [
    { opencode2: { ...metadata("darwin", "arm64").opencode2, version: constants.opencodeV2Version } },
    { opencode2: { ...metadata("darwin", "arm64").opencode2, version: "0.0.0-beta-stale" } },
    metadata("win32", "arm64"), metadata("darwin", "x64"), {},
    { ...metadata("darwin", "arm64"), opencode: { version: "v1.18.18" } },
  ]) {
    await writeFile(metadataFile, JSON.stringify(invalid));
    await assert.rejects(beforePack(context), /exact version pin, target platform and architecture/);
    assert.deepEqual(config.extraResources, selected, "invalid staging must not change resource selection");
  }
  await writeFile(metadataFile, JSON.stringify(metadata("darwin", "arm64")));
  await writeFile(path.join(projectDir, "native-runtime.json"), JSON.stringify(constants));
  await assert.rejects(beforePack(context), /exact version pin/);
  assert.deepEqual(config.extraResources, selected);
  await writeFile(path.join(projectDir, "native-runtime.json"), JSON.stringify(nativeRuntime));
  await writeFile(metadataFile, "{");
  await assert.rejects(beforePack(context), SyntaxError);
  await rm(metadataFile);
  await assert.rejects(beforePack(context), /Missing nonempty.*versions.json/);
  await writeFile(metadataFile, JSON.stringify(metadata("darwin", "arm64")));
  await writeFile(path.join(staging, "opencode2"), "");
  await assert.rejects(beforePack(context), /Missing nonempty.*opencode2/);
  await rm(path.join(staging, "opencode2"));
  await assert.rejects(beforePack(context), /Missing nonempty.*opencode2/);
  await symlink(path.join(staging, "opencode2.exe"), path.join(staging, "opencode2"));
  await assert.rejects(beforePack(context), /Missing nonempty.*opencode2/);
  await assert.rejects(beforePack({ ...context, arch: 4 }), /Unsupported Coworker sidecar target/);
  await assert.rejects(beforePack({ ...context, electronPlatformName: "freebsd" }), /Unsupported Coworker sidecar target/);
  assert.deepEqual((await readdir(staging)).sort(), [...files, ".verified-v2"].sort());
  assert.equal(await readFile(path.join(staging, ".verified-v2/cache"), "utf8"), "retain staging cache");
});

test("synthetic release validation keeps the Coworker pin separate from packaged Desktop defaults", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-release-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const app = path.join(root, "linux-unpacked");
  const resources = path.join(app, "resources");
  const write = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  const constants = JSON.parse(await readFile(new URL("../../../constants.json", import.meta.url), "utf8"));
  await write(path.join(source, "package.json"), '{"private":true}');
  for (const file of ["dist/index.html", "electron-dist/main.mjs", "electron-dist/preload.mjs", "electron-dist/browser-content-preload.cjs",
    "electron-dist/maintenance-helper.mjs", "electron-dist/THIRD-PARTY-NOTICES"]) await write(path.join(source, file), "fixture");
  const serverDist = path.join(root, "shared-server-dist");
  const sharedModule = 'import constants from "../../../constants.json" with { type: "json" };\nexport { constants };\n';
  await write(path.join(serverDist, "embedded.js"), sharedModule);
  await write(path.join(serverDist, "embedded-native.js"), 'export { startEmbeddedServer } from "./embedded.js";\n');
  stageNativeServer({ sourceDirectory: serverDist, outputDirectory: path.join(source, "server") });
  assert.equal(await readFile(path.join(serverDist, "embedded.js"), "utf8"), sharedModule, "staging must not mutate Desktop's server build");
  assert.match(await readFile(path.join(source, "server/dist/embedded.js"), "utf8"), /from "\.\/constants\.json"/);
  const nativePackage = JSON.parse(await readFile(path.join(source, "server/package.json"), "utf8"));
  assert.equal(nativePackage.exports["."], "./dist/embedded-native.js");
  assert.equal(nativePackage.bin, undefined);
  for (const name of ["@opencode-ai/sdk", "opencode-chrome-devtools", "drizzle-orm", "better-sqlite3"]) assert.equal(nativePackage.dependencies[name], undefined);
  assert.equal(nativePackage.dependencies["@openwork/paths"], "workspace:*");
  assert.throws(() => stageNativeServer({ sourceDirectory: serverDist, outputDirectory: root }), /separate from the source build/);
  assert.equal(await readFile(path.join(serverDist, "embedded.js"), "utf8"), sharedModule);
  const runtimeFile = path.join(source, "electron-dist/native-runtime.json");
  await write(runtimeFile, JSON.stringify(nativeRuntime));
  await write(path.join(resources, "sidecars/opencode2"), "synthetic executable bytes");
  const metadataFile = path.join(resources, "sidecars/versions.json");
  const metadata = { opencode2: { version: nativeRuntime.opencodeV2Version, platform: "linux", arch: "x64" } };
  await write(metadataFile, JSON.stringify(metadata));
  const bytes = Buffer.from("export default {};\n");
  const entries = {};
  for (const name of ["coworker-collaboration", "coworker-browser", "coworker-computer", "coworker-group-documents", "progress-summary", "auto-memory", "coworker-turn-roles", "coworker-events", "coworker-abilities"]) {
    const file = `${name}.mjs`;
    await write(path.join(resources, "native-plugins", file), bytes);
    entries[`${name}.js`] = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const manifestFile = path.join(resources, "native-plugins/manifest.json");
  const manifest = { format: "coworker-native-plugins/v1", opencodeVersion: nativeRuntime.opencodeV2Version,
    dependencies: NATIVE_PLUGIN_DEPENDENCIES, entries };
  await write(manifestFile, JSON.stringify(manifest));
  configureNativePluginBundles(path.join(resources, "native-plugins"));
  await verifyNativePluginBundles();
  for (const alter of [
    (value) => { delete value.entries["auto-memory.js"]; },
    (value) => { delete value.entries["coworker-events.js"]; },
    (value) => { delete value.entries["coworker-abilities.js"]; },
    (value) => { value.dependencies.unpinned = "*"; },
    (value) => { value.entries["coworker-browser.js"].bytes++; },
  ]) {
    const invalid = structuredClone(manifest);
    alter(invalid);
    await write(manifestFile, JSON.stringify(invalid));
    await assert.rejects(verifyNativePluginBundles(), /manifest|declaration|integrity/);
  }
  await write(manifestFile, JSON.stringify(manifest));
  const browserBundle = path.join(resources, "native-plugins/coworker-browser.mjs");
  await write(browserBundle, "tampered source");
  await assert.rejects(verifyNativePluginBundles(), /integrity/);
  await rm(browserBundle);
  await assert.rejects(verifyNativePluginBundles(), /ENOENT/);
  await write(browserBundle, bytes);
  await verifyNativePluginBundles();
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const asar = libraryRequire("@electron/asar");
  const validate = async () => {
    await finished(await asar.createPackage(source, path.join(resources, "app.asar")));
    return spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/release-size.mjs", import.meta.url)),
      app, "--check", "--platform", "linux", "--arch", "x64"], { encoding: "utf8", timeout: 10_000 });
  };
  const accepted = await validate();
  assert.equal(accepted.status, 0, accepted.stderr);
  await write(runtimeFile, JSON.stringify({ opencodeV2Version: constants.opencodeV2Version }));
  const staleRuntime = await validate();
  assert.equal(staleRuntime.status, 1);
  assert.match(staleRuntime.stderr, /packaged Coworker runtime must match pin/);
  await write(runtimeFile, JSON.stringify(nativeRuntime));
  await write(metadataFile, JSON.stringify({ opencode2: { ...metadata.opencode2, version: constants.opencodeV2Version } }));
  const staleSidecar = await validate();
  assert.equal(staleSidecar.status, 1);
  assert.match(staleSidecar.stderr, /packaged Coworker runtime must match pin/);
});

test("native runtime resolution prefers packaged resources and never falls back to v1", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const name = platform === "win32" ? "opencode2.exe" : "opencode2";
    const packaged = path.join("/package/resources/sidecars", name);
    const development = path.join("/source/resources/sidecars", name);
    const files = new Set([packaged, development, "/package/resources/sidecars/opencode", "/package/resources/sidecars/opencode-aarch64-apple-darwin"]);
    const options = { platform, appRoot: "/source", resourcesPath: "/package/resources", fileExists: (file) => files.has(file) };
    assert.equal(resolveBundledOpencodeV2Binary(options), packaged);
    assert.equal(resolveBundledOpencodeV2Binary({ ...options, isPackaged: true }), packaged);
    files.delete(packaged);
    assert.throws(() => resolveBundledOpencodeV2Binary({ ...options, isPackaged: true }), /packaged native engine is missing/);
    assert.equal(resolveBundledOpencodeV2Binary(options), development);
    files.delete(development);
    assert.equal(resolveBundledOpencodeV2Binary(options), null);
  }
});

test("uninstall preserves the person's app data", async () => {
  const config = YAML.parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("isolated profiles win over the default userData location, app override first", () => {
  const appDataDir = "/Users/me/Library/Application Support";
  assert.equal(
    resolveUserDataDir({ env: {}, appDataDir, appIdentifier: "com.differentai.opencoworker" }),
    path.join(appDataDir, "com.differentai.opencoworker"),
  );
  assert.equal(
    resolveUserDataDir({ env: { OPENWORK_ELECTRON_USERDATA: "/tmp/profile/electron-userdata" }, appDataDir, appIdentifier: "x" }),
    "/tmp/profile/electron-userdata",
  );
  assert.equal(
    resolveUserDataDir({
      env: { COWORKER_USER_DATA_DIR: "/tmp/coworker-profile", OPENWORK_ELECTRON_USERDATA: "/tmp/profile/electron-userdata" },
      appDataDir,
      appIdentifier: "x",
    }),
    "/tmp/coworker-profile",
  );
  assert.equal(resolveUserDataDir({ env: { COWORKER_USER_DATA_DIR: "   " }, appDataDir, appIdentifier: "y" }), path.join(appDataDir, "y"));
});
