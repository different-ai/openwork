import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSetupBaseline, headCoverage, missingLanguages } from "./check-codeql-results.mjs";

const current = "dynamic/github-code-scanning/codeql:analyze";
const legacy = "dynamic/github-code-scanning/codeql:upload";
const head = "a".repeat(40);
const merge = "b".repeat(40);
const older = "c".repeat(40);
const analysis = (language, { key = current, sha = head, error = "", tool = "CodeQL" } = {}) => ({
  analysis_key: key, category: `/language:${language}`, commit_sha: sha, error, tool: { name: tool },
});

for (const key of [current, legacy]) {
  test(`recognizes the successful default-setup ${key.split(":").at(-1)} baseline`, () => {
    const result = defaultSetupBaseline([
      analysis("javascript-typescript", { key }),
      analysis("java", { key, sha: older }),
      analysis("python", { key }),
      analysis("actions", { key }),
      analysis("ruby", { key: "custom/codeql:analyze" }),
      analysis("go", { key, error: "Analysis failed" }),
    ]);
    assert.deepEqual(result, { commitSha: head, analysisKey: key, languages: ["javascript-typescript", "python", "actions"] });
  });
}

test("does not combine baseline runs from different default-setup keys", () => {
  const result = defaultSetupBaseline([
    analysis("javascript-typescript"),
    analysis("python", { key: legacy }),
    analysis("actions"),
  ]);
  assert.deepEqual(result.languages, ["javascript-typescript", "actions"]);
});

test("missing, failed and non-default baselines never become zero requirements", () => {
  for (const records of [[], [analysis("python", { error: "Read failed" })], [analysis("python", { key: "custom/codeql:upload" })]]) {
    assert.throws(() => defaultSetupBaseline(records), /No successful default-setup baseline/);
  }
});

test("an unsupported or malformed latest default baseline fails instead of trusting an older one", () => {
  for (const latest of [
    analysis("python", { key: "dynamic/github-code-scanning/codeql:unknown" }),
    { ...analysis("python"), category: "not-a-language" },
    { ...analysis("python"), commit_sha: null },
  ]) {
    assert.throws(() => defaultSetupBaseline([latest, analysis("actions", { key: legacy })]), /Unsupported CodeQL default-setup baseline/);
  }
});

test("current head and merge uploads satisfy canonical language requirements", () => {
  assert.deepEqual(missingLanguages(["javascript", "typescript", "python", "actions"], [
    analysis("javascript-typescript"), analysis("python", { sha: merge }), analysis("actions", { key: legacy }),
  ], [head, merge]), []);
});

test("wrong commits, failed results, other tools and custom uploads do not satisfy coverage", () => {
  const uploads = [
    analysis("python", { sha: older }),
    analysis("python", { error: "Upload failed" }),
    analysis("python", { tool: "Other tool" }),
    analysis("python", { key: "custom/codeql:upload" }),
  ];
  assert.deepEqual(missingLanguages(["python"], uploads, [head, merge]), ["python"]);
});

test("recognizes the advanced-setup workflow baseline", () => {
  const key = ".github/workflows/codeql.yml:analyze";
  const result = defaultSetupBaseline([analysis("swift", { key }), analysis("python", { key }), analysis("python", { sha: older })]);
  assert.deepEqual(result, { commitSha: head, analysisKey: key, languages: ["swift", "python"] });
});

test("PRs that skip the Swift build still need a Swift upload", () => {
  assert.deepEqual(missingLanguages(["python", "swift"], [analysis("python")], [head]), ["swift"]);
  assert.deepEqual(missingLanguages(["python", "swift"], [analysis("python"), analysis("swift", { key: ".github/workflows/codeql.yml:analyze" })], [head]), []);
});

test("classifies why a PR head's results did not match by commit", () => {
  const run = (path, status = "completed", conclusion = "success") => ({ path, status, conclusion });
  const advanced = ".github/workflows/codeql.yml";
  const retired = "dynamic/github-code-scanning/codeql";
  assert.equal(headCoverage([run(retired)]), "stale");
  assert.equal(headCoverage([]), "stale");
  assert.equal(headCoverage([run(".github/workflows/ci.yml"), run(retired)]), "stale");
  assert.equal(headCoverage([run(`${advanced}@refs/pull/1/merge`)]), "uploaded");
  assert.equal(headCoverage([run(advanced, "completed", "failure"), run(advanced)]), "uploaded");
  assert.equal(headCoverage([run(advanced, "completed", "failure")]), "missing");
  assert.equal(headCoverage([run(advanced, "completed", "cancelled"), run(retired)]), "missing");
  assert.equal(headCoverage([run(advanced, "in_progress", null)]), "active");
  assert.equal(headCoverage([run(retired, "queued", null)]), "active");
});
