import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const packagePath = resolve(repoRoot, "packages", "computer-use", "native");
const iconPath = resolve(desktopRoot, "resources", "icons", "icon.icns");
const productName = "ComputerUse";
const helperExecutableName = "ComputerUse";
const helperAppName = "OpenWork Computer Use.app";
const bundleIdentifier = "com.differentai.openwork.computer-use";

const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const outDir = resolve(readArg("--outdir") ?? join(desktopRoot, "resources", "helpers"));
const force = hasFlag("--force") || process.env.OPENWORK_COMPUTER_USE_FORCE_BUILD === "1";
const appPath = join(outDir, helperAppName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result;
}

function signingIdentity() {
  const fromEnv = process.env.OPENWORK_COMPUTER_USE_SIGN_IDENTITY;
  if (fromEnv) return fromEnv;
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (result.status !== 0) return "-";
  const match = result.stdout.match(/"(Developer ID Application: [^"]+)"/);
  // Prefer a stable Developer ID signature so macOS TCC permission grants
  // (Accessibility, Screen Recording) survive rebuilds. Ad-hoc signatures are
  // content hashes, so every rebuild would invalidate existing grants.
  return match ? match[1] : "-";
}

function signHelperApp() {
  if (process.platform !== "darwin") return;
  const identity = signingIdentity();
  const args = ["--force", "--deep", "--sign", identity];
  if (identity !== "-") args.push("--options", "runtime");
  const result = spawnSync("codesign", [...args, appPath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (identity !== "-" && (result.status !== 0 || result.error)) {
    // Keychain may refuse non-interactive signing; fall back to ad-hoc.
    const fallback = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (fallback.status === 0) return;
  }
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare the Computer Use helper app");
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to codesign ${appPath}: ${result.stderr?.trim() ?? "unknown error"}`);
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>OpenWork Computer Use</string>
  <key>CFBundleExecutable</key>
  <string>${helperExecutableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>OpenWork Computer Use</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
`;
}

/** This PC: the Windows helper, built with the .NET Framework compiler every
 * Windows 10/11 install carries, so it needs no SDK. electron-builder signs it
 * with OpenWork's identity like openwork-dictation.exe. A missing compiler is
 * not fatal: This PC then reports the helper missing. */
function prepareWindowsHelper() {
  const source = resolve(repoRoot, "packages", "computer-use", "windows", "ComputerUse.cs");
  const executable = join(outDir, "openwork-computer-use.exe");
  const fingerprintPath = join(outDir, "openwork-computer-use.sha256");
  const sourceHash = createHash("sha256").update(readFileSync(source)).update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  if (!force && existsSync(executable) && existsSync(fingerprintPath) && readFileSync(fingerprintPath, "utf8").trim() === sourceHash) {
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, executable }, null, 2) + "\n");
    return;
  }
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const framework = ["Framework64", "Framework"].map((dir) => join(systemRoot, "Microsoft.NET", dir, "v4.0.30319"))
    .find((dir) => existsSync(join(dir, "csc.exe")));
  const result = framework
    ? spawnSync(join(framework, "csc.exe"), [
      "/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${executable}`,
      ...["System.Core.dll", "System.Drawing.dll", "System.Web.Extensions.dll"].map((name) => `/reference:${join(framework, name)}`), source,
    ], { stdio: "inherit" })
    : { error: { message: "The .NET Framework compiler is missing" } };
  if (result.error || result.status !== 0) {
    const message = `Windows computer use helper was not built (${result.error?.message ?? `status ${result.status}`}); This PC will report it missing.`;
    process.stderr.write(process.env.GITHUB_ACTIONS ? `::warning::${message}\n` : `${message}\n`);
    return;
  }
  writeFileSync(fingerprintPath, sourceHash, "utf8");
  process.stdout.write(JSON.stringify({ ok: true, executable }, null, 2) + "\n");
}

if (process.platform === "win32") {
  mkdirSync(outDir, { recursive: true });
  prepareWindowsHelper();
  process.exit(0);
}

if (process.platform !== "darwin") {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: "computer-use-helper-is-macos-and-windows-only" }, null, 2) + "\n");
  process.exit(0);
}

// A cached helper is usable only for these exact native sources and target.
// SwiftPM handles incremental compilation when the fingerprint changes.
const fingerprint = createHash("sha256").update(process.arch);
function hashSources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = join(directory, entry.name);
    fingerprint.update(source.slice(packagePath.length));
    if (entry.isDirectory()) hashSources(source);
    else fingerprint.update(readFileSync(source));
  }
}
hashSources(join(packagePath, "Sources"));
for (const source of [join(packagePath, "Package.swift"), join(packagePath, "Package.resolved"), fileURLToPath(import.meta.url), iconPath]) {
  if (existsSync(source)) fingerprint.update(readFileSync(source));
}
const sourceHash = fingerprint.digest("hex");
const fingerprintPath = join(appPath, "Contents", "Resources", "source.sha256");
const cachedHash = existsSync(fingerprintPath) ? readFileSync(fingerprintPath, "utf8").trim() : "";
if (!force && cachedHash === sourceHash && existsSync(join(appPath, "Contents", "MacOS", helperExecutableName))) {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, appPath }, null, 2) + "\n");
  process.exit(0);
}

const baseBuildArgs = ["build", "--package-path", packagePath, "-c", "release"];
let buildArgs = baseBuildArgs;
const defaultBuild = spawnSync("swift", [...buildArgs, "--product", productName], { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
if (defaultBuild.error) throw defaultBuild.error;
if (defaultBuild.status !== 0) {
  // SwiftPM 6.4+ defaults to the swiftbuild system, which fails to initialise
  // on Command Line Tools-only machines ("Unknown error parsing property list").
  // The native build system still works there, so retry with it once.
  process.stderr.write(`${defaultBuild.stderr ?? ""}\nswift build failed with the default build system; retrying with --build-system native.\n`);
  buildArgs = [...baseBuildArgs, "--build-system", "native"];
  run("swift", [...buildArgs, "--product", productName], { stdio: "inherit" });
}
const binPathResult = run("swift", [...buildArgs, "--show-bin-path"]);
const binDir = binPathResult.stdout.trim();
const builtExecutable = join(binDir, productName);
if (!existsSync(builtExecutable)) {
  throw new Error(`Swift build succeeded, but ${builtExecutable} was not found`);
}

rmSync(appPath, { recursive: true, force: true });
mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
writeFileSync(join(appPath, "Contents", "Info.plist"), infoPlist(), "utf8");
writeFileSync(join(appPath, "Contents", "PkgInfo"), "APPL????", "utf8");
copyFileSync(builtExecutable, join(appPath, "Contents", "MacOS", helperExecutableName));
if (existsSync(iconPath)) {
  copyFileSync(iconPath, join(appPath, "Contents", "Resources", "AppIcon.icns"));
}
writeFileSync(fingerprintPath, sourceHash, "utf8");
chmodSync(join(appPath, "Contents", "MacOS", helperExecutableName), 0o755);
signHelperApp();

process.stdout.write(JSON.stringify({ ok: true, appPath, executable: join(appPath, "Contents", "MacOS", helperExecutableName) }, null, 2) + "\n");
