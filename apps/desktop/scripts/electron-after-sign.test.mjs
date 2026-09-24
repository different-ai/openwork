import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifySignedApp } = require("./electron-after-sign.cjs");

function recorder() {
  const calls = [];
  return { calls, runCommand: (command, args) => calls.push([command, ...args]) };
}

for (const appPath of [
  "/tmp/dist/mac-arm64/OpenWork.app",
  "/tmp/dist/mac-arm64/OpenWork Cloud.app",
  "/tmp/dist/mac-x64/OpenWork Enterprise.app",
]) {
  test(`verifies the bundle itself for ${appPath}`, () => {
    const { calls, runCommand } = recorder();
    verifySignedApp(appPath, { runCommand });
    assert.deepEqual(calls, [
      ["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath],
      ["spctl", "--assess", "--type", "execute", "--verbose=2", appPath],
      ["xcrun", "stapler", "validate", appPath],
    ]);
    assert.ok(calls.every((call) => !call.some((arg) => arg.includes("Contents/MacOS"))));
  });
}

test("a failing check fails the build", () => {
  const runCommand = (command) => {
    if (command === "spctl") throw new Error("spctl --assess failed with status 3");
  };
  assert.throws(() => verifySignedApp("/tmp/OpenWork Cloud.app", { runCommand }), /spctl/);
});

test("the build step never launches the packaged app", () => {
  const source = readFileSync(new URL("./electron-after-sign.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"Contents",\s*"MacOS"/);
});
