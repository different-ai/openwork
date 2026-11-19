import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { microsandboxPlatformPackage, packagedMicrosandboxResolver } from "./prepare-runtime-node-modules.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const { verifyPackagedSandboxDependencies, signMicrosandboxRuntime } = require("./electron-after-pack.cjs");
const { verifyMicrosandboxRuntime } = require("./electron-after-sign.cjs");
const here = dirname(fileURLToPath(import.meta.url));
const nativeRoot = "node_modules/@superradcompany/microsandbox-darwin-arm64";
const executable = `${nativeRoot}/bin/msb`;
const firmware = `${nativeRoot}/lib/libkrunfw.5.dylib`;
const addon = `${nativeRoot}/microsandbox.darwin-arm64.node`;
const context = { electronPlatformName: "darwin", arch: "arm64" };

function write(root, file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

async function fixture(t, { omit = [], helperModule = "microsandbox", aliases = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "packaged-sandbox-boundary-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "input");
  const files = {
    "server/dist/local-sandbox-runtime.js": `import "ipaddr.js"; ${aliases ? 'import "ipaddr-alias.js"; import "ipaddr.js/alias";' : ""} export { loadSdk } from "./packaged-sandbox-assets.js"; const adapter = "@openwork/sandbox-microsandbox"; export const load = () => import(adapter);`,
    "node_modules/ipaddr.js/package.json": JSON.stringify({ name: "ipaddr.js", type: "module", exports: { ".": "./lib/ipaddr.js", "./alias": "./lib/alias.js" } }),
    "node_modules/ipaddr.js/lib/ipaddr.js": "export const fixture = true;",
    "server/dist/packaged-sandbox-assets.js": `import {createRequire} from "node:module"; import {pathToFileURL} from "node:url"; export function loadSdk() { const require = createRequire(import.meta.url); const adapter = require.resolve("@openwork/sandbox-microsandbox"); const entry = createRequire(adapter).resolve("${helperModule}"); return import(pathToFileURL(entry).href); }`,
    "server/dist/packaged-sandbox-image.json": readFileSync(resolve(here, "../../server/src/packaged-sandbox-image.json"), "utf8"),
    "node_modules/@openwork/sandbox-microsandbox/package.json": JSON.stringify({ type: "module", exports: "./dist/index.js" }),
    "node_modules/@openwork/sandbox-microsandbox/dist/index.js": 'export const sdk = () => import("microsandbox");',
    "node_modules/microsandbox/package.json": JSON.stringify({ name: "microsandbox", version: "0.7.15", type: "module", exports: "./dist/index.js", optionalDependencies: { "@superradcompany/microsandbox-darwin-arm64": "0.7.15" } }),
    "node_modules/microsandbox/dist/index.js": 'export { napi } from "./internal/napi.js";',
    "node_modules/microsandbox/dist/internal/napi.js": 'export const napi = "fixture";',
    [`${nativeRoot}/package.json`]: JSON.stringify({ name: "@superradcompany/microsandbox-darwin-arm64", version: "0.7.15" }),
    [executable]: "executable fixture",
    [firmware]: "firmware fixture",
    [addon]: "addon fixture",
  };
  for (const [file, content] of Object.entries(files)) if (!omit.includes(file)) write(source, file, content);
  if (aliases) {
    symlinkSync("ipaddr.js", join(source, "node_modules/ipaddr-alias.js"), "dir");
    symlinkSync("ipaddr.js", join(source, "node_modules/ipaddr.js/lib/alias.js"), "file");
  }
  const archive = join(root, "app.asar");
  await asar.createPackageWithOptions(source, archive, { unpackDir: `${nativeRoot}{,/**}` });
  const image = Buffer.from("OCI archive fixture");
  const lock = JSON.parse(files["server/dist/packaged-sandbox-image.json"]);
  write(root, "sandbox-image/alpine.oci.tar", image);
  write(root, "sandbox-image/manifest.json", JSON.stringify({ arch: "arm64", manifestDigest: lock.manifests.arm64, reference: `${lock.repository}@${lock.manifests.arm64}`, archiveSha256: `sha256:${createHash("sha256").update(image).digest("hex")}` }));
  const entries = new Set(asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/")));
  return { root, archive, entries };
}

test("electron-builder unpack matcher includes native assets from the staged source path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "packaged-native-filter-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { getFileMatchers } = builderRequire("app-builder-lib/out/fileMatcher");
  const config = require("yaml").parse(readFileSync(resolve(here, "../electron-builder.base.yml"), "utf8"));
  const [matcher] = getFileMatchers(config, "asarUnpack", join(root, "out"), { macroExpander: (value) => value, customBuildOptions: {}, globalOutDir: join(root, "out"), defaultSrc: root });
  const filter = matcher.createFilter();
  for (const asset of [executable, firmware, addon]) {
    const file = `.electron-runtime/${asset}`;
    write(root, file, "fixture");
    assert.ok(filter(join(root, file), statSync(join(root, file))), `Staged native asset must unpack: ${file}`);
  }
});

test("ASAR extraction skips package directories ending in .js without dropping their module files", async (t) => {
  const { archive, entries } = await fixture(t);
  assert.ok(entries.has("/node_modules/ipaddr.js"));
  assert.ok("files" in asar.statFile(archive, "node_modules/ipaddr.js"));
  assert.doesNotThrow(() => verifyPackagedSandboxDependencies(archive, entries, context));
});

test("ASAR extraction resolves directory aliases and module file links inside the packaged boundary", { skip: process.platform === "win32" }, async (t) => {
  const { archive, entries } = await fixture(t, { aliases: true });
  assert.ok("link" in asar.statFile(archive, "node_modules/ipaddr-alias.js", false));
  assert.ok("link" in asar.statFile(archive, "node_modules/ipaddr.js/lib/alias.js", false));
  assert.doesNotThrow(() => verifyPackagedSandboxDependencies(archive, entries, context));
});

test("actual packaged ASAR graph resolves lazy adapter and SDK without checkout node_modules", async (t) => {
  const { archive, entries } = await fixture(t);
  assert.doesNotThrow(() => verifyPackagedSandboxDependencies(archive, entries, context));
});

test("package boundary includes the image helper's dynamically resolved SDK", async (t) => {
  const { archive, entries } = await fixture(t, { helperModule: "@fixture/missing-image-sdk" });
  assert.throws(() => verifyPackagedSandboxDependencies(archive, entries, context), /cannot resolve @fixture\/missing-image-sdk imported by server\/dist\/packaged-sandbox-assets.js/);
});

test("package boundary rejects a damaged bundled guest image archive", async (t) => {
  const { root, archive, entries } = await fixture(t);
  write(root, "sandbox-image/alpine.oci.tar", "changed archive");
  assert.throws(() => verifyPackagedSandboxDependencies(archive, entries, context), /guest image archive integrity mismatch/);
});

test("package boundary catches original missing lazy workspace adapter", async (t) => {
  const { archive, entries } = await fixture(t, { omit: ["node_modules/@openwork/sandbox-microsandbox/package.json"] });
  assert.throws(() => verifyPackagedSandboxDependencies(archive, entries, context), /Packaged runtime cannot resolve @openwork\/sandbox-microsandbox/);
});

test("package boundary follows transitive dynamic imports, not only package manifests", async (t) => {
  const { archive, entries } = await fixture(t, { omit: ["node_modules/microsandbox/dist/index.js"] });
  assert.throws(() => verifyPackagedSandboxDependencies(archive, entries, context), /missing: microsandbox/);
});

for (const asset of [executable, firmware, addon]) {
  test(`package boundary rejects missing native asset ${asset}`, async (t) => {
    const { archive, entries } = await fixture(t, { omit: [asset] });
    assert.throws(() => verifyPackagedSandboxDependencies(archive, entries, context), /Missing unpacked microsandbox runtime asset/);
  });
}

test("packaged binary resolver maps ASAR aliases to physical files and leaves normal installs alone", () => {
  const source = 'function msbFileName() { return "msb"; } export function locate(root) { return root ? join(root, "bin", msbFileName()) : null; }';
  const code = `import {join} from 'node:path'; ${packagedMicrosandboxResolver(source)} console.log(locate('/App/Contents/Resources/app.asar/node_modules/native')); console.log(locate('/plain/node_modules/native'));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "/App/Contents/Resources/app.asar.unpacked/node_modules/native/bin/msb\n/plain/node_modules/native/bin/msb\n");
  assert.throws(() => packagedMicrosandboxResolver("changed upstream implementation"), /resolver changed/);
});

test("ASAR resolver transform matches the installed pinned upstream SDK", () => {
  const sdkEntry = require.resolve("microsandbox", { paths: [resolve(here, "../../../packages/sandbox-microsandbox")] });
  const source = readFileSync(join(dirname(sdkEntry), "internal/resolve-binary.js"), "utf8");
  assert.match(packagedMicrosandboxResolver(source), /app\.asar\.unpacked/);
});

test("platform selection matches upstream supported targets without inventing macOS x64", () => {
  assert.equal(microsandboxPlatformPackage("darwin", "arm64"), "@superradcompany/microsandbox-darwin-arm64");
  assert.equal(microsandboxPlatformPackage("linux", "x64"), "@superradcompany/microsandbox-linux-x64-gnu");
  assert.equal(microsandboxPlatformPackage("darwin", "x64"), null);
});

test("msb signing uses dedicated hypervisor entitlement, hardened runtime and distribution timestamp", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "packaged-msb-sign-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appPath = join(root, "OpenWork.app");
  write(appPath, `Contents/Resources/app.asar.unpacked/${executable}`, "fixture");
  const previous = process.env.CSC_NAME;
  process.env.CSC_NAME = "Developer ID Application: fixture";
  t.after(() => { if (previous === undefined) delete process.env.CSC_NAME; else process.env.CSC_NAME = previous; });
  let signingArgs;
  await signMicrosandboxRuntime({ ...context, appOutDir: root, packager: { appInfo: { productFilename: "OpenWork" } } }, { spawn(command, args) { assert.equal(command, "codesign"); signingArgs = args; return { status: 0 }; } });
  assert.ok(signingArgs.includes("--timestamp"));
  assert.equal(signingArgs[signingArgs.indexOf("--options") + 1], "runtime");
  const entitlements = signingArgs[signingArgs.indexOf("--entitlements") + 1];
  assert.match(readFileSync(entitlements, "utf8"), /<key>com.apple.security.hypervisor<\/key>\s*<true\/>/);
  const builder = readFileSync(resolve(here, "../electron-builder.base.yml"), "utf8");
  assert.match(builder, /signIgnore:\s*\n\s*- "\/@superradcompany\/microsandbox-darwin-arm64\/bin\/msb\$"/);
  const signed = { status: 0, stdout: "<key>com.apple.security.hypervisor</key><true/>", stderr: "Authority=Developer ID Application" };
  const verify = (result) => verifyMicrosandboxRuntime(appPath, { runCommand() {}, spawn() { return result; } });
  assert.doesNotThrow(() => verify(signed));
  assert.throws(() => verify({ ...signed, stdout: "<dict/>" }), /Hypervisor entitlement/);
  assert.throws(() => verify({ ...signed, stderr: "Signature=adhoc" }), /Developer ID/);
});
