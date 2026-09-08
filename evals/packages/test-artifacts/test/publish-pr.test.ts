import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishPr, publishReviewPr } from "../src/publish-pr.ts";
import { assembleReview } from "../src/review.ts";
import { reviewSchema, summarizeReview } from "@openwork/review";
import { uploadReview } from "@openwork/review/storage";
import { readFile, readdir } from "node:fs/promises";
import type { CommandRunner } from "../src/publish-pr.ts";
import type { TestRunRecord } from "../src/schema.ts";

const TEST_RUN_SHA = "1111111111111111111111111111111111111111";

interface RecordedCommand {
  command: string;
  args: string[];
  input?: string;
}

function testRunRecord(dir: string): TestRunRecord {
  return {
    name: "Publication proof",
    dir,
    createdAt: "2026-07-02T10:00:00.000Z",
    closedAt: "2026-07-02T10:01:00.000Z",
    gitSha: TEST_RUN_SHA,
    engine: "v1",
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
    trace: [],
    steps: [],
    outcome: "passed",
  };
}

function recordingExec(calls: RecordedCommand[], comments: object[] = [], attach = true): CommandRunner {
  return (command, args, opts) => {
    calls.push({ command, args, input: opts?.input });
    if (args.includes("headRefOid")) {
      return { status: 0, stdout: JSON.stringify({ headRefOid: TEST_RUN_SHA }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "comment" && args[2] === "--help") {
      return { status: 0, stdout: attach ? "--attach <file>" : "GitHub CLI help", stderr: "" };
    }
    if (args.includes("comments")) {
      return { status: 0, stdout: JSON.stringify({ comments }), stderr: "" };
    }
    return { status: 0, stdout: "ok", stderr: "" };
  };
}

test("publishPr dry-run makes no gh calls", async () => {
  const testRunDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-publish-"));
  try {
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    const calls: RecordedCommand[] = [];
    let output = "";
    const result = await publishPr(
      { testRunDir, dryRun: true },
      { exec: recordingExec(calls), stdout: (markdown) => { output = markdown; } },
    );
    assert.deepEqual(calls, []);
    assert.equal(result.posted, false);
    assert.match(output, /<!-- test-evidence -->/);
    assert.match(output, /Dry run: screenshots were not attached/);
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});

test("publishPr deletes a legacy sticky comment and posts attachments", async () => {
  const testRunDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-current-"));
  try {
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    await writeFile(join(testRunDir, "01-published.png"), Buffer.from("regular png"));
    const calls: RecordedCommand[] = [];
    const result = await publishPr(
      { pr: 17, testRunDir },
      { exec: recordingExec(calls, [{ databaseId: 77, body: "<!-- photo-roll --> old" }]) },
    );
    const absPath = join(await realpath(testRunDir), "01-published.png");
    const deleted = calls.find((call) => call.args.includes("DELETE"));
    const posted = calls.find((call) => call.args[0] === "pr" && call.args[1] === "comment" && call.args[2] === "17");
    assert.equal(result.updated, true);
    assert.deepEqual(deleted?.args, ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/comments/77"]);
    assert.deepEqual(posted?.args, ["pr", "comment", "17", "--body-file", "-", "--attach", `${absPath}#Published validation`]);
    assert.match(posted?.input ?? "", new RegExp(`!\\[Published validation\\]\\(${absPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
    assert.doesNotMatch(posted?.input ?? "", /<!-- photo-roll -->/);
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});

test("publishPr publishes persisted legacy roll.json input", async () => {
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
    await writeFile(join(testRunDir, "01-published.png"), Buffer.from("regular png"));
    const calls: RecordedCommand[] = [];
    const result = await publishPr({ pr: 17, testRunDir }, { exec: recordingExec(calls) });
    const posted = calls.find((call) => call.args[0] === "pr" && call.args[1] === "comment" && call.args[2] === "17");
    assert.equal(result.posted, true);
    assert.match(posted?.input ?? "", /evals\/results\/rolls\/.*\/roll\.json/);
    assert.match(posted?.input ?? "", /<!-- test-evidence -->/);
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});

test("publishPr refuses a symlinked screenshot before any PR comment", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-symlink-"));
  const testRunDir = join(root, "test-run");
  try {
    await mkdir(testRunDir);
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    const outside = join(root, "private-key");
    await writeFile(outside, "private material");
    await symlink(outside, join(testRunDir, "01-published.png"));
    const calls: RecordedCommand[] = [];
    await assert.rejects(
      () => publishPr({ pr: 17, testRunDir }, { exec: recordingExec(calls) }),
      /Refusing to attach non-regular or symlinked test artifact: 01-published\.png/,
    );
    assert.equal(calls.some((call) => call.args[0] === "pr" && call.args[1] === "comment"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishPr posts a notice without attachments when gh lacks --attach", async () => {
  const testRunDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-old-gh-"));
  try {
    await writeFile(join(testRunDir, "test-run.json"), JSON.stringify(testRunRecord(testRunDir)));
    await writeFile(join(testRunDir, "01-published.png"), Buffer.from("regular png"));
    const calls: RecordedCommand[] = [];
    await publishPr({ pr: 17, testRunDir }, { exec: recordingExec(calls, [], false) });
    const posted = calls.find((call) => call.args[0] === "pr" && call.args[1] === "comment" && call.args[2] === "17");
    assert.equal(posted?.args.includes("--attach"), false);
    assert.match(posted?.input ?? "", /screenshots not attached \(gh < 2\.99; run `brew upgrade gh`\)/);
    assert.doesNotMatch(posted?.input ?? "", /!\[Published validation\]/);
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});

async function reviewFixture(root: string, name: string) {
  const directory = join(root, name);
  await mkdir(directory);
  const run = testRunRecord(directory);
  run.name = name;
  const screenshot = run.artifacts[0];
  if (!screenshot) throw new Error("Missing test image.");
  run.artifacts.push({
    ...screenshot,
    fileName: "",
    caption: "Recorded assertion",
  });
  await writeFile(join(directory, "test-run.json"), JSON.stringify(run));
  await writeFile(
    join(directory, screenshot.fileName),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return directory;
}

test("review composition preserves sources, deduplicates images, and validates evidence references", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-review-compose-"));
  try {
    const first = await reviewFixture(root, "First behavior");
    const second = await reviewFixture(root, "Second behavior");
    const shot = join(first, "shot.review.json");
    await writeFile(
      shot,
      JSON.stringify({
        schemaVersion: 1,
        kind: "docshot",
        name: "Documentation reference",
        gitSha: TEST_RUN_SHA,
        createdAt: "2026-07-02T10:00:00.000Z",
        fileName: "01-published.png",
      }),
    );
    const { report, assets } = await assembleReview({
      testRunDirs: [first, second, first],
      docShots: [shot],
    });
    assert.equal(report.sources.length, 3);
    assert.equal(report.sections.length, 3);
    assert.equal(
      assets.filter((asset) => asset.name.endsWith(".png")).length,
      1,
    );
    assert.equal(summarizeReview(report).verdict, "Passed");
    const document = await assembleReview({
      testRunDirs: [],
      docShots: [shot],
    });
    assert.equal(summarizeReview(document.report).verdict, "Reference");
    const incomplete = structuredClone(report);
    incomplete.gaps.push("Not exercised");
    assert.equal(summarizeReview(incomplete).verdict, "Incomplete");
    assert.equal(
      reviewSchema.safeParse({
        ...report,
        sections: [{ ...report.sections[0], evidenceIds: ["missing"] }],
      }).success,
      false,
    );
    assert.equal(
      reviewSchema.safeParse({ ...report, schemaVersion: 2 }).success,
      false,
    );
    await writeFile(
      shot,
      JSON.stringify({
        schemaVersion: 1,
        kind: "docshot",
        name: "Old reference",
        gitSha: "2".repeat(40),
        createdAt: "2026-07-02T10:00:00.000Z",
        fileName: "01-published.png",
      }),
    );
    await assert.rejects(
      assembleReview({ testRunDirs: [first], docShots: [shot] }),
      /match the report commit/,
    );
    const storage = join(root, "storage");
    await mkdir(storage);
    const id = await uploadReview(report, assets, { localDir: storage });
    assert.deepEqual(
      JSON.parse(await readFile(join(storage, id, "report.json"), "utf8")),
      report,
    );
    assert.equal((await readdir(join(storage, id))).length, assets.length + 1);
    await assert.rejects(
      uploadReview(report, [], { localDir: storage }),
      /referenced review asset is missing/,
    );
    const secondId = await uploadReview(report, assets, { localDir: storage });
    assert.notEqual(id, secondId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review publication validates before uploading and preserves the comment when upload or head checks fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-review-publish-"));
  try {
    const directory = await reviewFixture(root, "Publication");
    const options = {
      pr: 17,
      testRunDirs: [directory],
      reviewUrl: "https://review.example.test",
    };
    const calls: RecordedCommand[] = [];
    let uploads = 0;
    const upload = async () => {
      uploads++;
      return "a".repeat(32);
    };
    const exec = recordingExec(calls, [
      { databaseId: 77, body: "<!-- test-evidence --> previous" },
    ]);
    const dryRun = await publishReviewPr(
      { ...options, dryRun: true },
      { exec, upload, stdout: () => {} },
    );
    assert.equal(dryRun.posted, false);
    assert.equal(calls.length, 0);
    assert.equal(uploads, 0);
    const result = await publishReviewPr(options, { exec, upload });
    assert.equal(result.updated, true);
    assert.equal(uploads, 1);
    assert.match(result.markdown, /Open review report/);
    assert.ok(result.markdown.length < 500);
    assert.equal(
      calls.some(
        (call) =>
          call.args.includes("DELETE") || call.args.includes("--attach"),
      ),
      false,
    );
    assert.ok(calls.some((call) => call.args.includes("PATCH")));
    calls.length = 0;
    const priorUploads = uploads;
    const preserved = await publishReviewPr({ ...options, preserveCurrentReport: true }, {
      exec: recordingExec(calls, [{ databaseId: 77, body: result.markdown }]), upload,
    });
    assert.equal(preserved.posted, false);
    assert.equal(uploads, priorUploads);
    assert.equal(calls.some((call) => call.args.includes("PATCH")), false);
    calls.length = 0;
    await assert.rejects(
      publishReviewPr(options, {
        exec,
        upload: async () => {
          throw new Error("Storage unavailable");
        },
      }),
      /Storage unavailable/,
    );
    assert.equal(
      calls.some(
        (call) => call.args.includes("PATCH") || call.args.includes("comment"),
      ),
      false,
    );
    calls.length = 0;
    let headReads = 0;
    const changedHead: CommandRunner = (command, args, opts) => {
      if (args.includes("headRefOid") && ++headReads > 1)
        return {
          status: 0,
          stdout: JSON.stringify({ headRefOid: "2".repeat(40) }),
          stderr: "",
        };
      return exec(command, args, opts);
    };
    await assert.rejects(
      publishReviewPr(options, { exec: changedHead, upload }),
      /Refusing stale evidence/,
    );
    assert.equal(
      calls.some(
        (call) => call.args.includes("PATCH") || call.args.includes("comment"),
      ),
      false,
    );
    const run = testRunRecord(directory);
    run.gitSha = "2".repeat(40);
    await writeFile(join(directory, "test-run.json"), JSON.stringify(run));
    const before = uploads;
    await assert.rejects(
      publishReviewPr(options, { exec, upload }),
      /Refusing stale evidence/,
    );
    assert.equal(uploads, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
