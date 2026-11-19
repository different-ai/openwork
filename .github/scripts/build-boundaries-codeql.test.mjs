import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultSetupBaseline, missingLanguages } from "../../scripts/ci/check-codeql-results.mjs";

const workflow = readFileSync(new URL("../workflows/codeql.yml", import.meta.url), "utf8");

test("PRs upload an empty result for every category; dev, schedule and manual runs analyze", () => {
  // The dev code_scanning rule waits for every category on each PR. PR legs
  // upload an empty result in seconds; real analysis runs on the merged commit.
  assert.match(workflow, /pull_request:\n    branches:\n      - dev/);
  assert.match(workflow, /push:\n    branches:\n      - dev/);
  assert.match(workflow, /schedule:\n    - cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow.split("\nconcurrency:\n")[0], /^\s+paths(?:-ignore)?:/m);
  assert.ok(workflow.includes("RUN_ANALYSIS: ${{ github.event_name != 'pull_request' }}"));
  const emptyResultConditions = [...workflow.matchAll(/- name: (?:Write|Upload) empty PR result\n        if: ([^\n]+)/g)].map((match) => match[1]);
  assert.deepEqual(emptyResultConditions, ["github.event_name == 'pull_request'", "github.event_name == 'pull_request'"], "Empty SARIF must never clear alerts on dev");
  for (const step of ["Initialize CodeQL", "Perform CodeQL Analysis"]) {
    assert.ok(workflow.includes(`- name: ${step}\n        if: env.RUN_ANALYSIS == 'true'`), step);
  }
  assert.ok(workflow.includes("- name: Build Swift\n        if: env.RUN_ANALYSIS == 'true' && matrix.language == 'swift'"));
  for (const language of ["actions", "javascript-typescript", "python"]) {
    assert.ok(workflow.includes(`- language: ${language}\n            build-mode: none`));
  }
  assert.match(workflow, /- language: swift\n            build-mode: manual/);
  // One analysis key and the same categories for PR and dev uploads.
  assert.match(workflow, /\njobs:\n  analyze:\n/);
  assert.equal(workflow.split("category: /language:${{ matrix.language }}").length - 1, 2);
  assert.match(workflow, /config-file: \.\/\.github\/codeql\/codeql-config\.yml/);
  assert.match(workflow, /run: swift build --package-path packages\/computer-use\/native --product ComputerUse/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});

test("coverage still requires successful current-head or merge results for all four categories", () => {
  const languages = ["actions", "javascript-typescript", "python", "swift"];
  const key = ".github/workflows/codeql.yml:analyze";
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  const older = "c".repeat(40);
  const upload = (language, overrides = {}) => ({
    analysis_key: key,
    category: `/language:${language}`,
    commit_sha: head,
    error: "",
    tool: { name: "CodeQL" },
    ...overrides,
  });
  const baseline = defaultSetupBaseline(languages.map((language) => upload(language)));
  assert.deepEqual(baseline, { commitSha: head, analysisKey: key, languages });
  assert.deepEqual(missingLanguages(baseline.languages, languages.slice(0, -1).map((language) => upload(language)), [head, merge]), ["swift"]);
  for (const language of languages) {
    for (const overrides of [
      { commit_sha: older },
      { error: "Analysis failed" },
      { analysis_key: "unrelated/workflow:analyze" },
      { tool: { name: "Other tool" } },
    ]) {
      const analyses = languages.map((current) => upload(current, current === language ? overrides : {}));
      assert.deepEqual(missingLanguages(baseline.languages, analyses, [head, merge]), [language]);
    }
  }
  assert.deepEqual(missingLanguages(baseline.languages, languages.map((language) => upload(language, { commit_sha: merge })), [head, merge]), []);
});
