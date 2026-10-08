import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The macOS half of the packaged gate. Linux boots an unpacked directory that
// can neither write a crash report nor install an update; this lane builds real
// enterprise .app bundles so both can be asserted:
//
// - desktop-quit-path reads ~/Library/Logs/DiagnosticReports after each quit.
// - packaged-update-install lets an activated install download a newer build
//   from a loopback feed, lets Squirrel.Mac apply it on quit, and relaunches.
//
// Squirrel.Mac installs only a bundle that satisfies the running app's
// designated requirement, so both builds are signed with one throwaway
// identity created here. Its keychain lives in the output directory and is on
// the user's keychain search list only while signing.
//
// Every distribution shares the com.differentai.openwork bundle identifier,
// so the update journey uses the same ShipIt cache as an installed OpenWork
// and clears a stale staged update there, as the product does. Run it in CI or
// on a machine whose own OpenWork has no update waiting.
//
// Local rerun: `--prepared` skips electron-build.mjs, `--build-only` stops
// before the journeys, `--artifact-only` reuses the bundles and feed already in
// OPENWORK_PACKAGED_SMOKE_DIR, and `--journey <name>` selects one journey.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = join(repo, "apps/desktop");
if (process.platform !== "darwin") throw new Error("The macOS packaged gate runs on macOS only.");
const output = resolve(process.env.OPENWORK_PACKAGED_SMOKE_DIR || join(tmpdir(), `openwork-packaged-smoke-macos-${process.pid}`));
mkdirSync(output, { recursive: true });
const report = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), phases: [], passed: false };
const started = performance.now();

// Unpublished stable versions: no real release, recovery manifest, or Den
// policy can match them, so nothing outside this run takes part in the update.
const BASE_VERSION = "0.999.0";
const UPDATE_VERSION = "0.999.1";
const PRODUCT_NAME = "OpenWork Enterprise";
const MANIFEST = "enterprise-mac.yml";
const ENTITLEMENTS = join(desktop, "build/entitlements.mac.plist");
const SIGNING_NAME = "OpenWork Eval Update Signing";

const journeys = new Set(process.argv.flatMap((arg, index, all) => arg === "--journey" && all[index + 1] ? [all[index + 1]] : []));
const selected = (journey) => journeys.size === 0 || journeys.has(journey);
const known = new Set(["desktop-quit-path", "packaged-update-install"]);
const unknown = [...journeys].filter((journey) => !known.has(journey));
if (unknown.length) throw new Error(`No macOS packaged check runs journey ${unknown.join(", ")}.`);

function run(name, command, args, { timeout = 600_000, env = {}, cwd = repo } = {}) {
  const phaseStarted = performance.now();
  const result = spawnSync(command, args, { cwd, stdio: "inherit", timeout, env: { ...process.env, ...env } });
  const phase = { name, milliseconds: Math.round(performance.now() - phaseStarted), exitCode: result.status };
  report.phases.push(phase);
  console.log(`[packaged-smoke-macos] ${JSON.stringify(phase)}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed (${result.signal || result.status})`);
}

function quiet(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function userKeychains() {
  return quiet("security", ["list-keychains", "-d", "user"]).split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

/** A self-signed code-signing identity in a private keychain, usable until `release()` runs. */
function createSigningIdentity(directory) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const config = join(directory, "cert.cnf");
  writeFileSync(config, [
    "[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no",
    "[dn]", `CN = ${SIGNING_NAME}`,
    "[ext]", "basicConstraints = critical,CA:false", "keyUsage = critical,digitalSignature", "extendedKeyUsage = critical,codeSigning",
    "",
  ].join("\n"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const bundle = join(directory, "identity.p12");
  // /usr/bin/openssl (LibreSSL) writes a PKCS#12 that `security import` reads; OpenSSL 3 defaults do not.
  quiet("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-config", config]);
  const password = createHash("sha256").update(`${process.pid}:${Date.now()}`).digest("hex");
  quiet("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", bundle, "-passout", `pass:${password}`, "-name", SIGNING_NAME]);
  const keychain = join(directory, "eval-signing.keychain");
  quiet("security", ["create-keychain", "-p", password, keychain]);
  const keychainPath = existsSync(`${keychain}-db`) ? `${keychain}-db` : keychain;
  const previous = userKeychains();
  const release = () => {
    try {
      quiet("security", ["list-keychains", "-d", "user", "-s", ...previous]);
    } finally {
      try { quiet("security", ["delete-keychain", keychainPath]); } catch { /* Already gone. */ }
    }
  };
  try {
    quiet("security", ["set-keychain-settings", keychainPath]);
    quiet("security", ["unlock-keychain", "-p", password, keychainPath]);
    quiet("security", ["import", bundle, "-k", keychainPath, "-P", password, "-T", "/usr/bin/codesign"]);
    quiet("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychainPath]);
    // codesign finds identities only through the search list, even with --keychain.
    quiet("security", ["list-keychains", "-d", "user", "-s", ...previous, keychainPath]);
    const fingerprint = quiet("/usr/bin/openssl", ["x509", "-in", cert, "-noout", "-fingerprint", "-sha1"]);
    const hash = fingerprint.split("=")[1]?.replaceAll(":", "");
    if (!hash) throw new Error(`Could not read the signing certificate fingerprint: ${fingerprint}`);
    return { hash, release };
  } catch (error) {
    release();
    throw error;
  } finally {
    rmSync(key, { force: true });
    rmSync(bundle, { force: true });
  }
}

function packageEnterprise(version, directory) {
  rmSync(directory, { recursive: true, force: true });
  run(`package-enterprise-${version}`, "pnpm", ["--dir", "apps/desktop", "exec", "electron-builder",
    // The zip target, not --dir: electron-builder writes Resources/app-update.yml
    // (which electron-updater requires to download) only for zip or dmg builds.
    "--config", "electron-builder.enterprise.yml", "--mac", "zip", `--${process.arch}`, "--publish", "never",
    `--config.extraMetadata.version=${version}`, "--config.mac.identity=null",
    `--config.directories.output=${directory}`], { env: { CSC_IDENTITY_AUTO_DISCOVERY: "false", MACOS_NOTARIZE: "false" } });
  return findApp(directory);
}

/** electron-builder unpacks to `mac` (x64) or `mac-arm64` beside the zip. */
function findApp(directory) {
  const app = existsSync(directory)
    ? readdirSync(directory).map((name) => join(directory, name, `${PRODUCT_NAME}.app`)).find((path) => existsSync(path))
    : undefined;
  if (!app) throw new Error(`No ${PRODUCT_NAME}.app under ${directory}`);
  return app;
}

function machOFilesUnder(directory) {
  const candidates = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => /\.(?:node|dylib|so)$/.test(path) || (statSync(path).mode & 0o111) !== 0);
  return candidates.filter((path) => quiet("file", ["-b", path]).startsWith("Mach-O"));
}

/** Sign inside-out like electron-builder: loose binaries in Resources first, then every nested bundle and the app. */
function sign(app, identity) {
  const phaseStarted = performance.now();
  const common = ["--force", "--options", "runtime", "--timestamp=none", "--entitlements", ENTITLEMENTS, "--sign", identity];
  for (const binary of machOFilesUnder(join(app, "Contents/Resources"))) quiet("codesign", [...common, binary]);
  quiet("codesign", [...common, "--deep", app]);
  quiet("codesign", ["--verify", "--deep", "--strict", app]);
  report.phases.push({ name: `sign-${basename(dirname(dirname(app)))}`, milliseconds: Math.round(performance.now() - phaseStarted), exitCode: 0 });
}

function bundleVersion(app) {
  return quiet("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")]);
}

