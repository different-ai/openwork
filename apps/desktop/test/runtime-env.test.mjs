import assert from "node:assert/strict";
import { test } from "node:test";
import { isReservedUserEnvKey, mergeSystemCaChildEnv, reconcileInjectedUserEnv } from "../electron/runtime.mjs";

const gitPath = "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32";

test("on Windows a saved PATH never replaces the inherited Path", () => {
  const processEnv = { Path: gitPath, TEMP: "C:\\Temp" };
  const keys = reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv: { ...processEnv },
    userEnv: { PATH: "C:\\Tools", temp: "D:\\Temp", EXTRA: "1" },
    platform: "win32",
  });
  assert.deepEqual(processEnv, { Path: gitPath, TEMP: "C:\\Temp", EXTRA: "1" });
  assert.deepEqual([...keys], ["EXTRA"]);
});

test("on Windows a saved variable is updated and removed under any spelling", () => {
  const processEnv = { Path: gitPath };
  const inheritedEnv = { ...processEnv };
  let keys = reconcileInjectedUserEnv({ processEnv, inheritedEnv, userEnv: { Api_Url: "a" }, platform: "win32" });
  keys = reconcileInjectedUserEnv({
    processEnv, inheritedEnv, userEnv: { API_URL: "b" }, previouslyInjectedKeys: keys, platform: "win32",
  });
  assert.deepEqual(processEnv, { Path: gitPath, Api_Url: "b" });
  keys = reconcileInjectedUserEnv({ processEnv, inheritedEnv, userEnv: {}, previouslyInjectedKeys: keys, platform: "win32" });
  assert.deepEqual(processEnv, { Path: gitPath });
  assert.equal(keys.size, 0);
});

test("on macOS differently cased names stay separate variables", () => {
  const processEnv = { PATH: "/usr/bin" };
  const keys = reconcileInjectedUserEnv({
    processEnv, inheritedEnv: { ...processEnv }, userEnv: { Path: "/saved" }, platform: "darwin",
  });
  assert.deepEqual(processEnv, { PATH: "/usr/bin", Path: "/saved" });
  assert.deepEqual([...keys], ["Path"]);
});

test("on Windows a child environment has one entry per name", () => {
  const base = { Path: gitPath, node_extra_ca_certs: "C:\\corp.pem" };
  const env = mergeSystemCaChildEnv(base, { NODE_EXTRA_CA_CERTS: "C:\\system.pem" }, { PATH: "C:\\Sidecars" }, "win32");
  assert.deepEqual(env, { Path: "C:\\Sidecars", node_extra_ca_certs: "C:\\corp.pem" });
  assert.deepEqual(
    mergeSystemCaChildEnv({ Path: gitPath }, { NODE_EXTRA_CA_CERTS: "C:\\system.pem" }, {}, "win32"),
    { Path: gitPath, NODE_EXTRA_CA_CERTS: "C:\\system.pem" },
  );
});

test("on Windows reserved OpenWork and OpenCode names cannot be saved in another case", () => {
  assert.equal(isReservedUserEnvKey("opencode_config", "win32"), true);
  assert.equal(isReservedUserEnvKey("OpenWork_Server_Token", "win32"), true);
  assert.equal(isReservedUserEnvKey("OPENCODE_CONFIG", "darwin"), true);
  assert.equal(isReservedUserEnvKey("opencode_config", "darwin"), false);
  assert.equal(isReservedUserEnvKey("ANTHROPIC_API_KEY", "win32"), false);
});
