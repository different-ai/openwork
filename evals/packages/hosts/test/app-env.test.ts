import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedAppEnv, selectedEnvKeys } from "../src/app-env.ts";
import { electronSurfaceEnv } from "../src/local.ts";
import type { ElectronProfilePaths } from "../src/local.ts";

const marker = (keys: string[]) => ({ OPENWORK_WORLD_SELECTED_ENV_KEYS: JSON.stringify(keys) });

test("only keys selected with world --env reach the app", () => {
  assert.deepEqual(selectedAppEnv({}), {});
  assert.deepEqual(selectedAppEnv({ OPENWORK_ENGINE_V2_PREVIEW: "1" }), {}, "an ambient value is not a selection");
  assert.deepEqual(selectedAppEnv({ ...marker(["OPENWORK_ENGINE_V2_PREVIEW", "UNSET_KEY"]), OPENWORK_ENGINE_V2_PREVIEW: "1", OTHER: "x" }),
    { OPENWORK_ENGINE_V2_PREVIEW: "1" });
  assert.deepEqual(selectedEnvKeys(marker(["A", "B"])), ["A", "B"]);
  assert.throws(() => selectedEnvKeys({ OPENWORK_WORLD_SELECTED_ENV_KEYS: "{" }), /Invalid/);
  assert.throws(() => selectedEnvKeys({ OPENWORK_WORLD_SELECTED_ENV_KEYS: "[1]" }), /Invalid/);
});

test("a selected app setting reaches a local Electron launch but never overrides its isolation", () => {
  const previous = { ...process.env };
  Object.assign(process.env, marker(["OPENWORK_ENGINE_V2_PREVIEW", "HOME"]), { OPENWORK_ENGINE_V2_PREVIEW: "1", HOME: "/real/home" });
  try {
    const paths: ElectronProfilePaths = {
      root: "/p", appDataDir: "/p/appdata", homeDir: "/p/home", localAppDataDir: "/p/local", dataDir: "/p/data", bootstrapPath: "/p/bootstrap.json",
      envStorePath: "/p/env", opencodeConfigDir: "/p/opencode", userDataDir: "/p/user", cacheHome: "/p/cache", configHome: "/p/config",
      dataHome: "/p/share", stateHome: "/p/state",
    };
    const env = electronSurfaceEnv(paths, { appIdentifier: "id", appName: "name", cdpPort: 1, port: 2 });
    assert.equal(env.OPENWORK_ENGINE_V2_PREVIEW, "1");
    assert.equal(env.HOME, "/p/home");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
