#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stagingTagPattern =
  /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))-staging\.(0|[1-9]\d*)$/;
const desktopPackagePaths = [
  "apps/app/package.json",
  "apps/desktop/package.json",
];

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function readDesktopPackages(root) {
  return desktopPackagePaths.map((relativePath) => {
    const path = resolve(root, relativePath);
    return {
      path,
      relativePath,
      value: JSON.parse(readFileSync(path, "utf8")),
    };
  });
}

export function parseStagingTag(value) {
  const tag = String(value ?? "").trim();
  const match = tag.match(stagingTagPattern);
  if (!match) {
    throw new Error(
      `Invalid staging tag: ${tag || "(empty)"} (expected vX.Y.Z-staging.N)`,
    );
  }

  return {
    tag,
    version: `${match[1]}-staging.${match[5]}`,
    baseVersion: match[1],
    sequence: match[5],
  };
}

export function resolveStagingVersion({ root = repoRoot, tag }) {
  const resolved = parseStagingTag(tag);
  const packages = readDesktopPackages(root);
  const sourceVersions = [...new Set(packages.map((entry) => entry.value.version))];

  if (
    sourceVersions.length !== 1 ||
    !stableVersionPattern.test(sourceVersions[0] ?? "")
  ) {
    const details = packages
      .map((entry) => `${entry.relativePath}=${entry.value.version ?? "(missing)"}`)
      .join(", ");
    throw new Error(`Desktop source versions must match and be stable: ${details}`);
  }

  const sourceVersion = sourceVersions[0];
  if (compareStableVersions(resolved.baseVersion, sourceVersion) <= 0) {
    throw new Error(
      `Staging base version ${resolved.baseVersion} must be newer than source version ${sourceVersion}`,
    );
  }

  return { ...resolved, sourceVersion };
}

export function applyStagingVersion({ root = repoRoot, tag }) {
  const resolved = resolveStagingVersion({ root, tag });
  const packages = readDesktopPackages(root);

  for (const entry of packages) {
    entry.value.version = resolved.version;
    writeFileSync(entry.path, `${JSON.stringify(entry.value, null, 2)}\n`, "utf8");
  }

  return {
    ...resolved,
    files: packages.map((entry) => entry.relativePath),
  };
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : null;
}

function writeGitHubOutput(path, result) {
  appendFileSync(
    path,
    [
      `tag=${result.tag}`,
      `version=${result.version}`,
      `base_version=${result.baseVersion}`,
      `sequence=${result.sequence}`,
      `source_version=${result.sourceVersion}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function main() {
  const args = process.argv.slice(2);
  const tag = optionValue(args, "--tag") ?? process.env.STAGING_TAG;
  const outputPath = optionValue(args, "--github-output");
  const result = args.includes("--write")
    ? applyStagingVersion({ tag })
    : resolveStagingVersion({ tag });

  if (outputPath) writeGitHubOutput(outputPath, result);
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
