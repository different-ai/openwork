const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const computerUseHelperAppName = "OpenWork Computer Use.app";

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
    console.warn(
      `[electron-after-sign] ${command} ${args.join(" ")} failed with status ${result.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to notarize the Electron macOS app`);
  }
  return value;
}

function computerUseHelperPath(appPath) {
  return path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
}

function verifyComputerUseHelper(appPath, requireDistributionSignature, { runCommand = run, spawn = spawnSync } = {}) {
  const helperPath = computerUseHelperPath(appPath);
  if (!existsSync(helperPath)) {
    throw new Error(`Computer Use helper app is missing from packaged app: ${helperPath}`);
  }

  runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=2", helperPath]);

  if (!requireDistributionSignature) return;
  const result = spawn("codesign", ["--display", "--verbose=4", helperPath], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign --display failed for Computer Use helper with status ${result.status}`);
  }
  if (result.stderr.includes("Signature=adhoc")) {
    throw new Error("Computer Use helper app is ad-hoc signed; notarized builds require a Developer ID signature.");
  }
}

// Offline checks on the signed, notarized, stapled bundle. These read the
// bundle itself, so they never guess the executable name (it follows each
// flavor's productName) and never launch the app on the build machine.
// Launch and render coverage belongs to the packaged-app journeys, which run
// against the built artifacts rather than inside electron-builder.
function verifySignedApp(appPath, { runCommand = run } = {}) {
  runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  runCommand("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  runCommand("xcrun", ["stapler", "validate", appPath]);
}

function notarizeApp(zipPath, { keyPath, keyId, issuer }, { spawn = spawnSync, report = console.error } = {}) {
  const credentials = ["--key", keyPath, "--key-id", keyId, "--issuer", issuer];
  const capture = (args, operation) => {
    const result = spawn("xcrun", ["notarytool", ...args, ...credentials], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      const reason = result.error ? `process error (${result.error.code || "unknown"})`
        : result.signal ? `signal ${result.signal}` : `status ${result.status}`;
      // Never include the command arguments: they contain signing credentials.
      throw new Error(`notarytool ${operation} failed with ${reason}`);
    }
    return result.stdout;
  };

  let submission;
  try {
    submission = JSON.parse(capture(["submit", zipPath, "--wait", "--output-format", "json"], "submit"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("notarytool submit returned malformed JSON");
    }
    throw error;
  }
  if (!submission || typeof submission.status !== "string") {
    throw new Error("notarytool submit returned JSON without a status");
  }
  if (submission.status === "Accepted") return;

  if (typeof submission.id === "string" && submission.id) {
    try {
      const log = capture(["log", submission.id], "log");
      // Redact credentials even if Apple's diagnostic output happens to echo them.
      const safeLog = [keyPath, keyId, issuer].reduce((text, secret) => text.split(secret).join("[redacted]"), log);
      report(`[electron-after-sign] Notarization issue report:\n${safeLog}`);
    } catch (error) {
      report(`[electron-after-sign] ${error.message}`);
    }
  } else {
    report("[electron-after-sign] Notarization response has no submission ID; cannot fetch issue report.");
  }
  throw new Error("notarytool submit was not Accepted; notarization failed (see issue report)");
}

async function afterSign(context, { runCommand = run, runRetry = runWithRetry, spawnNotary = spawnSync, report = console.error } = {}) {
  if (context.electronPlatformName !== "darwin") return;

  if (process.env.MACOS_NOTARIZE !== "true") {
    console.warn("[electron-after-sign] MACOS_NOTARIZE is not true; skipping notarization.");
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  verifyComputerUseHelper(appPath, process.env.MACOS_NOTARIZE === "true", { runCommand, spawn: spawnNotary });

  const notaryTempDir = mkdtempSync(path.join(tmpdir(), "openwork-electron-notary-"));
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  const keyPath = requireEnv("APPLE_API_KEY_PATH");
  const keyId = requireEnv("APPLE_API_KEY");
  const issuer = requireEnv("APPLE_API_ISSUER");

  try {
    runCommand("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    notarizeApp(notaryZipPath, { keyPath, keyId, issuer }, { spawn: spawnNotary, report });
    // Notarization tickets can take minutes to propagate to Apple's CDN after acceptance; stapler can transiently fail with status 65 ("CloudKit query failed").
    await runRetry("xcrun", ["stapler", "staple", appPath], 5);
    verifySignedApp(appPath, { runCommand });
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.runWithRetry = runWithRetry;
module.exports.verifySignedApp = verifySignedApp;
