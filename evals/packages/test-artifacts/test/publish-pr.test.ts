import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishPr } from "../src/publish-pr.ts";
import type { CommandRunner, Fetcher } from "../src/publish-pr.ts";
import type { TestRunRecord } from "../src/schema.ts";

const TEST_RUN_SHA = "1111111111111111111111111111111111111111";

function testRunRecord(dir: string): TestRunRecord {
  return {
    name: "Publication proof",
    dir,
    createdAt: "2026-07-02T10:00:00.000Z",
    closedAt: "2026-07-02T10:01:00.000Z",
    gitSha: TEST_RUN_SHA,
    branch: "feat/proof",
    summary: {
      ok: true,
      totalArtifacts: 1,
      passedArtifacts: 1,
      failedArtifacts: 0,
      unvalidatedArtifacts: 0,
      pendingArtifacts: 0,
      passedExpectations: 1,
      failedExpectations: 0,
      pendingJudgments: 0,
    },
    artifacts: [{
      caption: "Published validation",
      fileName: "01-published.png",
      hash: "hash",
      route: "#/published",
      at: "2026-07-02T10:00:00.000Z",
      description: "Visible state",
      model: "test-model",
      ok: true,
      results: [{ expectation: "State is visible", passed: true, evidence: "Visible" }],
      judgments: [{ expectation: "State is visible", state: "passed", reasoning: "Visible" }],
    }],
  };
}

test("publishPr dry-run emits the new marker without upload or gh calls", async () => {
  const testRunDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-publish-"));
  try {
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    let commandCalled = false;
    let fetchCalled = false;
    let output = "";
    const exec: CommandRunner = () => {
      commandCalled = true;
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const fetcher: Fetcher = async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    };
    const result = await publishPr(
      { testRunDir, dryRun: true },
      { exec, fetch: fetcher, stdout: (markdown) => { output = markdown; } },
    );
    assert.equal(commandCalled, false);
    assert.equal(fetchCalled, false);
    assert.equal(result.posted, false);
    assert.match(output, /<!-- test-evidence -->/);
    assert.match(output, /Dry run: screenshots were not uploaded/);
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});

test("publishPr recognizes an old sticky marker and uploads under the test-artifacts prefix", async () => {
  const testRunDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-current-"));
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    await writeFile(join(testRunDir, "01-published.png"), Buffer.from("regular png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    const uploads: string[] = [];
    let patchedBody = "";
    const fetcher: Fetcher = async (input) => {
      uploads.push(String(input));
      return new Response(JSON.stringify({ url: "https://example.test/published.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const exec: CommandRunner = (_command, args, opts) => {
      if (args.includes("headRefOid")) return { status: 0, stdout: JSON.stringify({ headRefOid: TEST_RUN_SHA }), stderr: "" };
      if (args.includes("comments")) {
        return { status: 0, stdout: JSON.stringify({ comments: [{ databaseId: 77, body: "<!-- photo-roll --> old" }] }), stderr: "" };
      }
      patchedBody = opts?.input ?? "";
      return { status: 0, stdout: "updated", stderr: "" };
    };
    const result = await publishPr({ pr: 17, testRunDir }, { exec, fetch: fetcher });
    assert.equal(result.updated, true);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0] ?? "", /\/test-artifacts\/[^/]+\/01-published\.png$/);
    assert.match(patchedBody, /<!-- test-evidence -->/);
    assert.doesNotMatch(patchedBody, /<!-- photo-roll -->/);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(testRunDir, { recursive: true, force: true });
  }
});

test("publishPr reads persisted legacy roll.json input", async () => {
  const testRunDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-legacy-"));
  try {
    const current = testRunRecord(testRunDir);
    await writeFile(join(testRunDir, "roll.json"), JSON.stringify({
      ...current,
      summary: {
        ok: true,
        totalFrames: 1,
        passedFrames: 1,
        failedFrames: 0,
        unvalidatedFrames: 0,
        passedExpectations: 1,
        failedExpectations: 0,
      },
      frames: current.artifacts,
      artifacts: undefined,
    }));
    let output = "";
    await publishPr({ testRunDir, dryRun: true }, { stdout: (markdown) => { output = markdown; } });
    assert.match(output, /evals\/results\/rolls\/.*\/roll\.json/);
    assert.match(output, /<!-- test-evidence -->/);
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});

test("publishPr refuses a symlinked screenshot before upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-symlink-"));
  const testRunDir = join(root, "test-run");
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await mkdir(testRunDir);
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    const outside = join(root, "private-key");
    await writeFile(outside, "private material");
    await symlink(outside, join(testRunDir, "01-published.png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    const exec: CommandRunner = (_command, args) => ({
      status: 0,
      stdout: args.includes("headRefOid") ? JSON.stringify({ headRefOid: TEST_RUN_SHA }) : "",
      stderr: "",
    });
    await assert.rejects(
      () => publishPr({ pr: 17, testRunDir }, { exec }),
      /Refusing to upload non-regular or symlinked test artifact: 01-published\.png/,
    );
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
