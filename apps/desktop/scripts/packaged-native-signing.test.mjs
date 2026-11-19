import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { signMicrosandboxRuntime } = createRequire(import.meta.url)("./electron-after-pack.cjs");

test("microsandbox signs from electron-builder's CSC_LINK keychain without CSC_NAME", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "packaged-msb-keychain-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "OpenWork.app/Contents/Resources/app.asar.unpacked/node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fixture");
  const environment = Object.fromEntries(["CSC_NAME", "APPLE_CODESIGN_IDENTITY"].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(environment)) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const calls = [];
  const identity = "0123456789ABCDEF0123456789ABCDEF01234567";
  await signMicrosandboxRuntime({ electronPlatformName: "darwin", arch: "arm64", appOutDir: root, packager: { appInfo: { productFilename: "OpenWork" }, codeSigningInfo: { value: Promise.resolve({ keychainFile: "/build/distribution.keychain" }) } } }, {
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: `1) ${identity} "Developer ID Application: fixture"`, stderr: "" };
    },
  });
  assert.equal(calls[0].command, "security");
  assert.equal(calls[0].args.at(-1), "/build/distribution.keychain");
  assert.equal(calls[1].command, "codesign");
  assert.equal(calls[1].args[calls[1].args.indexOf("--sign") + 1], identity);
  assert.equal(calls[1].args[calls[1].args.indexOf("--keychain") + 1], "/build/distribution.keychain");
  assert.ok(calls[1].args.includes("--timestamp"));
});

function signingFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "packaged-msb-entitlements-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "OpenWork.app/Contents/Resources/app.asar.unpacked/node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fixture");
  const names = ["CSC_NAME", "APPLE_CODESIGN_IDENTITY", "MACOS_NOTARIZE"];
  const environment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const calls = [];
  const context = { electronPlatformName: "darwin", arch: "arm64", appOutDir: root, packager: { appInfo: { productFilename: "OpenWork" }, codeSigningInfo: { value: Promise.resolve(null) } } };
  const spawn = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "", stderr: "" }; };
  return { calls, context, spawn };
}

test("an ad-hoc signed microsandbox may load its own firmware library", async (t) => {
  const { calls, context, spawn } = signingFixture(t);
  await signMicrosandboxRuntime(context, { spawn });
  const sign = calls.find((call) => call.command === "codesign");
  assert.equal(sign.args[sign.args.indexOf("--sign") + 1], "-");
  const entitlements = readFileSync(sign.args[sign.args.indexOf("--entitlements") + 1], "utf8");
  assert.match(entitlements, /com\.apple\.security\.hypervisor/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
});

test("a Developer ID signed microsandbox keeps library validation", async (t) => {
  const { calls, context, spawn } = signingFixture(t);
  process.env.CSC_NAME = "Developer ID Application: fixture";
  await signMicrosandboxRuntime(context, { spawn });
  const sign = calls.find((call) => call.command === "codesign");
  const entitlements = readFileSync(sign.args[sign.args.indexOf("--entitlements") + 1], "utf8");
  assert.match(entitlements, /com\.apple\.security\.hypervisor/);
  assert.doesNotMatch(entitlements, /disable-library-validation/);
});
