import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("mandatory Core verdict and optional preview finalizer retain attempt-bound artifacts", () => {
  const workflow = read("workflows/pr-proof.yml");
  const core = workflow.split("\n  core:\n")[1].split("\n  core-preview:\n")[0];
  const preview = workflow.split("\n  core-preview:\n")[1].split("\n  proof:\n")[0];
  assert.match(core, /OPENWORK_DAYTONA_EPHEMERAL_WORLD: '1'/);
  assert.match(core, /OPENWORK_DAYTONA_PREVIEW_OWNER: \$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-core/);
  assert.doesNotMatch(core, /continue-on-error|finalize-core-preview/);
  assert.match(core, /--checkpoints/);
  assert.match(preview, /always\(\) && needs.core.result != 'skipped'/);
  assert.match(preview, /Optional Core preview finalization/);
  assert.match(preview, /OPENWORK_PREVIEW_CLEANUP_ONLY:.*steps.records.outcome/);
  assert.match(preview, /always\(\) && steps.records.outcome == 'success'/);
  assert.equal(preview.match(/name: pr-proof-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.key \}\}/g)?.length, 2);
  assert.match(preview, /overwrite: true/);
});

test("optional finalization verifies a real restore and reports missing previews without changing assertions", () => {
  const finalizer = read("../evals/scripts/finalize-core-preview.ts");
  assert.ok(finalizer.indexOf("await finalizePreviewHandoffs") < finalizer.indexOf("await verifyCorePreviewRestore"));
  assert.ok(finalizer.indexOf("await verifyCorePreviewRestore") < finalizer.indexOf("annotateCorePreview(record"));
  assert.match(finalizer, /record.outcome === "passed" && !record.artifacts.some/);
  assert.match(finalizer, /if \(failure\) throw failure/);
  assert.doesNotMatch(finalizer, /setOutcome|record\.(?:outcome|summary)\s*=(?!=)/);
});

test("canceled or failed finalizer has default-branch workflow-run and hourly recovery", () => {
  const recovery = read("workflows/core-preview-recovery.yml");
  assert.match(recovery, /workflows: \[PR change proof\]/);
  assert.match(recovery, /types: \[completed\]/);
  assert.match(recovery, /cron:/);
  assert.match(recovery, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.doesNotMatch(recovery, /pull_request.head.sha|download-artifact/);
  const presentation = read("workflows/evidence-review.yml");
  assert.match(presentation, /github.event.action == 'completed'/);
  // Publisher still waits for the whole workflow; only the Core check is faster.
  assert.match(presentation, /workflows: \[PR change proof\]/);
});
