#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  artifactIndexArtifactName,
  matrixArtifactNames,
  mergedManifestArtifactName,
  validateArtifactIndex,
} from "./artifact-contract.mjs";

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unexpected or missing fields.`);
}

function numeric(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be numeric.`);
  return String(value);
}

export function releaseMetadataDirectory(tag) {
  return `.github/releases/${tag}`;
}

export function releaseMetadataPath(tag) {
  return `${releaseMetadataDirectory(tag)}/release.json`;
}

export function releaseArtifactIndexPath(tag) {
  return `${releaseMetadataDirectory(tag)}/artifacts.json`;
}

export function encodeReleaseBody(body) {
  return Buffer.from(body, "utf8").toString("base64");
}

export function decodeReleaseBody(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Release body is not valid base64.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) throw new Error("Release body base64 is not canonical.");
  return decoded.toString("utf8");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateReleaseMetadata(metadata, expected = {}) {
  exactKeys(metadata, ["schema", "version", "tag", "branch", "prepareRunId", "prepareRunAttempt", "buildSourceSha", "release", "artifacts"], "Release metadata");
  if (metadata.schema !== 1 || !VERSION.test(metadata.version)) throw new Error("Invalid release metadata schema or version.");
  if (metadata.tag !== `v${metadata.version}` || metadata.branch !== `release/${metadata.tag}`) {
    throw new Error("Release metadata tag and branch do not match its version.");
  }
  if (!SHA.test(metadata.buildSourceSha)) throw new Error("Release metadata build source SHA is invalid.");
  metadata.prepareRunId = numeric(metadata.prepareRunId, "prepare run ID");
  metadata.prepareRunAttempt = numeric(metadata.prepareRunAttempt, "prepare run attempt");

  exactKeys(metadata.release, ["name", "bodyBase64", "prerelease", "notarize", "signWindows", "publishServer", "publishSnapshot"], "Release options");
  if (typeof metadata.release.name !== "string" || metadata.release.name.length === 0 || /[\r\n]/.test(metadata.release.name)) {
    throw new Error("Release name must be a non-empty single line.");
  }
  decodeReleaseBody(metadata.release.bodyBase64);
  for (const field of ["prerelease", "notarize", "signWindows", "publishServer", "publishSnapshot"]) {
    if (typeof metadata.release[field] !== "boolean") throw new Error(`Release option ${field} must be boolean.`);
  }

  exactKeys(metadata.artifacts, ["indexPath", "indexArtifactName", "indexSha256", "mergedManifestsArtifactName", "matrixArtifactNames"], "Artifact identity");
  if (metadata.artifacts.indexPath !== releaseArtifactIndexPath(metadata.tag)
    || metadata.artifacts.indexArtifactName !== artifactIndexArtifactName(metadata.prepareRunAttempt)
    || metadata.artifacts.mergedManifestsArtifactName !== mergedManifestArtifactName(metadata.prepareRunAttempt)
    || !SHA256.test(metadata.artifacts.indexSha256)
    || JSON.stringify(metadata.artifacts.matrixArtifactNames) !== JSON.stringify(matrixArtifactNames(metadata.prepareRunAttempt))) {
    throw new Error("Release artifact identity is invalid.");
  }
  if (expected.tag && metadata.tag !== expected.tag) throw new Error(`Metadata tag ${metadata.tag} does not match ${expected.tag}.`);
  if (expected.branch && metadata.branch !== expected.branch) throw new Error(`Metadata branch ${metadata.branch} does not match ${expected.branch}.`);
  return metadata;
}

