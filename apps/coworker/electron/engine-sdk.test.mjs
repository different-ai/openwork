import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PLUGIN_PACKAGE,
  engineSdkDirectories,
  findInstaller,
  prepareEngineSdk,
  readSidecarVersion,
  sdkPresent,
} from "./engine-sdk.mjs";

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "coworker-engine-sdk-"));
  return { home, [Symbol.asyncDispose]: () => rm(home, { recursive: true, force: true }) };
}

async function seedPlugin(directory, version) {
  const pkg = path.join(directory, "node_modules", PLUGIN_PACKAGE);
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: PLUGIN_PACKAGE, version }), "utf8");
}

test("the SDK directories follow the engine: XDG config dir, plus OPENCODE_CONFIG_DIR once", () => {
  assert.deepEqual(engineSdkDirectories({}, "/Users/me"), ["/Users/me/.config/opencode"]);
  assert.deepEqual(engineSdkDirectories({ XDG_CONFIG_HOME: "/x/cfg" }, "/Users/me"), ["/x/cfg/opencode"]);
  assert.deepEqual(engineSdkDirectories({ XDG_CONFIG_HOME: "/x/cfg", OPENCODE_CONFIG_DIR: "/p/opencode-config" }, "/Users/me"), ["/x/cfg/opencode", "/p/opencode-config"]);
  assert.deepEqual(engineSdkDirectories({ XDG_CONFIG_HOME: "/x/cfg", OPENCODE_CONFIG_DIR: "/x/cfg/opencode" }, "/Users/me"), ["/x/cfg/opencode"], "the same directory is not listed twice");
});

test("the pinned version comes from the sidecar's versions.json and is otherwise empty", async () => {
  await using fixture = await tempHome();
  const file = path.join(fixture.home, "versions.json");
  await writeFile(file, JSON.stringify({ opencode: { version: "1.18.18", sha256: "x" } }), "utf8");
  assert.equal(await readSidecarVersion(file), "1.18.18");
  await writeFile(file, JSON.stringify({ opencode: { version: "latest" } }), "utf8");
  assert.equal(await readSidecarVersion(file), "");
  assert.equal(await readSidecarVersion(path.join(fixture.home, "missing.json")), "");
});

test("an installer is found on PATH or in the usual places, bun before npm", () => {
  const files = new Set(["/opt/homebrew/bin/npm", "/Users/me/.bun/bin/bun"]);
  const exists = (candidate) => files.has(candidate);
  assert.deepEqual(findInstaller({ env: { PATH: "/usr/bin", HOME: "/Users/me" }, platform: "darwin", fileExists: exists }), { name: "bun", path: "/Users/me/.bun/bin/bun" });
  files.delete("/Users/me/.bun/bin/bun");
  assert.deepEqual(findInstaller({ env: { PATH: "/usr/bin", HOME: "/Users/me" }, platform: "darwin", fileExists: exists }), { name: "npm", path: "/opt/homebrew/bin/npm" });
  assert.equal(findInstaller({ env: { PATH: "/usr/bin", HOME: "/Users/me" }, platform: "darwin", fileExists: () => false }), null);
  assert.deepEqual(findInstaller({ env: { PATH: "C:\\tools", HOME: "" }, platform: "win32", fileExists: (c) => c === "C:\\tools\\npm.cmd" }), { name: "npm", path: "C:\\tools\\npm.cmd" });
});

test("prepareEngineSdk seeds each missing directory with the pinned plugin and leaves present ones alone", async () => {
  await using fixture = await tempHome();
  const configHome = path.join(fixture.home, "xdg");
  const extra = path.join(fixture.home, "opencode-config");
  await seedPlugin(path.join(configHome, "opencode"), "1.18.18");
  const installs = [];
  const install = async (installer, directory) => {
    installs.push([installer.name, directory]);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    await seedPlugin(directory, manifest.dependencies[PLUGIN_PACKAGE]);
  };
  const logged = [];
  const result = await prepareEngineSdk({
    version: "1.18.18",
    env: { XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG_DIR: extra },
    homeDir: fixture.home,
    installer: { name: "bun", path: "/fake/bun" },
    install,
    log: (line) => logged.push(line),
  });
  assert.deepEqual(result.results.map((entry) => [path.basename(entry.directory), entry.outcome]), [["opencode", "present"], ["opencode-config", "seeded"]]);
  assert.deepEqual(installs, [["bun", extra]], "only the missing directory was installed into");
  assert.equal(await sdkPresent(extra, "1.18.18"), true);
  const manifest = JSON.parse(await readFile(path.join(extra, "package.json"), "utf8"));
  assert.deepEqual(manifest, { dependencies: { [PLUGIN_PACKAGE]: "1.18.18" } });
  assert.match(logged[0], /engine sdk 1\.18\.18: present, seeded via bun/);
});

test("an older plugin is re-seeded, an existing manifest keeps its other fields, and failures are reported not thrown", async () => {
  await using fixture = await tempHome();
  const configHome = path.join(fixture.home, "xdg");
  const dir = path.join(configHome, "opencode");
  await seedPlugin(dir, "1.17.0");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "keep-me", dependencies: { other: "1.0.0" } }), "utf8");
  const failing = await prepareEngineSdk({
    version: "1.18.18",
    env: { XDG_CONFIG_HOME: configHome },
    homeDir: fixture.home,
    installer: { name: "npm", path: "/fake/npm" },
    install: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(failing.results, [{ directory: dir, outcome: "skipped", reason: "network down" }]);
  const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  assert.deepEqual(manifest, { name: "keep-me", dependencies: { other: "1.0.0", [PLUGIN_PACKAGE]: "1.18.18" } });
  const none = await prepareEngineSdk({ version: "1.18.18", env: { XDG_CONFIG_HOME: configHome }, homeDir: fixture.home, installer: null });
  assert.deepEqual(none.results, [{ directory: dir, outcome: "skipped", reason: "no installer" }]);
  const unknown = await prepareEngineSdk({ version: "", env: { XDG_CONFIG_HOME: configHome }, homeDir: fixture.home });
  assert.deepEqual(unknown.results, [], "without a known engine version nothing is seeded");
});
