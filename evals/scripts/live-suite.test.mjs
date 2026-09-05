import { test } from "node:test";
import assert from "node:assert/strict";
import { reportPassed } from "./live-suite.mjs";

const complete = { success: true, numTotalTests: 9, numPassedTests: 9, numPendingTests: 0, numTodoTests: 0 };
test("live nightly accepts a complete passing run", () => {
  assert.equal(reportPassed(complete), true);
});
test("live nightly rejects green exits with skips, todo, zero tests, failures, or missing counts", () => {
  for (const report of [
    { ...complete, numPendingTests: 1 },
    { ...complete, numTodoTests: 1 },
    { ...complete, numTotalTests: 0, numPassedTests: 0 },
    { ...complete, numPassedTests: 8 },
    { ...complete, success: false },
    { success: true },
  ]) assert.equal(reportPassed(report), false);
});
