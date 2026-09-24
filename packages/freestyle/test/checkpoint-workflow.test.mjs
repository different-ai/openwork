import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live checkpoint prerequisite uses the PR head, protected approval, and no guest credentials", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/evidence-checkpoint-proof.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|workflow_dispatch:/);
  assert.equal((workflow.match(/ref: \$\{\{ github.event.pull_request.head.sha \}\}/g) ?? []).length, 2);
  assert.match(workflow, /environment: pr-slow-specs/);
  assert.match(workflow, /head.repo.id == github.event.repository.id/);
  assert.match(workflow, /head.repo.fork == false/);
  assert.match(workflow, /triggering_actor != 'dependabot\[bot\]'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /install --frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /FREESTYLE_API_KEY: \$\{\{ secrets.FREESTYLE_API_KEY \}\}/);
  assert.doesNotMatch(workflow, /infisical|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  const probe = await readFile(new URL("../src/checkpoint-probe.ts", import.meta.url), "utf8");
  assert.doesNotMatch(probe, /process.env/);
  assert.match(probe, /firewall: \{ rules: \[\] \}/);
  assert.match(probe, /ttlSeconds: 900/);
  assert.match(probe, /ttlSeconds: 1800/);
});
