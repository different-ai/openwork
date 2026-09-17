const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");

const computerUseHelperAppName = "OpenWork Computer Use.app";

const sidecarBases = [
  "opencode",
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
}

function verifyComputerUseArchitecture(context, helperPath) {
  // electron-builder uses the numeric Arch enum; accept names for callers too.
  const arch = typeof context.arch === "number"
    ? ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch] : context.arch;
  const required = { x64: ["x86_64"], arm64: ["arm64"], universal: ["x86_64", "arm64"] }[arch];
  if (!required) throw new Error(`Unsupported Computer Use helper architecture: ${context.arch}`);
  const executable = path.join(helperPath, "Contents", "MacOS", "ComputerUse");
  const result = spawnSync("lipo", [executable, "-verify_arch", ...required], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaged Computer Use helper must contain ${required.join(" and ")}; rebuild it for the package target`);
  }
}

function signComputerUseHelper(context) {
  const appPath = resolveMacAppPath(context);
  if (!appPath) return;

  const helperPath = path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Missing Computer Use helper app at ${helperPath}`);
  }

  verifyComputerUseArchitecture(context, helperPath);

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

function copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName) {
  const targetPath = path.join(sidecarsDir, targetName);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing packaged sidecar for target: ${targetName}`);
  }

  const aliasPath = path.join(sidecarsDir, aliasName);
  fs.copyFileSync(targetPath, aliasPath);
  try {
    fs.chmodSync(aliasPath, 0o755);
  } catch {
    // Windows and some filesystems may ignore chmod.
  }
}

async function afterPack(context) {
  verifyRuntimeDependencies(context);
  signComputerUseHelper(context);
  const triple = targetTriple(context.electronPlatformName, context.arch);
  if (!triple) return;

  const sidecarsDir = resolveSidecarsDir(context);
  if (!sidecarsDir || !fs.existsSync(sidecarsDir)) return;

  const isWindows = context.electronPlatformName === "win32";
  const executableSuffix = isWindows ? ".exe" : "";
  const keep = new Set();

  for (const base of sidecarBases) {
    const aliasName = `${base}${executableSuffix}`;
    const targetName = `${base}-${triple}${executableSuffix}`;
    copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName);
    keep.add(aliasName);
    keep.add(targetName);
  }

  const versionsAlias = "versions.json";
  const versionsTarget = `versions.json-${triple}${executableSuffix}`;
  const versionsTargetPath = path.join(sidecarsDir, versionsTarget);
  if (!fs.existsSync(versionsTargetPath)) {
    throw new Error(`Missing packaged sidecar metadata for target: ${versionsTarget}`);
  }
  fs.copyFileSync(versionsTargetPath, path.join(sidecarsDir, versionsAlias));
  keep.add(versionsAlias);
  keep.add(versionsTarget);

  for (const entry of fs.readdirSync(sidecarsDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(sidecarsDir, entry), { force: true, recursive: true });
    }
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.normalizeAsarEntryPath = normalizeAsarEntryPath;
module.exports.verifyComputerUseArchitecture = verifyComputerUseArchitecture;
