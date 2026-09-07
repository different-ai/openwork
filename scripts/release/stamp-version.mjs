#!/usr/bin/env node
/**
 * Stamps a release version into the workspace package.json files at build
 * time. The repo permanently commits the "0.0.0-dev" placeholder; the release
 * and alpha workflows call this right before building so electron-builder,
 * the Vite renderer bundle, and the openwork-server npm package all carry the
 * version derived from the git tag. Nothing here is ever committed.
 *
 * Usage: node scripts/release/stamp-version.mjs --version X.Y.Z[-prerelease+build]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const STAMPED_PACKAGE_PATHS = [
  "apps/app/package.json",
  "apps/coworker/package.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
];

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function normalizeStampVersion(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const version = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version to stamp: ${raw || "(empty)"} (expected X.Y.Z with optional prerelease/build suffix)`);
  }
  return version;
}

export function stampVersion(version, rootDir = root) {
  const normalized = normalizeStampVersion(version);
  for (const relativePath of STAMPED_PACKAGE_PATHS) {
    const packagePath = resolve(rootDir, relativePath);
    const json = JSON.parse(readFileSync(packagePath, "utf8"));
    json.version = normalized;
    writeFileSync(packagePath, `${JSON.stringify(json, null, 2)}\n`);
  }
  return { version: normalized, files: STAMPED_PACKAGE_PATHS };
}

function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const raw = versionIndex >= 0 ? args[versionIndex + 1] : null;
  if (!raw) throw new Error("Usage: stamp-version.mjs --version X.Y.Z");
  const result = stampVersion(raw);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
