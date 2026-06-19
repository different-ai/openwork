#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [signedArtifactDirArg, distDirArg] = process.argv.slice(2);

if (!signedArtifactDirArg || !distDirArg) {
  console.error("Usage: node scripts/release/apply-signpath-windows-artifact.mjs <signed-artifact-dir> <dist-dir>");
  process.exit(2);
}

const signedArtifactDir = resolve(signedArtifactDirArg);
const distDir = resolve(distDirArg);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const YAML = desktopRequire("yaml");

function walk(dir) {
  const entries = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
    else if (stat.isFile()) entries.push(path);
  }
  return entries;
}

function findOne(paths, description) {
  if (paths.length !== 1) {
    console.error(`Expected exactly one ${description}, found ${paths.length}.`);
    for (const path of paths) console.error(`- ${path}`);
    process.exit(1);
  }
  return paths[0];
}

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function findAppBuilderPath() {
  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) {
    throw new Error(`Cannot find pnpm store directory: ${pnpmDir}`);
  }

  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith("app-builder-bin@")) continue;
    const appBuilderPackage = join(pnpmDir, entry, "node_modules", "app-builder-bin", "index.js");
    if (!existsSync(appBuilderPackage)) continue;
    const appBuilderRequire = createRequire(appBuilderPackage);
    const { appBuilderPath } = appBuilderRequire(appBuilderPackage);
    return appBuilderPath;
  }

  throw new Error("Cannot find app-builder-bin. Run pnpm install before applying the signed Windows artifact.");
}

function regenerateBlockmap(installerPath) {
  const blockmapPath = `${installerPath}.blockmap`;
  mkdirSync(dirname(blockmapPath), { recursive: true });

  const result = spawnSync(findAppBuilderPath(), ["blockmap", "--input", installerPath, "--output", blockmapPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`app-builder blockmap failed with status ${result.status}`);
  }
  if (!existsSync(blockmapPath)) {
    throw new Error(`app-builder did not create ${blockmapPath}`);
  }
}

function updateLatestYml(installerPath) {
  const latestPath = join(distDir, "latest.yml");
  if (!existsSync(latestPath)) {
    throw new Error(`Missing Windows updater manifest: ${latestPath}`);
  }

  const installerName = basename(installerPath);
  const installerSha512 = sha512(installerPath);
  const installerSize = statSync(installerPath).size;
  const manifest = YAML.parse(readFileSync(latestPath, "utf8"));

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid Windows updater manifest: ${latestPath}`);
  }

  let matchedFile = false;
  manifest.files = manifest.files.map((file) => {
    if (!file || file.url !== installerName) return file;
    matchedFile = true;
    return {
      ...file,
      sha512: installerSha512,
      size: installerSize,
    };
  });

  if (!matchedFile) {
    throw new Error(`Manifest ${latestPath} does not reference signed installer ${installerName}`);
  }

  manifest.path = installerName;
  manifest.sha512 = installerSha512;
  writeFileSync(latestPath, YAML.stringify(manifest), "utf8");
}

if (!existsSync(signedArtifactDir)) {
  console.error(`Signed artifact directory does not exist: ${signedArtifactDir}`);
  process.exit(1);
}
if (!existsSync(distDir)) {
  console.error(`Electron dist directory does not exist: ${distDir}`);
  process.exit(1);
}

const signedInstaller = findOne(
  walk(signedArtifactDir).filter((file) => /^openwork-win-x64-.+\.exe$/i.test(basename(file))),
  "signed Windows installer from SignPath",
);
const distInstaller = findOne(
  walk(distDir).filter((file) => basename(file) === basename(signedInstaller)),
  "matching unsigned Windows installer in dist-electron",
);

copyFileSync(signedInstaller, distInstaller);
regenerateBlockmap(distInstaller);
updateLatestYml(distInstaller);

console.log(`Applied signed Windows installer: ${distInstaller}`);
