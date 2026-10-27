import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { deleteEnv, envKey, mergeEnv, openworkEnvStorePath, setEnv } from "./index.mjs";

const windows = { platform: "win32" };
const mac = { platform: "darwin" };

test("Windows finds a variable under any spelling", () => {
  assert.equal(envKey({ Path: "C:\\Git" }, "PATH", windows), "Path");
  assert.equal(envKey({ path: "C:\\Git" }, "Path", windows), "path");
  assert.equal(envKey({ PATH: "a", Path: "b" }, "path", windows), "Path");
  assert.equal(envKey({ HOME: "/home" }, "PATH", windows), undefined);
  assert.equal(envKey(undefined, "PATH", windows), undefined);
});

test("other platforms keep exact names", () => {
  assert.equal(envKey({ Path: "/bin" }, "PATH", mac), undefined);
  assert.equal(envKey({ PATH: "/bin" }, "PATH", mac), "PATH");
});

test("Windows merges keep one entry per name and let the later layer win", () => {
  const inherited = { Path: "C:\\Git", TEMP: "C:\\Temp" };
  const merged = mergeEnv([{ PATH: "C:\\Saved", EXTRA: "1" }, inherited, { path: "C:\\Override" }], windows);
  assert.deepEqual(merged, { PATH: "C:\\Override", EXTRA: "1", TEMP: "C:\\Temp" });
  assert.deepEqual(inherited, { Path: "C:\\Git", TEMP: "C:\\Temp" });
  assert.deepEqual(mergeEnv([null, undefined, { A: "1" }], windows), { A: "1" });
});

test("other platforms merge like object spread", () => {
  assert.deepEqual(mergeEnv([{ Path: "/saved" }, { PATH: "/bin" }, undefined], mac), { Path: "/saved", PATH: "/bin" });
});

test("Windows writes and deletes replace every spelling", () => {
  const env = { Path: "C:\\Git", HOME: "C:\\Users\\me" };
  assert.equal(setEnv(env, "PATH", "C:\\New", windows), env);
  assert.deepEqual(env, { HOME: "C:\\Users\\me", Path: "C:\\New" });
  deleteEnv(env, "path", windows);
  assert.deepEqual(env, { HOME: "C:\\Users\\me" });
  setEnv(env, "Home", "D:\\me", windows);
  assert.deepEqual(env, { HOME: "D:\\me" });
  // A copied object can hold twins; the later one is the live value and stays.
  assert.deepEqual(setEnv({ PATH: "a", path: "b" }, "Path", "c", windows), { path: "c" });
});

test("other platforms write and delete exact names", () => {
  const env = { Path: "/saved", PATH: "/bin" };
  setEnv(env, "PATH", "/usr/bin", mac);
  deleteEnv(env, "path", mac);
  assert.deepEqual(env, { Path: "/saved", PATH: "/usr/bin" });
});

test("path resolvers read copied Windows environments under any spelling", () => {
  const store = "C:\\Profiles\\openwork\\env.json";
  assert.equal(openworkEnvStorePath({ env: { openwork_env_store: store }, ...windows }), path.win32.resolve(store));
  assert.equal(
    openworkEnvStorePath({ env: { openwork_env_store: "/tmp/env.json" }, homeDir: "/home/me", ...mac }),
    "/home/me/.config/openwork/env.json",
  );
});
