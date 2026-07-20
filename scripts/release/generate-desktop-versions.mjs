#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const MIN_SUPPORTED_DESKTOP_VERSION = "0.17.0";
export const GENERATED_DESKTOP_VERSIONS_PATH = resolve(
  root,
  "ee/apps/den-api/src/generated/desktop-versions.ts",
);

function parseStableVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function buildPublishedDesktopVersions({ tags, currentVersion }) {
  if (!parseStableVersion(currentVersion)) {
    throw new Error(`Invalid current desktop version: ${currentVersion}`);
  }

  const versions = tags.flatMap((tag) => {
    const trimmed = tag.trim();
    if (!trimmed.startsWith("v")) return [];
    const version = trimmed.slice(1);
    return parseStableVersion(version) ? [version] : [];
  });
  versions.push(currentVersion);

  return [...new Set(versions)]
    .filter(
      (version) =>
        compareStableVersions(version, MIN_SUPPORTED_DESKTOP_VERSION) >= 0 &&
        compareStableVersions(version, currentVersion) <= 0,
    )
    .sort((left, right) => compareStableVersions(right, left));
}

export function renderDesktopVersionsFile(versions) {
  return [
    `export const MIN_SUPPORTED_DESKTOP_VERSION = ${JSON.stringify(MIN_SUPPORTED_DESKTOP_VERSION)} as const;`,
    "",
    "export const PUBLISHED_DESKTOP_VERSIONS = [",
    ...versions.map(
      (version, index) =>
        `  ${JSON.stringify(version)}${index < versions.length - 1 ? "," : ""}`,
    ),
    "] as const;",
    "",
  ].join("\n");
}

export function readGeneratedDesktopVersions(filePath = GENERATED_DESKTOP_VERSIONS_PATH) {
  const source = readFileSync(filePath, "utf8");
  const match = source.match(/PUBLISHED_DESKTOP_VERSIONS\s*=\s*(\[[\s\S]*?\])\s*as const/);
  if (!match) {
    throw new Error(`Published desktop versions missing from ${filePath}`);
  }
  const versions = [...match[1].matchAll(/"(\d+\.\d+\.\d+)"/g)].map(
    (versionMatch) => versionMatch[1],
  );
  if (versions.length === 0) {
    throw new Error(`Published desktop versions are invalid in ${filePath}`);
  }
  return versions;
}

function readCurrentVersion() {
  const packageJson = JSON.parse(readFileSync(resolve(root, "apps/app/package.json"), "utf8"));
  return packageJson.version;
}

function readStableTags() {
  return execFileSync("git", ["tag", "--list", "v*"], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
}

function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const currentVersion = versionIndex >= 0 ? args[versionIndex + 1] : readCurrentVersion();
  const dryRun = args.includes("--dry-run");
  const existingVersions = existsSync(GENERATED_DESKTOP_VERSIONS_PATH)
    ? readGeneratedDesktopVersions()
    : [];
  const versions = buildPublishedDesktopVersions({
    tags: [
      ...readStableTags(),
      ...existingVersions.map((version) => `v${version}`),
    ],
    currentVersion,
  });
  const output = renderDesktopVersionsFile(versions);

  if (!dryRun) {
    writeFileSync(GENERATED_DESKTOP_VERSIONS_PATH, output);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    currentVersion,
    minimumVersion: MIN_SUPPORTED_DESKTOP_VERSION,
    versions,
    file: "ee/apps/den-api/src/generated/desktop-versions.ts",
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
