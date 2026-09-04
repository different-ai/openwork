import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishPr } from "../src/publish-pr.ts";
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
