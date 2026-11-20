import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "@openwork/testkit";
import { stageRuntimeNodeModules, targetArch } from "../../apps/desktop/scripts/prepare-runtime-node-modules.mjs";

type Spawn = (command: string, args: string[]) => { status: number; stdout: string; stderr: string };
const { verifyMicrosandboxRuntime } = createRequire(import.meta.url)("../../apps/desktop/scripts/electron-after-sign.cjs") as {
  verifyMicrosandboxRuntime(appPath: string, options: { runCommand(command: string, args: string[]): void; spawn: Spawn }): void;
};

const native = "@superradcompany/microsandbox-darwin-arm64";

// The release's Intel macOS jobs run `build:electron` on an Apple silicon
// runner with TARGET=x86_64-apple-darwin. pnpm installs both CPU variants, so
// only the build target, never the runner, may decide which runtime ships.
function stageFor(target: string) {
  const root = mkdtempSync(join(tmpdir(), "intel-macos-packaging-"));
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  const pkg = (name: string, dependencies = {}, optionalDependencies = {}) => {
    write(`node_modules/${name}/package.json`, { name, version: "0.7.15", type: "module", main: "./dist/index.js", dependencies, optionalDependencies });
    write(`node_modules/${name}/dist/index.js`, "export const fixture = true;");
  };
  write("package.json", { private: true });
  pkg("@openwork/sandbox-microsandbox", { microsandbox: "0.7.15" });
  pkg("microsandbox", {}, { [native]: "0.7.15" });
  write("node_modules/microsandbox/dist/internal/resolve-binary.js", 'function msbPath(root) { return root ? join(root, "bin", msbFileName()) : null; }');
  pkg(native);
  write(`node_modules/${native}/bin/msb`, "Apple silicon executable");
  const app = join(root, "OpenWork.app");
  // The CLI passes targetArch() with the job's TARGET; the host is the arm64 runner.
  const staged = stageRuntimeNodeModules(join(app, "Contents/Resources/app.asar.unpacked/node_modules"), {
    roots: [{ name: "@openwork/sandbox-microsandbox", fromPackageJson: join(root, "package.json") }], platform: "darwin", arch: targetArch(target, "arm64"),
  });
  return { root, app, staged };
}

function afterSign(app: string, signature: string) {
  const calls: string[] = [];
  const spawn: Spawn = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { status: 0, stdout: "<key>com.apple.security.hypervisor</key><true/>", stderr: signature };
  };
  let error: unknown = null;
  try {
    verifyMicrosandboxRuntime(app, { runCommand: (command, args) => calls.push(`${command} ${args.join(" ")}`), spawn });
  } catch (caught) {
    error = caught;
  }
  return { calls, error };
}

test("an Intel macOS release built on Apple silicon ships no Apple silicon microsandbox runtime", ({ evidence }) => {
  const intel = stageFor("x86_64-apple-darwin");
  const appleSilicon = stageFor("aarch64-apple-darwin");
  try {
    const intelShipsArm = existsSync(join(intel.app, "Contents/Resources/app.asar.unpacked/node_modules", native));
    const intelSign = afterSign(intel.app, "Signature=adhoc");
    evidence.recordAssertionEvidence(
      "Intel staging omits the Apple silicon runtime, so afterSign has no unsigned msb to reject",
      `staged: ${intel.staged.join(", ")}; codesign calls: ${intelSign.calls.length}; error: ${String(intelSign.error)}`,
      !intelShipsArm && intel.staged.includes("microsandbox") && intelSign.calls.length === 0 && intelSign.error === null,
    );
    assert.equal(intelShipsArm, false);
    assert.ok(intel.staged.includes("microsandbox"));
    assert.deepEqual(intelSign.calls, []);
    assert.equal(intelSign.error, null);

    const armMsb = join(appleSilicon.app, "Contents/Resources/app.asar.unpacked/node_modules", native, "bin/msb");
    const adhoc = afterSign(appleSilicon.app, "Signature=adhoc");
    const developerId = afterSign(appleSilicon.app, "Authority=Developer ID Application: fixture");
    evidence.recordAssertionEvidence(
      "Apple silicon still ships msb and afterSign still rejects an ad-hoc signature",
      `staged: ${appleSilicon.staged.join(", ")}; adhoc: ${String(adhoc.error)}; Developer ID: ${String(developerId.error)}`,
      existsSync(armMsb) && /requires a Developer ID signature/.test(String(adhoc.error)) && developerId.error === null,
    );
    assert.ok(existsSync(armMsb));
    assert.match(String(adhoc.error), /Notarized microsandbox runtime requires a Developer ID signature/);
    assert.ok(adhoc.calls.some((call) => call.startsWith("codesign --verify") && call.endsWith(armMsb)));
    assert.equal(developerId.error, null);
  } finally {
    rmSync(intel.root, { recursive: true, force: true });
    rmSync(appleSilicon.root, { recursive: true, force: true });
  }
});
