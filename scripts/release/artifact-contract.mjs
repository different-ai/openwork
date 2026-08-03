#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ALLOWED_ASSET = /\.(?:AppImage|blockmap|dmg|exe|rpm|zip)$/i;

const distributions = [
  { key: "public", id: "", prefix: "openwork", channel: "latest" },
  { key: "cloud", id: "-cloud", prefix: "openwork-cloud", channel: "cloud" },
  { key: "enterprise", id: "-enterprise", prefix: "openwork-enterprise", channel: "enterprise" },
];
const platforms = [
  { id: "macos-arm64", os: "mac", arch: "arm64", extensions: ["dmg", "zip"], manifest: "latest-mac.yml" },
  { id: "macos-x64", os: "mac", arch: "x64", extensions: ["dmg", "zip"], manifest: "latest-mac.yml" },
  { id: "linux-x64", os: "linux", arch: "x64", extensions: ["AppImage", "tar.gz"], manifest: "latest-linux.yml" },
  { id: "linux-arm64", os: "linux", arch: "arm64", extensions: ["AppImage", "tar.gz"], manifest: "latest-linux-arm64.yml" },
  { id: "windows-x64", os: "win", arch: "x64", extensions: ["exe"], manifest: "latest.yml" },
  { id: "windows-arm64", os: "win", arch: "arm64", extensions: ["exe"], manifest: "latest.yml" },
];

export const RELEASE_STAGES = distributions.flatMap((distribution) =>
  platforms.map((platform) => ({
    distribution: distribution.key,
    prefix: distribution.prefix,
    channel: distribution.channel,
    ...platform,
    id: `electron${distribution.id}-${platform.id}`,
    manifest: platform.manifest.replace(/^latest/, distribution.channel),
  })),
);

export const EXPECTED_MERGED_MANIFESTS = [...new Set(RELEASE_STAGES.map((stage) => stage.manifest))].sort();

export function matrixArtifactNames(runAttempt) {
  requireNumeric(runAttempt, "run attempt");
  return RELEASE_STAGES.map((stage) => `release-desktop-${stage.id}-attempt-${runAttempt}`).sort();
}

export function mergedManifestArtifactName(runAttempt) {
  requireNumeric(runAttempt, "run attempt");
  return `release-desktop-manifests-attempt-${runAttempt}`;
}

export function artifactIndexArtifactName(runAttempt) {
  requireNumeric(runAttempt, "run attempt");
  return `release-artifact-index-attempt-${runAttempt}`;
}

