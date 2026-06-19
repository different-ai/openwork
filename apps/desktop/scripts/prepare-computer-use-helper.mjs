import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const packagePath = resolve(repoRoot, "packages", "handsfree", "native", "HandsFree");
const iconPath = resolve(desktopRoot, "resources", "icons", "icon.icns");
const productName = "HandsFreeComputerUse";
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

if (process.platform !== "darwin") {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: "computer-use-helper-is-macos-only" }, null, 2) + "\n");
  process.exit(0);
}

if (!force && existsSync(join(appPath, "Contents", "MacOS", helperExecutableName))) {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, appPath }, null, 2) + "\n");
  process.exit(0);
}

run("swift", ["build", "--package-path", packagePath, "-c", "release", "--product", productName], { stdio: "inherit" });
const binPathResult = run("swift", ["build", "--package-path", packagePath, "-c", "release", "--show-bin-path"]);
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
chmodSync(join(appPath, "Contents", "MacOS", helperExecutableName), 0o755);
signHelperApp();

process.stdout.write(JSON.stringify({ ok: true, appPath, executable: join(appPath, "Contents", "MacOS", helperExecutableName) }, null, 2) + "\n");
