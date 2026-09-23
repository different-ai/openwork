import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifyAppCanLaunch } = require("./electron-after-sign.cjs");

function timeoutError() {
  const error = new Error("spawnSync ETIMEDOUT");
  error.code = "ETIMEDOUT";
  return error;
}

test("an app still running at the deadline counts as launched, even if it exits 0 on SIGTERM", () => {
  const spawn = () => ({ error: timeoutError(), status: 0, signal: null });
  assert.doesNotThrow(() => verifyAppCanLaunch("/tmp/OpenWork.app", { spawn }));
});

test("an app killed at the deadline counts as launched", () => {
  const spawn = () => ({ error: timeoutError(), status: null, signal: "SIGTERM" });
  assert.doesNotThrow(() => verifyAppCanLaunch("/tmp/OpenWork.app", { spawn }));
});

test("a crash before the deadline fails the build", () => {
  const spawn = () => ({ status: null, signal: "SIGKILL" });
  assert.throws(() => verifyAppCanLaunch("/tmp/OpenWork.app", { spawn }), /failed to launch/);
});

test("a non-zero exit before the deadline fails the build", () => {
  const spawn = () => ({ status: 1, signal: null });
  assert.throws(() => verifyAppCanLaunch("/tmp/OpenWork.app", { spawn }), /status 1/);
});

test("a missing executable fails the build", () => {
  const error = new Error("spawnSync ENOENT");
  error.code = "ENOENT";
  const spawn = () => ({ error, status: null, signal: null });
  assert.throws(() => verifyAppCanLaunch("/tmp/OpenWork.app", { spawn }), /ENOENT/);
});
