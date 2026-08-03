import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  EXPECTED_MERGED_MANIFESTS,
  RELEASE_STAGES,
  buildArtifactIndex,
  createStageMetadata,
  matrixArtifactNames,
  validateArtifactIndex,
} from "./artifact-contract.mjs";
import {
  createReleaseMetadata,
  decodeReleaseBody,
  safeReleaseMetadataOutputs,
  validateReleaseMetadata,
  validateReleaseTree,
} from "./release-metadata.mjs";
import { createReleasePlan, decideTagAction } from "./release-plan.mjs";
import { decideNpmPublication } from "./npm-publication.mjs";
import { collectStagedAssets, planImmutablePublication } from "./staged-assets.mjs";

const root = resolve(import.meta.dirname, "../..");
const workflowPath = (name) => resolve(root, ".github/workflows", name);
const workflow = (name) => readFileSync(workflowPath(name), "utf8");
const version = "1.2.4";
const sourceSha = "a".repeat(40);
const runId = "1234";
const runAttempt = "1";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assetName(stage, extension) {
  return `${stage.prefix}-${stage.os}-${stage.arch}-${version}.${extension}`;
}

function createCompleteStageFixture() {
  const directory = mkdtempSync(join(tmpdir(), "openwork-stage-contract-"));
  const stageRoot = join(directory, "stages");
  const manifests = join(directory, "merged-manifests");
  mkdirSync(stageRoot);
  mkdirSync(manifests);
  const manifestAssets = new Map(EXPECTED_MERGED_MANIFESTS.map((name) => [name, []]));

  for (const stage of RELEASE_STAGES) {
    const artifactName = `release-desktop-${stage.id}-attempt-${runAttempt}`;
    const artifactDirectory = join(stageRoot, artifactName);
    mkdirSync(join(artifactDirectory, "assets"), { recursive: true });
    mkdirSync(join(artifactDirectory, "manifests"), { recursive: true });
    for (const extension of stage.extensions) {
      writeFileSync(join(artifactDirectory, "assets", assetName(stage, extension)), `${stage.id}-${extension}`);
    }
    writeFileSync(join(artifactDirectory, "manifests", stage.manifest), `version: ${version}\n`);
    manifestAssets.get(stage.manifest).push(assetName(stage, stage.extensions[0]));
    writeJson(join(artifactDirectory, "stage.json"), createStageMetadata({
      directory: artifactDirectory,
      stageId: stage.id,
      version,
      sourceSha,
      runId,
      runAttempt,
      artifactName,
    }));
  }
  for (const [name, assets] of manifestAssets) {
    writeFileSync(join(manifests, name), [
      `version: ${version}`,
      "files:",
      ...assets.map((name) => `  - url: ${name}`),
      "",
    ].join("\n"));
  }
  return { directory, stageRoot, manifests };
}

function buildFixtureIndex(fixture) {
  return buildArtifactIndex({
    root: fixture.stageRoot,
    manifestsDirectory: fixture.manifests,
    version,
    sourceSha,
    runId,
    runAttempt,
  });
}

test("plans patch, minor, and major releases deterministically", () => {
  assert.deepEqual(createReleasePlan({ currentVersion: "1.2.3", bump: "patch" }), {
    version,
    tag: `v${version}`,
    branch: `release/v${version}`,
  });
  assert.equal(createReleasePlan({ currentVersion: "1.2.3", bump: "minor" }).version, "1.3.0");
  assert.equal(createReleasePlan({ currentVersion: "1.2.3", bump: "major" }).version, "2.0.0");
  assert.throws(() => createReleasePlan({ currentVersion: "1.2.3-alpha.1", bump: "patch" }));
});

test("tag creation is idempotent only at the exact merge SHA", () => {
  const sha = "a".repeat(40);
  assert.equal(decideTagAction("", sha), "create");
  assert.equal(decideTagAction(sha, sha), "keep");
  assert.throws(() => decideTagAction("b".repeat(40), sha), /already targets/);
});

