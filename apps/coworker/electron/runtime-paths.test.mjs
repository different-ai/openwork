import assert from "node:assert/strict";
import { test } from "node:test";
import { opencodeTargetName, resolveBundledOpencodeBinary } from "./runtime-paths.mjs";

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
