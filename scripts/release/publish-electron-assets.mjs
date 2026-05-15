#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const manifestsOnly = args.includes("--manifests-only");
const positional = args.filter((arg) => arg !== "--manifests-only");
const [distRootArg, releaseTag] = positional;

if (!distRootArg || !releaseTag) {
  console.error("Usage: node scripts/release/publish-electron-assets.mjs [--manifests-only] <dist-root> <release-tag>");
  process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error("GITHUB_REPOSITORY is required.");
  process.exit(2);
}

const distRoot = resolve(distRootArg);
const outputDir = resolve(process.env.RUNNER_TEMP || ".", "openwork-electron-manifests");
mkdirSync(outputDir, { recursive: true });

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

function isUpdaterManifest(path) {
  return /^latest.*\.ya?ml$/.test(basename(path));
}

function isReleaseAsset(path) {
  if (isUpdaterManifest(path)) return false;
  if (!basename(path).startsWith("openwork-")) return false;
  return /\.(AppImage|blockmap|dmg|exe|rpm|zip)$/i.test(path) || /\.tar\.gz$/i.test(path);
}

function runGh(args) {
  const result = spawnSync("gh", args, { stdio: "inherit", encoding: "utf8" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseManifest(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = { files: [] };
  let currentFile = null;

  for (const line of raw.split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (topLevel) {
      const [, key, value] = topLevel;
      if (key !== "files") parsed[key] = unquoteYamlScalar(value);
      currentFile = null;
      continue;
    }

    const fileStart = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (fileStart) {
      const [, key, value] = fileStart;
      currentFile = {};
      currentFile[key] = parseYamlScalar(value);
      parsed.files.push(currentFile);
      continue;
    }

    const fileProp = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (fileProp && currentFile) {
      const [, key, value] = fileProp;
      currentFile[key] = parseYamlScalar(value);
    }
  }

  if (!parsed.version) throw new Error(`Missing version in ${path}`);
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`Missing files in ${path}`);
  }
  return parsed;
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseYamlScalar(value) {
  const unquoted = unquoteYamlScalar(value);
  if (/^\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function quoteYamlScalar(value) {
  const string = String(value ?? "");
  if (!string || /[:#\[\]{}&,*!|>'"%@`\s]/.test(string)) {
    return `'${string.replace(/'/g, "''")}'`;
  }
  return string;
}

function stringifyManifest(manifest) {
  const lines = [`version: ${quoteYamlScalar(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    lines.push(`  - url: ${quoteYamlScalar(file.url)}`);
    for (const [key, value] of Object.entries(file)) {
      if (key === "url") continue;
      lines.push(`    ${key}: ${typeof value === "number" ? value : quoteYamlScalar(value)}`);
    }
  }
  if (manifest.releaseDate) lines.push(`releaseDate: ${quoteYamlScalar(manifest.releaseDate)}`);
  return `${lines.join("\n")}\n`;
}

function sortFiles(files) {
  const rank = (url) => {
    const value = String(url || "");
    if (value.includes("arm64")) return 0;
    if (value.includes("x64") || value.includes("x86_64")) return 1;
    return 2;
  };
  return [...files].sort((left, right) => {
    const byRank = rank(left.url) - rank(right.url);
    if (byRank !== 0) return byRank;
    const leftExt = extname(String(left.url || ""));
    const rightExt = extname(String(right.url || ""));
    if (leftExt === ".zip" && rightExt !== ".zip") return -1;
    if (rightExt === ".zip" && leftExt !== ".zip") return 1;
    return String(left.url || "").localeCompare(String(right.url || ""));
  });
}

function mergeManifests(name, paths) {
  const manifests = paths.map(parseManifest);
  const version = manifests[0].version;
  for (const manifest of manifests) {
    if (manifest.version !== version) {
      throw new Error(`${name} has mixed versions: ${version} and ${manifest.version}`);
    }
  }

  const filesByUrl = new Map();
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      if (!file?.url) throw new Error(`${name} contains a file entry without url.`);
      filesByUrl.set(file.url, file);
    }
  }

  const releaseDates = manifests.map((manifest) => manifest.releaseDate).filter(Boolean).sort();
  const merged = {
    version,
    files: sortFiles([...filesByUrl.values()]),
  };
  if (releaseDates.length) merged.releaseDate = releaseDates[releaseDates.length - 1];
  return merged;
}

function validateManifest(name, manifest) {
  const urls = manifest.files.map((file) => String(file.url || ""));
  if (name === "latest-mac.yml") {
    for (const arch of ["mac-arm64", "mac-x64"]) {
      if (!urls.some((url) => url.includes(arch))) {
        throw new Error(`${name} is missing ${arch} artifacts.`);
      }
    }
  }
  if (name === "latest-linux.yml" && urls.some((url) => url.includes("arm64"))) {
    throw new Error(`${name} should remain the Linux x64 feed; arm64 belongs in latest-linux-arm64.yml.`);
  }
  if (name === "latest-linux-arm64.yml" && !urls.some((url) => url.includes("arm64"))) {
    throw new Error(`${name} is missing Linux arm64 artifacts.`);
  }
}

const files = walk(distRoot);
const releaseAssets = files.filter(isReleaseAsset);
const manifestsByName = new Map();

for (const path of files.filter(isUpdaterManifest)) {
  const name = basename(path);
  const current = manifestsByName.get(name) || [];
  current.push(path);
  manifestsByName.set(name, current);
}

if (!manifestsOnly && releaseAssets.length === 0) {
  console.error(`No Electron release assets found under ${distRoot}`);
  process.exit(1);
}

if (manifestsByName.size === 0) {
  console.error(`No Electron updater manifests found under ${distRoot}`);
  process.exit(1);
}

if (!manifestsOnly) {
  runGh(["release", "upload", releaseTag, ...releaseAssets, "--repo", repo, "--clobber"]);
}

for (const [name, paths] of [...manifestsByName.entries()].sort()) {
  const manifest = mergeManifests(name, paths);
  validateManifest(name, manifest);
  const outputPath = join(outputDir, name);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stringifyManifest(manifest), "utf8");
  runGh(["release", "upload", releaseTag, `${outputPath}#${name}`, "--repo", repo, "--clobber"]);
}
