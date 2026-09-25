import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("checkpoint proof has one protected gate; unit prerequisites cannot block it on old heads", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/evidence-checkpoint-proof.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|workflow_dispatch:|secrets\.|environment: pr-slow-specs/);
  assert.equal((workflow.match(/ref: \$\{\{ github.event.pull_request.head.sha \}\}/g) ?? []).length, 1);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /install --frozen-lockfile --ignore-scripts/);
  const proof = await readFile(new URL("../../../.github/workflows/pr-proof.yml", import.meta.url), "utf8");
  const checkpoint = proof.split("\n  checkpoint-proof:\n")[1].split("\n  windows-proof:\n")[0];
  assert.match(checkpoint, /environment: pr-slow-specs/);
  assert.match(checkpoint, /head.repo.id == github.event.repository.id/);
  assert.match(checkpoint, /head.repo.fork == false/);
  assert.match(checkpoint, /triggering_actor != 'dependabot\[bot\]'/);
  assert.match(checkpoint, /node scripts\/prove-freestyle-checkpoints.ts/);
  assert.match(checkpoint, /FREESTYLE_API_KEY: \$\{\{ secrets.FREESTYLE_API_KEY \}\}/);
  assert.doesNotMatch(checkpoint, /infisical|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  const probe = await readFile(new URL("../src/checkpoint-probe.ts", import.meta.url), "utf8");
  assert.doesNotMatch(probe, /process.env/);
  assert.match(probe, /firewall: \{ rules: \[\] \}/);
  assert.match(probe, /ttlSeconds: 900/);
  assert.match(probe, /ttlSeconds: 1800/);
});