test("builds an exact complete 18-stage immutable artifact index", () => {
  const fixture = createCompleteStageFixture();
  try {
    const index = validateArtifactIndex(buildFixtureIndex(fixture));
    assert.equal(index.stages.length, 18);
    assert.deepEqual(index.stages.map((stage) => stage.artifactName).sort(), matrixArtifactNames(runAttempt));
    assert.equal(index.publicationFiles.filter((file) => file.name.endsWith(".yml")).length, 12);
    assert.equal(index.sourceSha, sourceSha);
    assert.equal(index.runAttempt, runAttempt);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects missing, unexpected, mixed-source, and mixed-attempt desktop stages", () => {
  for (const mutation of ["missing", "unexpected", "source", "attempt"]) {
    const fixture = createCompleteStageFixture();
    try {
      const first = matrixArtifactNames(runAttempt)[0];
      if (mutation === "missing") rmSync(join(fixture.stageRoot, first), { recursive: true });
      if (mutation === "unexpected") mkdirSync(join(fixture.stageRoot, "release-desktop-electron-unknown-attempt-1"));
      if (mutation === "source" || mutation === "attempt") {
        const path = join(fixture.stageRoot, first, "stage.json");
        const metadata = JSON.parse(readFileSync(path, "utf8"));
        if (mutation === "source") metadata.sourceSha = "b".repeat(40);
        if (mutation === "attempt") metadata.runAttempt = "2";
        writeJson(path, metadata);
      }
      assert.throws(() => buildFixtureIndex(fixture), /incomplete|unexpected|metadata|attempt|source/i, mutation);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("committed release metadata validates index identity and keeps multiline body output safe", () => {
  const fixture = createCompleteStageFixture();
  try {
    const indexPath = join(fixture.directory, "artifacts.json");
    const metadataPath = join(fixture.directory, "release.json");
    writeJson(indexPath, buildFixtureIndex(fixture));
    const body = "Line one\nline two%0A\nname=value";
    const metadata = createReleaseMetadata({
      version,
      prepareRunId: runId,
      prepareRunAttempt: runAttempt,
      buildSourceSha: sourceSha,
      releaseName: `OpenWork v${version}`,
      releaseBody: body,
      prerelease: false,
      notarize: true,
      signWindows: false,
      publishServer: true,
      publishSnapshot: true,
      indexPath,
    });
    writeJson(metadataPath, metadata);
    const validated = validateReleaseTree({
      metadataPath,
      indexPath,
      expectedTag: `v${version}`,
      expectedBranch: `release/v${version}`,
    });
    assert.equal(decodeReleaseBody(validated.metadata.release.bodyBase64), body);
    assert.ok(Object.values(safeReleaseMetadataOutputs(metadata)).every((value) => !/[\r\n]/.test(value)));
    assert.throws(() => validateReleaseMetadata({ ...metadata, branch: "release/v9.9.9" }), /branch/);
    writeFileSync(indexPath, `${readFileSync(indexPath, "utf8")} `);
    assert.throws(() => validateReleaseTree({ metadataPath, indexPath }), /SHA-256/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("npm publication distinguishes exact version, confirmed 404, and registry failures", () => {
  assert.equal(decideNpmPublication({ version, status: 0, stdout: `"${version}"`, stderr: "" }), "keep");
  assert.equal(decideNpmPublication({ version, status: 1, stdout: "", stderr: "ERR_PNPM_FETCH_404 404 Not Found" }), "publish");
  assert.throws(() => decideNpmPublication({ version, status: 1, stdout: "", stderr: "ETIMEDOUT" }), /without a confirmed 404/);
  assert.throws(() => decideNpmPublication({ version, status: 0, stdout: '"1.2.3"', stderr: "" }), /expected exact/);
});

test("immutable asset publication keeps matching bytes and rejects replacements", () => {
  const directory = mkdtempSync(join(tmpdir(), "openwork-release-assets-"));
  try {
    const assetDirectory = join(directory, "release-desktop-electron-linux-x64-attempt-1", "assets");
    const manifestDirectory = join(directory, "release-desktop-manifests-attempt-1");
    mkdirSync(assetDirectory, { recursive: true });
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, `openwork-linux-x64-${version}.tar.gz`), "linux");
    writeFileSync(join(manifestDirectory, "latest-linux.yml"), `version: ${version}\n`);
    const staged = collectStagedAssets(directory);
    const existing = new Map(staged.map((asset) => [asset.name, { sha256: asset.sha256 }]));
    assert.deepEqual(planImmutablePublication(staged, existing).map((item) => item.action), ["keep", "keep"]);
    existing.set(staged[0].name, { sha256: "0".repeat(64) });
    assert.throws(() => planImmutablePublication(staged, existing), /differs from staged/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflows parse and enforce App-authored one-review immutable contracts", () => {
  const names = [
    "release-prepare.yml",
    "release-macos-aarch64.yml",
    "release-continue.yml",
    "release-publish-desktop.yml",
    "release-publish-server.yml",
    "release-daytona-snapshot.yml",
    "release-publish-aur.yml",
    "aur-validate.yml",
  ];
  const parsed = new Map(names.map((name) => [name, parseYaml(workflow(name))]));
  for (const name of names) assert.ok(parsed.get(name).jobs, `${name} has jobs`);
  const prepareText = workflow("release-prepare.yml");
  assert.deepEqual(parsed.get("release-prepare.yml").on.workflow_dispatch.inputs.bump.options, ["patch", "minor", "major"]);
  assert.match(prepareText, /actions\/create-github-app-token@v2/);
  assert.match(prepareText, /GH_TOKEN: \$\{\{ steps\.release-app-pr\.outputs\.token \}\}/);
  assert.match(prepareText, /RELEASE_APP_LOGIN/);
  assert.match(prepareText, /\.github\/releases\/\$TAG\/release\.json/);
  assert.match(prepareText, /verify-signed-release-branch\.sh/);
  assert.ok((prepareText.match(/persist-credentials: false/g) ?? []).length >= 2);
  assert.match(prepareText, /RELEASE_APP_TOKEN: \$\{\{ steps\.release-app-preflight\.outputs\.token \}\}/);
  assert.match(prepareText, /RELEASE_APP_TOKEN: \$\{\{ steps\.release-app-branch\.outputs\.token \}\}/);
  assert.equal((prepareText.match(/git push "\$remote" "HEAD:refs\/heads\/\$BRANCH"/g) ?? []).length, 2);
  assert.doesNotMatch(prepareText, /git push origin "HEAD:refs\/heads/);
  const signatureVerifier = readFileSync(resolve(root, "scripts/release/verify-signed-release-branch.sh"), "utf8");
  assert.match(signatureVerifier, /gpg\.ssh\.allowedSignersFile/);
  assert.match(signatureVerifier, /verify-commit/);
  assert.doesNotMatch(prepareText, /openwork-release:|--failed|git push origin dev/);

  const desktopStage = parsed.get("release-macos-aarch64.yml");
  assert.equal(desktopStage.jobs["stage-electron"].strategy.matrix.include.length, 18);
  assert.equal(desktopStage.on.push, undefined);
  assert.match(workflow("release-macos-aarch64.yml"), /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(workflow("release-macos-aarch64.yml"), /attempt-\$\{\{ github\.run_attempt \}\}/);

  const continuationText = workflow("release-continue.yml");
  assert.match(continuationText, /resolve-merge\.mjs/);
  assert.match(continuationText, /RELEASE_APP_LOGIN/);
  assert.match(continuationText, /permission-contents: write/);
  assert.match(continuationText, /verify-signed-release-branch\.sh "\$SOURCE_SHA" "\$pr_head_sha"/);
  assert.match(continuationText, /git diff --quiet "\$PR_HEAD\^\{tree\}" "\$MERGE_SHA\^\{tree\}"/);
  assert.doesNotMatch(continuationText, /pull_request\.body|--force-with-lease|push --delete/);

  const desktopPublish = workflow("release-publish-desktop.yml");
  assert.match(desktopPublish, /steps\.metadata\.outputs\.prepare_run_attempt/);
  assert.match(desktopPublish, /Rebuild and verify complete artifact contract/);
  assert.match(desktopPublish, /actions\/runs\/\$PREPARE_RUN_ID\/attempts\/\$PREPARE_RUN_ATTEMPT/);
  assert.match(desktopPublish, /returned_attempt/);
  assert.doesNotMatch(desktopPublish, /--clobber|inputs\.prepare_run_id/);
  assert.match(workflow("release-publish-server.yml"), /openwork-server@\$version/);
  assert.match(workflow("release-publish-aur.yml"), /verify-aur-assets\.sh/);
  assert.doesNotMatch(workflow("release-publish-aur.yml"), /gh pr create/);
  assert.doesNotMatch(workflow("aur-validate.yml"), /AUR_SSH_PRIVATE_KEY|Publish to AUR/);
  for (const name of ["release-publish-desktop.yml", "release-publish-server.yml", "release-publish-aur.yml"]) {
    assert.match(workflow(name), /not verified/);
    assert.doesNotMatch(workflow(name), /echo "- Output:/);
  }
});
