import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnvService, InvalidEnvKeyError, isReservedEnvKey } from "../src/env-file.js";
import { inheritedEngineEnv } from "../src/managed-opencode-v2.js";

async function withStore(platform: NodeJS.Platform, run: (env: EnvService) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "openwork-env-names-"));
  try {
    await run(new EnvService({ path: join(dir, "env.json"), platform }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("on Windows saving Path replaces a saved PATH, and deleting removes any spelling", async () => {
  await withStore("win32", async (env) => {
    await env.upsertMany([{ key: "PATH", value: "C:\\Old" }, { key: "API_URL", value: "a" }]);
    await env.upsertMany([{ key: "Path", value: "C:\\New" }]);
    assert.deepEqual((await env.list()).map(({ key, value }) => ({ key, value })), [
      { key: "API_URL", value: "a" },
      { key: "Path", value: "C:\\New" },
    ]);
    assert.equal(await env.delete("path"), true);
    assert.deepEqual((await env.list()).map(({ key }) => key), ["API_URL"]);
  });
});

test("on macOS PATH and Path stay separate saved variables", async () => {
  await withStore("darwin", async (env) => {
    await env.upsertMany([{ key: "PATH", value: "/old" }, { key: "Path", value: "/new" }]);
    assert.deepEqual((await env.list()).map(({ key }) => key).sort(), ["PATH", "Path"]);
    assert.equal(await env.delete("path"), false);
  });
});

test("on Windows reserved names cannot be saved in another case", async () => {
  await withStore("win32", async (env) => {
    await assert.rejects(env.upsertMany([{ key: "opencode_config", value: "x" }]), InvalidEnvKeyError);
  });
  assert.equal(isReservedEnvKey("OpenWork_Server_Token", "win32"), true);
  assert.equal(isReservedEnvKey("openwork_api_key", "win32"), false);
  assert.equal(isReservedEnvKey("opencode_config", "darwin"), false);
});

test("on Windows the engine inherits each allowed variable once, under any spelling", () => {
  const parent = { PATH: "C:\\Windows", SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "cmd.exe", SECRET_TOKEN: "x" };
  assert.deepEqual(inheritedEngineEnv({ Path: "C:\\Sidecars;C:\\Windows" }, parent, "win32"), {
    PATH: "C:\\Sidecars;C:\\Windows",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    COMSPEC: "cmd.exe",
  });
});

test("on macOS the engine inherits exact names only", () => {
  assert.deepEqual(inheritedEngineEnv(undefined, { PATH: "/usr/bin", Path: "/saved", windir: "x" }, "darwin"), {
    PATH: "/usr/bin",
  });
});
