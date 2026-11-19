const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");
const { Arch } = require("electron-builder");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");

const computerUseHelperAppName = "OpenWork Computer Use.app";

const sidecarBases = [
  "opencode",
  "opencode2",
];

function targetTriple(platformName, arch) {
  if (platformName === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (platformName === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (platformName === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

function resolveSidecarsDir(context) {
  if (context.electronPlatformName === "darwin") {
    const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
    const appName = entries.find((entry) => entry.endsWith(".app"));
    return appName ? path.join(context.appOutDir, appName, "Contents", "Resources", "sidecars") : null;
  }
  return path.join(context.appOutDir, "resources", "sidecars");
}

function resolveMacAppPath(context) {
  if (context.electronPlatformName !== "darwin") return null;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const direct = path.join(context.appOutDir, appName);
  if (fs.existsSync(direct)) return direct;

  const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
  const fallback = entries.find((entry) => entry.endsWith(".app"));
  return fallback ? path.join(context.appOutDir, fallback) : null;
}

function resolveAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appPath = resolveMacAppPath(context);
    return appPath ? path.join(appPath, "Contents", "Resources", "app.asar") : null;
  }
  return path.join(context.appOutDir, "resources", "app.asar");
}

function normalizeAsarEntryPath(entry, separator) {
  return entry.split(separator).join("/");
}

// @electron/asar looks up nested entries by host separators only, so a
// forward-slash path below the archive root is not found on Windows.
function asarLookupPath(file) {
  return file.split("/").join(path.sep);
}

function verifyRuntimeDependencies(context) {
  const appAsarPath = resolveAppAsarPath(context);
  if (!appAsarPath || !fs.existsSync(appAsarPath)) {
    throw new Error(`Missing packaged app.asar at ${appAsarPath || context.appOutDir}`);
  }
  const packagedFiles = new Set(
    asar
      .listPackage(appAsarPath, { isPack: false })
      .map((entry) => normalizeAsarEntryPath(entry, path.sep)),
  );
  const stagedNodeModules = path.resolve(__dirname, "..", ".electron-runtime", "node_modules");
  const packageJsonPaths = [];
  function visitNodeModules(nodeModulesPath, archivePrefix) {
    for (const entry of fs.readdirSync(nodeModulesPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        visitNodeModules(path.join(nodeModulesPath, entry.name), `${archivePrefix}/${entry.name}`);
        continue;
      }
      const packagePath = path.join(nodeModulesPath, entry.name);
      if (!fs.existsSync(path.join(packagePath, "package.json"))) continue;
      const packageJsonPath = `${archivePrefix}/${entry.name}/package.json`;
      packageJsonPaths.push(packageJsonPath);
      const nestedNodeModules = path.join(packagePath, "node_modules");
      if (fs.existsSync(nestedNodeModules)) {
        visitNodeModules(nestedNodeModules, `${archivePrefix}/${entry.name}/node_modules`);
      }
    }
  }
  if (!fs.existsSync(stagedNodeModules)) {
    throw new Error(`Missing staged MCP runtime at ${stagedNodeModules}`);
  }
  visitNodeModules(stagedNodeModules, "/node_modules");
  if (packageJsonPaths.length === 0) throw new Error("The staged MCP runtime is empty.");
  for (const packageJsonPath of packageJsonPaths) {
    if (!packagedFiles.has(packageJsonPath)) {
      throw new Error(`Missing staged MCP runtime package from app.asar: ${packageJsonPath}`);
    }
  }
  verifyCompiledTypes(appAsarPath, packagedFiles);
  verifyUnusedDependencyFiles(packagedFiles);
  verifyPackagedSandboxDependencies(appAsarPath, packagedFiles, context);
}

function verifyPackagedSandboxDependencies(appAsarPath, packagedFiles, context) {
  const arch = typeof context.arch === "number" ? Arch[context.arch] : context.arch;
  const triples = { "darwin-arm64": "darwin-arm64", "linux-x64": "linux-x64-gnu", "linux-arm64": "linux-arm64-gnu", "win32-x64": "win32-x64-msvc", "win32-arm64": "win32-arm64-msvc" };
  const triple = triples[`${context.electronPlatformName}-${arch}`];
  // Upstream has no Darwin x64 runtime; only supported native targets have
  // assets to check. Every target still verifies the adapter's ESM graph.
  if (triple) {
    const nativeRoot = `node_modules/@superradcompany/microsandbox-${triple}`;
    const windows = context.electronPlatformName === "win32";
    const library = context.electronPlatformName === "darwin" ? "libkrunfw.5.dylib" : windows ? "libkrunfw.dll" : "libkrunfw.so.5.6.1";
    const nativeFiles = [`${nativeRoot}/microsandbox.${triple}.node`, `${nativeRoot}/bin/msb${windows ? ".exe" : ""}`, `${nativeRoot}/lib/${library}`];
    for (const file of nativeFiles) {
      if (!packagedFiles.has(`/${file}`) || !fs.existsSync(path.join(`${appAsarPath}.unpacked`, file))) {
        throw new Error(`Missing unpacked microsandbox runtime asset: ${file}`);
      }
    }
    const sdk = JSON.parse(asar.extractFile(appAsarPath, asarLookupPath("node_modules/microsandbox/package.json")));
    const native = JSON.parse(asar.extractFile(appAsarPath, asarLookupPath(`${nativeRoot}/package.json`)));
    if (sdk.version !== native.version || sdk.optionalDependencies[native.name] !== native.version) {
      throw new Error("Packaged microsandbox SDK and native runtime versions do not match.");
    }
  }
  verifyPackagedSandboxImage(appAsarPath, arch);
  const extracted = fs.mkdtempSync(path.join(tmpdir(), "openwork-packaged-dependencies-"));
  try {
    // Only executable module sources and manifests, not renderer/media/native
    // payloads. Node resolves against this isolated copy of the actual ASAR.
    for (const entry of packagedFiles) {
      if (!/^\/(?:server\/|node_modules\/)/.test(entry)) continue;
      const file = entry.slice(1);
      const archiveFile = asarLookupPath(file);
      const info = asar.statFile(appAsarPath, archiveFile, false);
      const destination = path.join(extracted, file);
      if ("link" in info) {
        // ASAR links are archive-root-relative, not relative to the alias.
        // Preserve directory aliases so Node sees the same package tree.
        const target = path.resolve(extracted, info.link);
        const relativeTarget = path.relative(extracted, target);
        if (path.isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) throw new Error(`Packaged runtime link escapes archive: ${file}`);
        const resolved = asar.statFile(appAsarPath, archiveFile);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if ("files" in resolved) {
          fs.symlinkSync(process.platform === "win32" ? target : path.relative(path.dirname(destination), target), destination, process.platform === "win32" ? "junction" : "dir");
        } else if (/\.(?:[cm]?js|json)$/.test(file)) {
          fs.writeFileSync(destination, asar.extractFile(appAsarPath, archiveFile));
        }
        continue;
      }
      // Package directories such as ipaddr.js also have JavaScript suffixes.
      if ("files" in info || !/\.(?:[cm]?js|json)$/.test(file)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, asar.extractFile(appAsarPath, archiveFile));
    }
    const result = spawnSync(process.execPath, ["--experimental-import-meta-resolve", path.join(__dirname, "packaged-runtime-dependencies.mjs"), extracted], { encoding: "utf8", env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Packaged sandbox dependency boundary failed:\n${result.stderr}`);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

function verifyPackagedSandboxImage(appAsarPath, arch) {
  const lock = JSON.parse(asar.extractFile(appAsarPath, asarLookupPath("server/dist/packaged-sandbox-image.json")));
  const imageRoot = path.join(path.dirname(appAsarPath), "sandbox-image");
  const metadata = JSON.parse(fs.readFileSync(path.join(imageRoot, "manifest.json"), "utf8"));
  const digest = lock.manifests[arch];
  if (!digest || metadata.arch !== arch || metadata.manifestDigest !== digest || metadata.reference !== `${lock.repository}@${digest}`) {
    throw new Error("Packaged sandbox guest image does not match the server's pinned platform image.");
  }
  const archive = fs.readFileSync(path.join(imageRoot, "alpine.oci.tar"));
  if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== metadata.archiveSha256) throw new Error("Packaged sandbox guest image archive integrity mismatch.");
}

// The packaging filters leave out dependency files that only a debugger or a
// compiler reads. Fail the package if they return, or if the filters take the
// one TypeScript file computer use imports.
function verifyUnusedDependencyFiles(packagedFiles) {
  const typescript = "/node_modules/typescript";
  if (packagedFiles.has(`${typescript}/package.json`) && !packagedFiles.has(`${typescript}/lib/typescript.js`)) {
    throw new Error("Packaged TypeScript is missing lib/typescript.js, which computer use imports.");
  }
  const unused = [...packagedFiles].filter((entry) =>
    /\.[cm]?[jt]s\.map$|\.d\.[cm]?ts$/.test(entry)
    || /\/typescript\/(?:bin|lib\/(?!typescript\.js$)[^/]+)(?:\/|$)/.test(entry)
    || /\/better-sqlite3\/(?:deps|src)(?:\/|$)/.test(entry));
  if (unused.length > 0) {
    throw new Error(`Packaged app.asar ships files the app never loads: ${unused.slice(0, 5).join(", ")}`);
  }
}

// The app loads @openwork/types as plain Node, which refuses TypeScript under
// node_modules. Fail the package unless every export is compiled JavaScript.
function verifyCompiledTypes(appAsarPath, packagedFiles) {
  const packageRoot = "node_modules/@openwork/types";
  // ASAR extraction uses host separators; packagedFiles uses normalized slashes.
  const manifest = JSON.parse(asar.extractFile(appAsarPath, path.join(packageRoot, "package.json")).toString("utf8"));
  const unloadable = Object.entries(manifest.exports).filter(([, target]) =>
    typeof target !== "string" || !target.endsWith(".js") || !packagedFiles.has(`/${packageRoot}/${target.replace(/^\.\//, "")}`));
  if (unloadable.length > 0) {
    throw new Error(`Packaged @openwork/types exports are not compiled JavaScript: ${unloadable.map(([subpath]) => subpath).join(", ")}`);
  }
  const source = [...packagedFiles].filter((entry) => entry.startsWith(`/${packageRoot}/`) && entry.endsWith(".ts"));
  if (source.length > 0) {
    throw new Error(`Packaged @openwork/types still ships TypeScript source: ${source.slice(0, 5).join(", ")}`);
  }
}

async function signMicrosandboxRuntime(context, { spawn = spawnSync } = {}) {
  const appPath = resolveMacAppPath(context);
  const arch = typeof context.arch === "number" ? Arch[context.arch] : context.arch;
  if (!appPath || arch !== "arm64") return;
  const executable = path.join(appPath, "Contents/Resources/app.asar.unpacked/node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb");
  if (!fs.existsSync(executable)) throw new Error(`Missing microsandbox executable: ${executable}`);
  // Reuse electron-builder's imported CSC_LINK keychain as well as local
  // identities. CI supplies the certificate, not necessarily CSC_NAME.
  const signing = await context.packager.codeSigningInfo?.value;
  const keychain = signing?.keychainFile;
  let identity = process.env.CSC_NAME || process.env.APPLE_CODESIGN_IDENTITY;
  if (!identity && (keychain || process.env.MACOS_NOTARIZE === "true")) {
    const lookup = spawn("security", ["find-identity", "-v", "-p", "codesigning", ...(keychain ? [keychain] : [])], { encoding: "utf8" });
    if (lookup.error) throw lookup.error;
    if (lookup.status !== 0) throw new Error("Could not resolve microsandbox signing identity.");
    identity = lookup.stdout.match(/\b([A-Fa-f0-9]{40})\s+"Developer ID Application:[^"]+"/)?.[1];
  }
  if (!identity && process.env.MACOS_NOTARIZE === "true") throw new Error("A Developer ID identity is required to sign the microsandbox runtime.");
  identity ||= "-";
  const args = ["--force", "--options", "runtime", "--entitlements", path.resolve(__dirname, "../build/entitlements.microsandbox.mac.plist"), "--sign", identity];
  if (keychain) args.push("--keychain", keychain);
  if (identity !== "-") args.push("--timestamp");
  args.push(executable);
  const result = spawn("codesign", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign failed for microsandbox with status ${result.status}`);
}

function signComputerUseHelper(context) {
  const appPath = resolveMacAppPath(context);
  if (!appPath) return;

  const helperPath = path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Missing Computer Use helper app at ${helperPath}`);
  }

  const identity = process.env.OPENWORK_COMPUTER_USE_CODESIGN_IDENTITY
    || process.env.CSC_NAME
    || process.env.APPLE_CODESIGN_IDENTITY
    || "-";
  const args = ["--force", "--deep", "--options", "runtime", "--sign", identity];
  if (identity !== "-") args.push("--timestamp");
  args.push(helperPath);

  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign failed for Computer Use helper app with status ${result.status}`);
  }
}

function moveTargetToCanonical(sidecarsDir, targetName, aliasName) {
  const targetPath = path.join(sidecarsDir, targetName);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing packaged sidecar for target: ${targetName}`);
  }

  const aliasPath = path.join(sidecarsDir, aliasName);
  fs.rmSync(aliasPath, { force: true });
  fs.renameSync(targetPath, aliasPath);
  try {
    fs.chmodSync(aliasPath, 0o755);
  } catch {
    // Windows and some filesystems may ignore chmod.
  }
}

function canonicalizeSidecars(context) {
  // electron-builder passes the numeric Arch enum, not its string name.
  const arch = typeof context.arch === "number" ? Arch[context.arch] : context.arch;
  const triple = targetTriple(context.electronPlatformName, arch);
  if (!triple) throw new Error(`Unsupported sidecar target: ${context.electronPlatformName}/${arch}`);

  const sidecarsDir = resolveSidecarsDir(context);
  if (!sidecarsDir || !fs.existsSync(sidecarsDir)) {
    throw new Error(`Missing packaged sidecars directory: ${sidecarsDir || context.appOutDir}`);
  }

  const isWindows = context.electronPlatformName === "win32";
  const executableSuffix = isWindows ? ".exe" : "";
  const keep = new Set();

  for (const base of sidecarBases) {
    const aliasName = `${base}${executableSuffix}`;
    const targetName = `${base}-${triple}${executableSuffix}`;
    // Preparation keeps target triples for cross-arch/dev builds. The shipped
    // layout needs only the plain name, also used by CLI/PATH consumers.
    moveTargetToCanonical(sidecarsDir, targetName, aliasName);
    keep.add(aliasName);
  }

  const versionsAlias = "versions.json";
  const versionsTarget = `versions.json-${triple}`;
  const versionsTargetPath = path.join(sidecarsDir, versionsTarget);
  if (!fs.existsSync(versionsTargetPath)) {
    throw new Error(`Missing packaged sidecar metadata for target: ${versionsTarget}`);
  }
  fs.rmSync(path.join(sidecarsDir, versionsAlias), { force: true });
  fs.renameSync(versionsTargetPath, path.join(sidecarsDir, versionsAlias));
  keep.add(versionsAlias);

  for (const entry of fs.readdirSync(sidecarsDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(sidecarsDir, entry), { force: true, recursive: true });
    }
  }
}

async function afterPack(context) {
  verifyRuntimeDependencies(context);
  canonicalizeSidecars(context);
  signComputerUseHelper(context);
  await signMicrosandboxRuntime(context);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.normalizeAsarEntryPath = normalizeAsarEntryPath;
module.exports.verifyCompiledTypes = verifyCompiledTypes;
module.exports.verifyUnusedDependencyFiles = verifyUnusedDependencyFiles;
module.exports.canonicalizeSidecars = canonicalizeSidecars;
module.exports.verifyPackagedSandboxDependencies = verifyPackagedSandboxDependencies;
module.exports.signMicrosandboxRuntime = signMicrosandboxRuntime;