function requireNumeric(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be numeric.`);
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function stageFor(id) {
  const stage = RELEASE_STAGES.find((candidate) => candidate.id === id);
  if (!stage) throw new Error(`Unexpected desktop stage: ${id}`);
  return stage;
}

function expectedAssetNames(stage, version) {
  const base = `${stage.prefix}-${stage.os}-${stage.arch}-${version}`;
  return stage.extensions.map((extension) => `${base}.${extension}`);
}

function validateAssetName(stage, name) {
  const isTar = name.endsWith(".tar.gz");
  if (!isTar && !ALLOWED_ASSET.test(name)) throw new Error(`Unexpected release file: ${name}`);
  if (!name.startsWith(`${stage.prefix}-`)) throw new Error(`${stage.id} contains foreign asset ${name}.`);
  if (stage.distribution === "public" && /^openwork-(?:cloud|enterprise)-/.test(name)) {
    throw new Error(`${stage.id} contains non-public asset ${name}.`);
  }
}

export function createStageMetadata({ directory, stageId, version, sourceSha, runId, runAttempt, artifactName }) {
  const stage = stageFor(stageId);
  if (!VERSION.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (!SHA.test(sourceSha)) throw new Error(`Invalid build source SHA: ${sourceSha}`);
  requireNumeric(runId, "run ID");
  requireNumeric(runAttempt, "run attempt");
  const expectedArtifactName = `release-desktop-${stage.id}-attempt-${runAttempt}`;
  if (artifactName !== expectedArtifactName) {
    throw new Error(`${stage.id} artifact must be ${expectedArtifactName}, got ${artifactName}.`);
  }

  const assetsDirectory = join(directory, "assets");
  const manifestsDirectory = join(directory, "manifests");
  const expectedEntries = existsSync(join(directory, "stage.json"))
    ? ["assets", "manifests", "stage.json"]
    : ["assets", "manifests"];
  const entries = readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`${stage.id} contains unexpected staging entries: ${entries.join(", ")}`);
  }
  const assetPaths = filesUnder(assetsDirectory);
  const manifestPaths = filesUnder(manifestsDirectory);
  for (const path of assetPaths) {
    if (relative(assetsDirectory, path) !== basename(path)) throw new Error(`${stage.id} contains nested asset staging data.`);
  }
  for (const path of manifestPaths) {
    if (relative(manifestsDirectory, path) !== basename(path)) throw new Error(`${stage.id} contains nested manifest staging data.`);
  }
  const assetNames = assetPaths.map((path) => basename(path)).sort();
  const manifestNames = manifestPaths.map((path) => basename(path)).sort();
  if (new Set(assetNames).size !== assetNames.length) throw new Error(`${stage.id} has duplicate asset names.`);
  if (manifestNames.length !== 1 || manifestNames[0] !== stage.manifest) {
    throw new Error(`${stage.id} must contain only updater manifest ${stage.manifest}.`);
  }
  for (const name of assetNames) validateAssetName(stage, name);
  for (const name of expectedAssetNames(stage, version)) {
    if (!assetNames.includes(name)) throw new Error(`${stage.id} is missing required asset ${name}.`);
  }

  const files = [...assetPaths, ...manifestPaths].map((path) => ({
    path: relative(directory, path).replaceAll("\\", "/"),
    name: basename(path),
    sha256: hash(path),
    size: statSync(path).size,
  })).sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: 1,
    stageId,
    artifactName,
    version,
    sourceSha,
    runId: String(runId),
    runAttempt: String(runAttempt),
    files,
  };
}

function validateStageDirectory(directory, expected) {
  const metadataPath = join(directory, "stage.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const rebuilt = createStageMetadata({
    directory,
    stageId: metadata.stageId,
    version: expected.version,
    sourceSha: expected.sourceSha,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    artifactName: basename(directory),
  });
  if (JSON.stringify(metadata) !== JSON.stringify(rebuilt)) {
    throw new Error(`${basename(directory)} stage metadata or bytes do not match.`);
  }
  return rebuilt;
}

function readMergedManifests(directory, version, assetNames) {
  const paths = filesUnder(directory);
  const names = paths.map((path) => basename(path)).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_MERGED_MANIFESTS)) {
    throw new Error(`Merged updater manifests are incomplete or unexpected: ${names.join(", ")}`);
  }
  return paths.map((path) => {
    const manifest = parseYaml(readFileSync(path, "utf8"));
    if (manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error(`${basename(path)} has invalid version or files.`);
    }
    for (const file of manifest.files) {
      if (!file || typeof file.url !== "string" || !assetNames.has(file.url)) {
        throw new Error(`${basename(path)} references missing staged asset ${file?.url ?? "?"}.`);
      }
    }
    return {
      name: basename(path),
      sha256: hash(path),
      size: statSync(path).size,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function buildArtifactIndex({ root, manifestsDirectory, version, sourceSha, runId, runAttempt }) {
  if (!VERSION.test(version) || !SHA.test(sourceSha)) throw new Error("Invalid artifact index release identity.");
  requireNumeric(runId, "run ID");
  requireNumeric(runAttempt, "run attempt");
  const expectedNames = matrixArtifactNames(runAttempt);
  const rootEntries = readdirSync(root);
  if (rootEntries.some((entry) => !statSync(join(root, entry)).isDirectory())) {
    throw new Error("Desktop stage root contains unexpected files.");
  }
  const relativeManifests = relative(root, manifestsDirectory).replaceAll("\\", "/");
  const allowedExtra = relativeManifests.startsWith("../") ? "" : relativeManifests.split("/")[0];
  const unexpectedDirectories = rootEntries.filter((entry) =>
    !entry.startsWith("release-desktop-electron-") && entry !== allowedExtra);
  if (unexpectedDirectories.length > 0) {
    throw new Error(`Desktop stage root contains unexpected directories: ${unexpectedDirectories.join(", ")}`);
  }
  const directories = rootEntries.filter((entry) => entry.startsWith("release-desktop-electron-")).sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedNames)) {
    throw new Error(`Desktop stage set is incomplete or unexpected: ${directories.join(", ")}`);
  }
  const expected = { version, sourceSha, runId: String(runId), runAttempt: String(runAttempt) };
  const stages = directories.map((name) => validateStageDirectory(join(root, name), expected));
  const assets = new Map();
  for (const stage of stages) {
    for (const file of stage.files.filter((candidate) => candidate.path.startsWith("assets/"))) {
      if (assets.has(file.name)) throw new Error(`Duplicate staged publication asset: ${file.name}`);
      assets.set(file.name, { name: file.name, sha256: file.sha256, size: file.size });
    }
  }
  const mergedManifests = readMergedManifests(manifestsDirectory, version, new Set(assets.keys()));
  return {
    schema: 1,
    version,
    sourceSha,
    runId: String(runId),
    runAttempt: String(runAttempt),
    stages,
    publicationFiles: [...assets.values(), ...mergedManifests]
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function validateArtifactIndex(index) {
  if (index.schema !== 1 || !VERSION.test(index.version) || !SHA.test(index.sourceSha)) {
    throw new Error("Invalid artifact index identity.");
  }
  requireNumeric(index.runId, "artifact index run ID");
  requireNumeric(index.runAttempt, "artifact index run attempt");
  if (!Array.isArray(index.stages) || index.stages.length !== RELEASE_STAGES.length) {
    throw new Error(`Artifact index must contain exactly ${RELEASE_STAGES.length} stages.`);
  }
  const names = index.stages.map((stage) => stage.artifactName).sort();
  if (JSON.stringify(names) !== JSON.stringify(matrixArtifactNames(index.runAttempt))) {
    throw new Error("Artifact index stage names do not match the recorded attempt.");
  }
  for (const stage of index.stages) {
    if (stage.sourceSha !== index.sourceSha || stage.runId !== index.runId || stage.runAttempt !== index.runAttempt) {
      throw new Error(`Mixed source or attempt in ${stage.artifactName}.`);
    }
  }
  const publicationNames = index.publicationFiles.map((file) => file.name);
  if (new Set(publicationNames).size !== publicationNames.length
    || index.publicationFiles.some((file) => !SHA256.test(file.sha256))) {
    throw new Error("Artifact index publication files are duplicate or invalid.");
  }
  return index;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === "stage") {
    const directory = resolve(flag("--directory"));
    const metadata = createStageMetadata({
      directory,
      stageId: flag("--stage-id"),
      version: flag("--version"),
      sourceSha: flag("--source-sha"),
      runId: flag("--run-id"),
      runAttempt: flag("--run-attempt"),
      artifactName: flag("--artifact-name"),
    });
    writeJson(join(directory, "stage.json"), metadata);
  } else if (command === "index") {
    const index = buildArtifactIndex({
      root: resolve(flag("--root")),
      manifestsDirectory: resolve(flag("--manifests")),
      version: flag("--version"),
      sourceSha: flag("--source-sha"),
      runId: flag("--run-id"),
      runAttempt: flag("--run-attempt"),
    });
    validateArtifactIndex(index);
    writeJson(resolve(flag("--output")), index);
  } else {
    throw new Error("Usage: artifact-contract.mjs stage|index [options]");
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
