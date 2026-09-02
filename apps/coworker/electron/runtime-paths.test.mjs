import assert from "node:assert/strict";
import { test } from "node:test";
import { opencodeTargetName, resolveBundledOpencodeBinary, resolveUserDataDir } from "./runtime-paths.mjs";

test("Open Coworker resolves each packaged OpenCode sidecar name", () => {
  assert.equal(opencodeTargetName("darwin", "arm64"), "opencode-aarch64-apple-darwin");
  assert.equal(opencodeTargetName("darwin", "x64"), "opencode-x86_64-apple-darwin");
  assert.equal(opencodeTargetName("linux", "x64"), "opencode-x86_64-unknown-linux-gnu");
  assert.equal(opencodeTargetName("win32", "arm64"), "opencode-aarch64-pc-windows-msvc.exe");
});

test("packaged resources win over the development sidecar directory", () => {
  const existing = new Set([
    "/resources/sidecars/opencode-aarch64-apple-darwin",
    "/app/resources/sidecars/opencode-aarch64-apple-darwin",
  ]);
  assert.equal(
    resolveBundledOpencodeBinary({
      appRoot: "/app",
      resourcesPath: "/resources",
      platform: "darwin",
      arch: "arm64",
      fileExists: (candidate) => existing.has(candidate),
    }),
    "/resources/sidecars/opencode-aarch64-apple-darwin",
  );
});

test("sidecar resolution returns null when the bundle is absent", () => {
  assert.equal(resolveBundledOpencodeBinary({
    appRoot: "/app",
    resourcesPath: "/resources",
    platform: "linux",
    arch: "x64",
    fileExists: () => false,
  }), null);
});

test("isolated profiles win over the default userData location, app override first", () => {
  const appDataDir = "/Users/me/Library/Application Support";
  assert.equal(
    resolveUserDataDir({ env: {}, appDataDir, appIdentifier: "com.differentai.opencoworker" }),
    "/Users/me/Library/Application Support/com.differentai.opencoworker",
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
  assert.equal(resolveUserDataDir({ env: { COWORKER_USER_DATA_DIR: "   " }, appDataDir, appIdentifier: "y" }), `${appDataDir}/y`);
});
