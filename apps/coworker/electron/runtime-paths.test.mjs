import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { resolveUserDataDir } from "./runtime-paths.mjs";
import { beforePack } from "../scripts/electron-build.mjs";

test("packaging selects one engine and matching metadata across successive targets without changing staging", async (t) => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "coworker-sidecars-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const previousFilter = process.env.pnpm_config_filter;
  t.after(() => {
    if (previousFilter === undefined) delete process.env.pnpm_config_filter;
    else process.env.pnpm_config_filter = previousFilter;
  });
  const staging = path.join(projectDir, "resources/sidecars");
  await mkdir(staging, { recursive: true });
  const targets = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc.exe"];
  const files = ["opencode", "versions.json", ...targets.flatMap((target) => [`opencode-${target}`, `versions.json-${target}`])];
  for (const name of files) await writeFile(path.join(staging, name), name);
  const plugins = { from: "server/dist/opencode-plugins", to: "opencode-plugins" };
  const packager = { projectDir, config: { extraResources: [{ from: "resources/sidecars", to: "sidecars" }, plugins] } };
  for (const [index, electronPlatformName, arch] of [[0, "darwin", 3], [1, "win32", 1]]) {
    beforePack({ packager, electronPlatformName, arch });
    assert.equal(process.env.pnpm_config_filter, "@openwork/coworker");
    assert.deepEqual(packager.config.extraResources, [plugins,
      { from: staging, to: "sidecars", filter: [`opencode-${targets[index]}`] },
      { from: path.join(staging, `versions.json-${targets[index]}`), to: "sidecars/versions.json" },
    ]);
  }
  assert.throws(() => beforePack({ packager, electronPlatformName: "linux", arch: 3 }), /Missing Coworker target resource/);
  assert.throws(() => beforePack({ packager, electronPlatformName: "darwin", arch: 4 }), /Unsupported Coworker sidecar target/);
  assert.deepEqual((await readdir(staging)).sort(), files.sort());
  assert.equal(await readFile(path.join(staging, "opencode"), "utf8"), "opencode");
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