/** The generic-provider feed electron-updater reads: `${channel}-mac.yml` beside the update zip. */
function writeFeed(app, version, feed) {
  rmSync(feed, { recursive: true, force: true });
  mkdirSync(feed, { recursive: true });
  const zipName = `openwork-enterprise-mac-${process.arch}-${version}.zip`;
  const zip = join(feed, zipName);
  run(`zip-${version}`, "ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const bytes = readFileSync(zip);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  writeFileSync(join(feed, MANIFEST), [
    `version: ${version}`,
    "files:",
    `  - url: ${zipName}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    `path: ${zipName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n"));
}

function journey(name, binary, extraEnv = {}) {
  run(`journey-${name}`, "pnpm", ["evals:e2e", name, "--local"], {
    timeout: 900_000,
    env: {
      OPENWORK_EVAL_ELECTRON_BINARY: binary,
      OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1",
      OPENWORK_EVAL_ENGINE: "v1",
      OPENWORK_EVAL_SURFACES_DIR: join(output, "profiles", name),
      ELECTRON_RUN_AS_NODE: "",
      NODE_PATH: "", NODE_OPTIONS: "",
      ...extraEnv,
    },
  });
}

const baseDir = join(output, "enterprise-base");
const updateDir = join(output, "enterprise-update");
const feedDir = join(output, "feed");
const failures = [];

try {
  if (!process.argv.includes("--artifact-only")) {
    if (!process.argv.includes("--prepared")) {
      run("prepare", process.execPath, ["apps/desktop/scripts/electron-build.mjs",
        ...(process.argv.includes("--server-built") ? ["--server-built"] : [])], { timeout: 900_000 });
    }
    const base = packageEnterprise(BASE_VERSION, baseDir);
    const update = selected("packaged-update-install") ? packageEnterprise(UPDATE_VERSION, updateDir) : null;
    const identity = createSigningIdentity(join(output, "signing"));
    try {
      sign(base, identity.hash);
      if (update) sign(update, identity.hash);
    } finally {
      identity.release();
    }
    if (update) writeFeed(update, UPDATE_VERSION, feedDir);
  }
  const app = findApp(baseDir);
  if (bundleVersion(app) !== BASE_VERSION) throw new Error(`${app} is ${bundleVersion(app)}, expected ${BASE_VERSION}`);
  const binary = join(app, "Contents/MacOS", PRODUCT_NAME);
  // Each journey records its own evidence; one failing must not hide the other.
  for (const [name, env] of [
    ["desktop-quit-path", {}],
    ["packaged-update-install", { OPENWORK_EVAL_UPDATE_FEED_DIR: feedDir }],
  ]) {
    if (!selected(name) || process.argv.includes("--build-only")) continue;
    try {
      journey(name, binary, env);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} macOS packaged journey(s) failed`);
  report.passed = true;
} finally {
  report.totalMilliseconds = Math.round(performance.now() - started);
  writeFileSync(join(output, "timing.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Packaged desktop smoke (macOS)\n\n${report.passed ? "Passed" : "Failed"}; ${Math.round(report.totalMilliseconds / 1000)} seconds.\n\n| Phase | Seconds |\n| --- | ---: |\n${report.phases.map((p) => `| ${p.name} | ${(p.milliseconds / 1000).toFixed(1)} |`).join("\n")}\n`);
  }
}