export function createReleaseMetadata({ version, prepareRunId, prepareRunAttempt, buildSourceSha, releaseName, releaseBody, prerelease, notarize, signWindows, publishServer, publishSnapshot, indexPath }) {
  const tag = `v${version}`;
  const attempt = String(prepareRunAttempt);
  return validateReleaseMetadata({
    schema: 1,
    version,
    tag,
    branch: `release/${tag}`,
    prepareRunId: String(prepareRunId),
    prepareRunAttempt: attempt,
    buildSourceSha,
    release: {
      name: releaseName,
      bodyBase64: encodeReleaseBody(releaseBody),
      prerelease,
      notarize,
      signWindows,
      publishServer,
      publishSnapshot,
    },
    artifacts: {
      indexPath: releaseArtifactIndexPath(tag),
      indexArtifactName: artifactIndexArtifactName(attempt),
      indexSha256: sha256File(indexPath),
      mergedManifestsArtifactName: mergedManifestArtifactName(attempt),
      matrixArtifactNames: matrixArtifactNames(attempt),
    },
  });
}

export function validateReleaseTree({ metadataPath, indexPath, expectedTag, expectedBranch }) {
  const metadata = validateReleaseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")), {
    tag: expectedTag,
    branch: expectedBranch,
  });
  if (sha256File(indexPath) !== metadata.artifacts.indexSha256) throw new Error("Committed artifact index SHA-256 does not match release metadata.");
  const index = validateArtifactIndex(JSON.parse(readFileSync(indexPath, "utf8")));
  if (index.version !== metadata.version || index.sourceSha !== metadata.buildSourceSha
    || index.runId !== metadata.prepareRunId || index.runAttempt !== metadata.prepareRunAttempt) {
    throw new Error("Committed artifact index identity does not match release metadata.");
  }
  return { metadata, index };
}

function bool(value) {
  return value === "true";
}

export function safeReleaseMetadataOutputs(metadata) {
  const values = {
    tag: metadata.tag,
    version: metadata.version,
    branch: metadata.branch,
    prepare_run_id: metadata.prepareRunId,
    prepare_run_attempt: metadata.prepareRunAttempt,
    build_source_sha: metadata.buildSourceSha,
    release_name: metadata.release.name,
    release_body_base64: metadata.release.bodyBase64,
    prerelease: String(metadata.release.prerelease),
    publish_server: String(metadata.release.publishServer),
    publish_snapshot: String(metadata.release.publishSnapshot),
    index_path: metadata.artifacts.indexPath,
    index_artifact_name: metadata.artifacts.indexArtifactName,
    merged_manifests_artifact_name: metadata.artifacts.mergedManifestsArtifactName,
  };
  if (Object.values(values).some((value) => /[\r\n]/.test(value))) {
    throw new Error("Release metadata output contains an unsafe newline.");
  }
  return values;
}

function appendOutputs(metadata, output) {
  const values = safeReleaseMetadataOutputs(metadata);
  for (const [key, value] of Object.entries(values)) appendFileSync(output, `${key}=${value}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === "write") {
    const outputPath = resolve(process.argv[3]);
    const indexPath = resolve(process.argv[4]);
    const metadata = createReleaseMetadata({
      version: process.env.VERSION,
      prepareRunId: process.env.GITHUB_RUN_ID,
      prepareRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      buildSourceSha: process.env.BUILD_SOURCE_SHA,
      releaseName: process.env.RELEASE_NAME,
      releaseBody: process.env.RELEASE_BODY,
      prerelease: bool(process.env.INPUT_PRERELEASE),
      notarize: bool(process.env.INPUT_NOTARIZE),
      signWindows: bool(process.env.INPUT_SIGN_WINDOWS),
      publishServer: bool(process.env.INPUT_PUBLISH_SERVER),
      publishSnapshot: bool(process.env.INPUT_PUBLISH_SNAPSHOT),
      indexPath,
    });
    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
  } else if (command === "outputs") {
    const metadataPath = resolve(process.argv[3]);
    const indexPath = resolve(process.argv[4]);
    const { metadata } = validateReleaseTree({
      metadataPath,
      indexPath,
      expectedTag: process.env.EXPECTED_TAG,
      expectedBranch: process.env.EXPECTED_BRANCH,
    });
    appendOutputs(metadata, process.env.GITHUB_OUTPUT);
  } else {
    throw new Error("Usage: release-metadata.mjs write|outputs <metadata> <index>");
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
