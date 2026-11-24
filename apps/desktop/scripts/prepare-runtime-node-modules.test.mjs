import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { requiredRoots, stageRuntimeNodeModules, targetArch } from "./prepare-runtime-node-modules.mjs";

// This is deliberately source-only: quick-static runs without pnpm install,
// compiled workspaces, Electron, a VM, signing credentials or network access.
function fixture(t, { nativeVersion = "0.7.15", omitNative = false, platform = "darwin", arch = "arm64" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "staged-sandbox-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const native = "@superradcompany/microsandbox-darwin-arm64";
  write("package.json", { private: true });
  const pkg = (name, version, dependencies = {}, optionalDependencies = {}) => {
    write(`node_modules/${name}/package.json`, { name, version, type: "module", main: "./dist/index.js", dependencies, optionalDependencies });
    write(`node_modules/${name}/dist/index.js`, "export const fixture = true;");
  };
  pkg("@openwork/sandbox-microsandbox", "0.0.0", { "@openwork/sandbox": "workspace:*", microsandbox: "0.7.15" });
  pkg("@openwork/sandbox", "0.0.0");
  pkg("microsandbox", "0.7.15", {}, { [native]: "0.7.15", "@superradcompany/microsandbox-linux-x64-gnu": "0.7.15", "@superradcompany/microsandbox-win32-x64-msvc": "0.7.15", "@superradcompany/microsandbox-win32-arm64-msvc": "0.7.15" });
  write("node_modules/microsandbox/dist/internal/resolve-binary.js", 'function msbPath(root) { return root ? join(root, "bin", msbFileName()) : null; }');
  if (!omitNative) {
    pkg(native, nativeVersion);
    write(`node_modules/${native}/microsandbox.darwin-arm64.node`, "fixture addon");
    write(`node_modules/${native}/bin/msb`, "fixture executable");
    write(`node_modules/${native}/lib/libkrunfw.5.dylib`, "fixture firmware");
  }
  // pnpm installs both CPU variants for the current OS (pnpm-workspace.yaml).
  for (const triple of ["win32-x64-msvc", "win32-arm64-msvc"]) pkg(`@superradcompany/microsandbox-${triple}`, "0.7.15");
  const output = join(root, "app/node_modules");
  const stage = () => stageRuntimeNodeModules(output, { roots: [{ name: "@openwork/sandbox-microsandbox", fromPackageJson: join(root, "package.json") }], platform, arch });
  return { stage, output, native };
}

test("desktop's explicit staging roots include the lazily imported local sandbox adapter", () => {
  assert.ok(requiredRoots.some((entry) => entry.name === "@openwork/sandbox-microsandbox"));
});

test("workspace staging closes over the SDK's pinned native optional dependency and complete runtime pair", (t) => {
  const { stage, output, native } = fixture(t);
  const staged = stage();
  for (const name of ["@openwork/sandbox-microsandbox", "@openwork/sandbox", "microsandbox", native]) {
    assert.ok(staged.includes(name), `Missing staged dependency ${name}`);
    assert.ok(existsSync(join(output, name, "package.json")));
  }
  for (const file of ["microsandbox.darwin-arm64.node", "bin/msb", "lib/libkrunfw.5.dylib"]) assert.ok(existsSync(join(output, native, file)));
  assert.match(readFileSync(join(output, "microsandbox/dist/internal/resolve-binary.js"), "utf8"), /app\.asar\.unpacked/);
  assert.ok(!existsSync(join(output, "@superradcompany/microsandbox-linux-x64-gnu")));
});

test("staging fails when pnpm omitted the required native optional dependency", (t) => {
  const { stage } = fixture(t, { omitNative: true });
  assert.throws(stage, /Cannot find module/);
});

test("staging refuses SDK/native version skew", (t) => {
  const { stage } = fixture(t, { nativeVersion: "0.7.14" });
  assert.throws(stage, /native version mismatch/);
});

test("cross-packaging stages the target CPU's native runtime, not the build host's", (t) => {
  // Release jobs build Windows ARM64 on an x64 runner with TARGET=aarch64-pc-windows-msvc.
  assert.equal(targetArch("aarch64-pc-windows-msvc", "x64"), "arm64");
  assert.equal(targetArch("aarch64-unknown-linux-gnu", "x64"), "arm64");
  assert.equal(targetArch("x86_64-apple-darwin", "arm64"), "x64");
  assert.equal(targetArch("", "x64"), "x64");
  const { stage, output } = fixture(t, { platform: "win32", arch: targetArch("aarch64-pc-windows-msvc", "x64") });
  const staged = stage();
  assert.ok(staged.includes("@superradcompany/microsandbox-win32-arm64-msvc"));
  assert.ok(existsSync(join(output, "@superradcompany/microsandbox-win32-arm64-msvc/package.json")));
  assert.ok(!existsSync(join(output, "@superradcompany/microsandbox-win32-x64-msvc")));
});
