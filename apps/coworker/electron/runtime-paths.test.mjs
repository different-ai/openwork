import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { resolveUserDataDir } from "./runtime-paths.mjs";

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
