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
const filtered = args.filter((arg) => arg !== "--dry-run");

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
  const tauriPath = path.join(REPO_ROOT, "packages", "tauri", "package.json");
  const uiData = await readJson(uiPath);
  const tauriData = await readJson(tauriPath);
  uiData.version = nextVersion;
  tauriData.version = nextVersion;
  if (!isDryRun) {
    await writeFile(uiPath, JSON.stringify(uiData, null, 2) + "\n");
    await writeFile(tauriPath, JSON.stringify(tauriData, null, 2) + "\n");
  }
};

const updateCargoToml = async (nextVersion) => {
  const filePath = path.join(REPO_ROOT, "packages", "tauri", "src-tauri", "Cargo.toml");
  const raw = await readFile(filePath, "utf8");
  const updated = raw.replace(/\bversion\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
  if (!isDryRun) {
    await writeFile(filePath, updated);
  }
};

const updateTauriConfig = async (nextVersion) => {
  const filePath = path.join(REPO_ROOT, "packages", "tauri", "src-tauri", "tauri.conf.json");
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
          "apps/desktop/package.json",
          "packages/tauri/package.json",
          "packages/tauri/src-tauri/Cargo.toml",
          "packages/tauri/src-tauri/tauri.conf.json",
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
