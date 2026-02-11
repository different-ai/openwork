#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const REPO_ROOT = path.resolve(ROOT, "../..");
const args = process.argv.slice(2);

const usage = () => {
  console.log(`Usage:
  node scripts/bump-version.mjs patch|minor|major
  node scripts/bump-version.mjs --set x.y.z
  node scripts/bump-version.mjs --dry-run [patch|minor|major|--set x.y.z]`);
};

const isDryRun = args.includes("--dry-run");
// pnpm forwards args to scripts with an explicit "--" separator; strip it so
// "pnpm bump:set -- 0.1.21" works as expected.
const filtered = args.filter((arg) => arg !== "--dry-run" && arg !== "--");

if (!filtered.length) {
  usage();
  process.exit(1);
}

let mode = filtered[0];
let explicit = null;

if (mode === "--set") {
  explicit = filtered[1] ?? null;
  if (!explicit) {
    console.error("--set requires a version like 0.1.21");
    process.exit(1);
  }
}

const semverPattern = /^\d+\.\d+\.\d+$/;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const bump = (value, bumpMode) => {
  if (!semverPattern.test(value)) {
    throw new Error(`Invalid version: ${value}`);
  }
  const [major, minor, patch] = value.split(".").map(Number);
  if (bumpMode === "major") return `${major + 1}.0.0`;
  if (bumpMode === "minor") return `${major}.${minor + 1}.0`;
  if (bumpMode === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump mode: ${bumpMode}`);
};

const targetVersion = async () => {
  if (explicit) return explicit;
  const pkg = await readJson(path.join(ROOT, "package.json"));
  return bump(pkg.version, mode);
};

const updatePackageJson = async (nextVersion) => {
  const uiPath = path.join(ROOT, "package.json");
  const tauriPath = path.join(REPO_ROOT, "packages", "desktop", "package.json");
  const headlessPath = path.join(REPO_ROOT, "packages", "headless", "package.json");
  const serverPath = path.join(REPO_ROOT, "packages", "server", "package.json");
  const owpenbotPath = path.join(REPO_ROOT, "packages", "owpenbot", "package.json");
  const uiData = await readJson(uiPath);
  const tauriData = await readJson(tauriPath);
  const headlessData = await readJson(headlessPath);
  const serverData = await readJson(serverPath);
  const owpenbotData = await readJson(owpenbotPath);
  uiData.version = nextVersion;
  tauriData.version = nextVersion;
  // Desktop pins owpenbotVersion for sidecar bundling; keep it aligned.
  tauriData.owpenbotVersion = nextVersion;
  headlessData.version = nextVersion;

  // Ensure openwrk uses the same openwork-server/owpenwork versions.
  headlessData.dependencies = headlessData.dependencies ?? {};
  headlessData.dependencies["openwork-server"] = nextVersion;
  headlessData.dependencies.owpenwork = nextVersion;

  serverData.version = nextVersion;
  owpenbotData.version = nextVersion;
  if (!isDryRun) {
    await writeFile(uiPath, JSON.stringify(uiData, null, 2) + "\n");
    await writeFile(tauriPath, JSON.stringify(tauriData, null, 2) + "\n");
    await writeFile(headlessPath, JSON.stringify(headlessData, null, 2) + "\n");
    await writeFile(serverPath, JSON.stringify(serverData, null, 2) + "\n");
    await writeFile(owpenbotPath, JSON.stringify(owpenbotData, null, 2) + "\n");
  }
};

const updateCargoToml = async (nextVersion) => {
  const filePath = path.join(REPO_ROOT, "packages", "desktop", "src-tauri", "Cargo.toml");
  const raw = await readFile(filePath, "utf8");
  const updated = raw.replace(/\bversion\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
  if (!isDryRun) {
    await writeFile(filePath, updated);
    // Regenerate Cargo.lock so it stays in sync with the version bump.
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("cargo", ["generate-lockfile"], {
        cwd: path.join(REPO_ROOT, "packages", "desktop", "src-tauri"),
        stdio: "ignore",
      });
    } catch {
      // cargo may not be installed (e.g. CI without Rust); skip silently.
    }
  }
};

const updateTauriConfig = async (nextVersion) => {
  const filePath = path.join(REPO_ROOT, "packages", "desktop", "src-tauri", "tauri.conf.json");
  const data = JSON.parse(await readFile(filePath, "utf8"));
  data.version = nextVersion;
  if (!isDryRun) {
    await writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
  }
};

const main = async () => {
  if (explicit && !semverPattern.test(explicit)) {
    throw new Error(`Invalid explicit version: ${explicit}`);
  }
  if (explicit === null && !["patch", "minor", "major"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const nextVersion = await targetVersion();
  await updatePackageJson(nextVersion);
  await updateCargoToml(nextVersion);
  await updateTauriConfig(nextVersion);

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: nextVersion,
        dryRun: isDryRun,
        files: [
          "packages/app/package.json",
          "packages/desktop/package.json",
          "packages/headless/package.json",
          "packages/server/package.json",
          "packages/owpenbot/package.json",
          "packages/desktop/src-tauri/Cargo.toml",
          "packages/desktop/src-tauri/tauri.conf.json",
        ],
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
