import test from "node:test";
import assert from "node:assert/strict";

import {
  consentVarsFromSource,
  exitCodeFor,
  parseArgs,
  summarize,
  verdictFor,
} from "./evals.mjs";

test("consentVarsFromSource extracts, deduplicates, and sorts only opt-in variables", () => {
  const source = `
    needs({ optIn: ["OPENWORK_EVAL_ZETA", 'OPENWORK_EVAL_ALPHA'] });
    const requirements = {
      optIn: [
        "OPENWORK_EVAL_MULTI",
        "OPENWORK_EVAL_ALPHA",
      ],
    };
    process.env.OPENWORK_EVAL_DIRECT === "1";
    process.env.OPENWORK_EVAL_TRIMMED?.trim() === "1";
    process.env.OPENWORK_EVAL_MODEL?.trim() || "";
    process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
    process.env.UNRELATED === "1";
  `;

  assert.deepEqual(consentVarsFromSource(source), [
    "OPENWORK_EVAL_ALPHA",
    "OPENWORK_EVAL_DIRECT",
    "OPENWORK_EVAL_MULTI",
    "OPENWORK_EVAL_TRIMMED",
    "OPENWORK_EVAL_ZETA",
  ]);
});

test("parseArgs maps run and publish flags", () => {
  assert.deepEqual(parseArgs(["app-smoke", "--with-llm-vision", "--daytona", "--den", "https://den.example"]), {
    testNames: ["app-smoke"],
    withLlmVision: true,
    daytona: true,
    publish: false,
    dryRun: false,
    force: false,
    help: false,
    den: "https://den.example",
  });
  assert.deepEqual(parseArgs(["--publish", "--pr", "42", "--test-run", "latest", "--dry-run", "--force"]), {
    testNames: [],
    withLlmVision: false,
    daytona: false,
    publish: true,
    dryRun: true,
    force: true,
    help: false,
    pr: "42",
    testRun: "latest",
  });
});

test("parseArgs validates values, exclusivity, and unknown flags", () => {
  assert.throws(() => parseArgs(["--den"]), /--den requires a value/);
  assert.throws(() => parseArgs(["--publish", "--dry-run", "app-smoke"]), /mutually exclusive with test names/);
  assert.throws(() => parseArgs(["--publish", "--pr", "1", "--den", "x"]), /mutually exclusive with --den/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown flag: --unknown/);
});

test("verdict and exit mapping covers failed, incomplete, and passed runs", () => {
  const failed = verdictFor({ failed: 1, skipped: 0 });
  assert.equal(failed, "failed");
  assert.equal(exitCodeFor(failed, { named: true }), 1);

  const incomplete = verdictFor({ failed: 0, skipped: 1 });
  assert.equal(incomplete, "incomplete");
  assert.equal(exitCodeFor(incomplete, { named: true }), 2);
  assert.equal(exitCodeFor(incomplete, { named: false }), 0);

  const passed = verdictFor({ failed: 0, skipped: 0 });
  assert.equal(passed, "passed");
  assert.equal(exitCodeFor(passed, { named: true }), 0);
});

test("summarize reads counts and skipped test details", () => {
  assert.deepEqual(summarize({
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    testResults: [{
      name: "/repo/evals/specs/app-smoke.e2e.test.ts",
      assertionResults: [
        { status: "passed", title: "runs" },
        { status: "pending", title: "needs provider" },
      ],
    }],
  }), {
    passed: 1,
    failed: 0,
    skipped: 1,
    skips: [{ file: "app-smoke.e2e.test.ts", title: "needs provider" }],
  });
});
