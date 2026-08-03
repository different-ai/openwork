#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function collectStagedAssets(root) {
  const selected = walk(root).filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    return normalized.includes("/assets/")
      || (/\/release-desktop-manifests-attempt-\d+\//.test(normalized)
        && /\.(?:yml|yaml)$/.test(path));
  });
  const assets = new Map();
  for (const path of selected) {
    const name = basename(path);
    if (assets.has(name)) throw new Error(`Duplicate staged release asset: ${name}`);
    assets.set(name, { name, path, sha256: sha256(path) });
  }
  if (assets.size === 0) throw new Error(`No staged desktop assets found under ${root}.`);
  return [...assets.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function planImmutablePublication(stagedAssets, existingAssets) {
  return stagedAssets.map((asset) => {
    const existing = existingAssets.get(asset.name);
    if (!existing) return { ...asset, action: "upload" };
    if (existing.sha256 !== asset.sha256) {
      throw new Error(`Published asset ${asset.name} differs from staged SHA-256 ${asset.sha256}.`);
    }
    return { ...asset, action: "keep" };
  });
}

function runGh(argumentsList, options = {}) {
  const result = spawnSync("gh", argumentsList, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`gh ${argumentsList.join(" ")} failed with exit code ${result.status}`);
  }
  return result.stdout?.trim() ?? "";
}

function readExistingAssets(tag, repository, destination) {
  const release = JSON.parse(runGh([
    "api", `repos/${repository}/releases/tags/${tag}`,
  ], { capture: true }));
  const existing = new Map();
  for (const asset of release.assets) {
    const name = asset.name;
    if (asset.digest?.startsWith("sha256:")) {
      existing.set(name, { name, sha256: asset.digest.slice("sha256:".length) });
      continue;
    }
    const assetDirectory = join(destination, name.replace(/[^A-Za-z0-9._-]/g, "_"));
    mkdirSync(assetDirectory, { recursive: true });
    runGh(["release", "download", tag, "--repo", repository, "--pattern", name, "--dir", assetDirectory]);
    const path = join(assetDirectory, name);
    if (!existsSync(path)) throw new Error(`Could not download existing release asset ${name}.`);
    existing.set(name, { name, sha256: sha256(path) });
  }
  return existing;
}

function main() {
  const [rootArg, tag] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!rootArg || !tag || !repository) {
    throw new Error("Usage: staged-assets.mjs <artifact-root> <tag> (GITHUB_REPOSITORY required)");
  }
  const root = resolve(rootArg);
  const staged = collectStagedAssets(root);
  const publicLinuxAssets = [
    `openwork-linux-x64-${tag.slice(1)}.tar.gz`,
    `openwork-linux-arm64-${tag.slice(1)}.tar.gz`,
  ];
  for (const name of publicLinuxAssets) {
    if (!staged.some((asset) => asset.name === name)) {
      throw new Error(`Required staged AUR asset is missing: ${name}`);
    }
  }

  const downloadRoot = resolve(process.env.RUNNER_TEMP ?? ".", "existing-release-assets");
  mkdirSync(downloadRoot, { recursive: true });
  const plan = planImmutablePublication(staged, readExistingAssets(tag, repository, downloadRoot));
  for (const item of plan) {
    if (item.action === "upload") {
      const uploadPath = resolve(process.env.RUNNER_TEMP ?? ".", "release-upload", item.name);
      mkdirSync(resolve(uploadPath, ".."), { recursive: true });
      cpSync(item.path, uploadPath);
      runGh(["release", "upload", tag, `${uploadPath}#${item.name}`, "--repo", repository]);
    }
    console.log(`${item.action}\t${item.sha256}\t${item.name}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
