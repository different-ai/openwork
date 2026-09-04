// electron-builder afterSign hook: notarize the signed macOS app when a release
// asks for it (MACOS_NOTARIZE=true with Apple API key credentials), and do
// nothing otherwise — local `package:electron:dir` builds stay unsigned and fast.
// Mirrors the desktop's hook without its Computer Use helper step.
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

async function runWithRetry(command, args, attempts, baseDelayMs = 30_000) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status === 0) return;
    if (attempt >= attempts) {
      throw new Error(`${command} ${args.join(" ")} failed with status ${result.status} after ${attempts} attempts`);
    }
    const delayMs = baseDelayMs * attempt;
    console.warn(`[electron-after-sign] ${command} ${args.join(" ")} failed with status ${result.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to notarize the Electron macOS app`);
  return value;
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.MACOS_NOTARIZE !== "true") {
    console.warn("[electron-after-sign] MACOS_NOTARIZE is not true; skipping notarization.");
    return;
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const notaryTempDir = mkdtempSync(path.join(tmpdir(), "open-coworker-notary-"));
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  const keyPath = requireEnv("APPLE_API_KEY_PATH");
  const keyId = requireEnv("APPLE_API_KEY");
  const issuer = requireEnv("APPLE_API_ISSUER");
  try {
    run("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    run("xcrun", ["notarytool", "submit", notaryZipPath, "--key", keyPath, "--key-id", keyId, "--issuer", issuer, "--wait"]);
    // Tickets can take minutes to reach Apple's CDN; stapler transiently fails with status 65 until then.
    await runWithRetry("xcrun", ["stapler", "staple", appPath], 5);
    run("xcrun", ["stapler", "validate", appPath]);
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
