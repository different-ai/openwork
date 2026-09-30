import { test } from "node:test";
import assert from "node:assert/strict";
import { median, verifyRun } from "./engine-parity.mjs";

test("parity refuses skipped, missing, duplicate and wrong-engine results", () => {
  const report = status => ({ testResults: [{ assertionResults: [{ title: "PARITY-BOOT v2: first send", status }] }] });
  assert.deepEqual(verifyRun(report("passed"), "v2", ["PARITY-BOOT"]), []);
  for (const status of ["pending", "skipped", "failed"]) assert.equal(verifyRun(report(status), "v2", ["PARITY-BOOT"]).length, 1);
  assert.equal(verifyRun(report("passed"), "v1", ["PARITY-BOOT"]).length, 1);
  assert.equal(verifyRun({}, "v2", ["PARITY-BOOT"]).length, 1);
  const duplicate = report("passed");
  duplicate.testResults.push(...duplicate.testResults);
  assert.equal(verifyRun(duplicate, "v2", ["PARITY-BOOT"]).length, 1);
});
test("timing medians preserve both middle samples and reject missing measurements", () => {
  assert.equal(median([10, 2, 6]), 6);
  assert.equal(median([10, 2, 6, 8]), 7);
  assert.throws(() => median([]));
  assert.throws(() => median([NaN]));
});
