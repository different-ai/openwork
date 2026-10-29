import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultSetupBaseline, missingLanguages } from "../../scripts/ci/check-codeql-results.mjs";

const workflow = readFileSync(new URL("../workflows/codeql.yml", import.meta.url), "utf8");
const classifier = workflow.split("          script: |\n")[1]?.split("\n\n  analyze:\n")[0];
assert.ok(classifier, "Missing Swift input classifier");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function classify(eventName, { files = [], failure } = {}) {
  const outputs = new Map();
  const warnings = [];
  let comparisons = 0;
  await new AsyncFunction("context", "core", "github", classifier)(
    {
      eventName,
      repo: { owner: "example", repo: "repo" },
      payload: { pull_request: { number: 1 } },
    },
    {
      setOutput: (key, value) => outputs.set(key, value),
      info: () => {},
      warning: (value) => warnings.push(value),
    },
    {
      rest: { pulls: { listFiles: "listFiles" } },
      paginate: async () => {
        comparisons++;
        if (failure) throw failure;
        return files;
      },
    },
  );
  return { swift: outputs.get("swift"), comparisons, warnings };
}

for (const event of ["push", "schedule", "workflow_dispatch"]) {
  test(`CodeQL keeps the real Swift category on ${event}, including source-unchanged dev pushes`, async () => {
    // The dev code_scanning rule and the coverage monitor expect all categories
    // from a full baseline. Do not optimize away these scans or replace their
    // existing alerts with an empty upload without proving the rule's behavior.
    const result = await classify(event);
    assert.equal(result.swift, "true");
    assert.equal(result.comparisons, 0);
  });
}

test("only unchanged-source PRs can use an empty Swift result", async () => {
  const unchanged = await classify("pull_request", { files: [
    { filename: "ee/apps/landing/app/page.tsx" },
    { filename: "packages/docs/images/screenshot.png" },
  ] });
  assert.equal(unchanged.swift, "false");
  for (const file of [
    { filename: "packages/computer-use/native/Package.swift" },
    { filename: "packages/computer-use/native/Sources/ComputerUse/main.swift" },
    { filename: ".github/workflows/codeql.yml" },
    { filename: ".github/codeql/codeql-config.yml" },
    { filename: "moved/main.swift", previous_filename: "packages/computer-use/native/Sources/ComputerUse/main.swift" },
  ]) {
    assert.equal((await classify("pull_request", { files: [file] })).swift, "true", file.filename);
  }
  const emptyResultConditions = [...workflow.matchAll(/- name: (?:Write|Upload) empty Swift result\n        if: ([^\n]+)/g)].map((match) => match[1]);
  assert.deepEqual(emptyResultConditions, [
    "github.event_name == 'pull_request' && env.RUN_ANALYSIS != 'true'",
    "github.event_name == 'pull_request' && env.RUN_ANALYSIS != 'true'",
  ], "Empty SARIF must never clear Swift alerts on dev");
});

test("an unavailable or capped PR comparison runs real Swift, never publishes an empty result", async () => {
  for (const options of [
    { failure: new Error("comparison unavailable") },
    { files: null },
    { files: Array.from({ length: 3000 }, () => ({ filename: "unrelated.txt" })) },
  ]) {
    const result = await classify("pull_request", options);
    assert.equal(result.swift, "true");
    assert.ok(result.warnings.length);
  }
});

test("the Swift scope does not remove no-build security scans or change upload categories", () => {
  assert.match(workflow, /pull_request:\n    branches:\n      - dev/);
  assert.match(workflow, /push:\n    branches:\n      - dev/);
  assert.match(workflow, /schedule:\n    - cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow.split("\nconcurrency:\n")[0], /^\s+paths(?:-ignore)?:/m);
  for (const language of ["actions", "javascript-typescript", "python"]) {
    assert.ok(workflow.includes(`- language: ${language}\n            build-mode: none`));
  }
  assert.match(workflow, /- language: swift\n            build-mode: manual/);
  assert.ok(workflow.includes("RUN_ANALYSIS: ${{ matrix.language != 'swift' || needs.changes.outputs.swift == 'true' }}"));
  assert.match(workflow, /category: \/language:swift/);
  assert.ok(workflow.includes("category: /language:${{ matrix.language }}"));
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
