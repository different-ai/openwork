import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("checkpoint proof uses contributor-aware approval; unit prerequisites cannot block old heads", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/evidence-checkpoint-proof.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|workflow_dispatch:|secrets\.|^\s+environment:/m);
  assert.equal((workflow.match(/ref: \$\{\{ github.event.pull_request.head.sha \}\}/g) ?? []).length, 1);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /install --frozen-lockfile --ignore-scripts/);
  const proof = await readFile(new URL("../../../.github/workflows/pr-proof.yml", import.meta.url), "utf8");
  const checkpoint = proof.split("\n  checkpoint-proof:\n")[1].split("\n  windows-proof:\n")[0];
  const gate = checkpoint.split("    steps:\n")[0];
  const environment = gate.match(/^    environment:\n      name: >-\n([\s\S]*?)(?=^    \S)/m);
  assert.ok(environment, "The environment must be selected before any PR code runs");
  assert.equal(environment[1].replace(/\s+/g, " ").trim(),
    `\${{ github.event.repository.owner.type == 'Organization' && github.event.pull_request.user.type == 'User' && contains(fromJSON('["MEMBER", "OWNER"]'), github.event.pull_request.author_association) && needs.select.outputs.internalContributor == 'true' && 'pr-internal-specs' || 'pr-slow-specs' }}`);
  for (const side of ["head", "base"]) {
    assert.ok(gate.includes(`github.event.pull_request.${side}.repo.full_name == github.repository`));
    assert.ok(gate.includes(`github.event.pull_request.${side}.repo.id == github.event.repository.id`));
    assert.ok(gate.includes(`github.event.pull_request.${side}.repo.fork == false`));
  }
  for (const actor of ["github.event.pull_request.user.login", "github.actor", "github.triggering_actor"]) {
    assert.ok(gate.includes(`${actor} != 'dependabot[bot]'`));
  }
  assert.match(checkpoint, /node scripts\/prove-freestyle-checkpoints.ts/);
  assert.match(checkpoint, /FREESTYLE_API_KEY: \$\{\{ secrets.FREESTYLE_API_KEY \}\}/);
  assert.doesNotMatch(checkpoint, /infisical|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  const probe = await readFile(new URL("../src/checkpoint-probe.ts", import.meta.url), "utf8");
  assert.doesNotMatch(probe, /process.env/);
  assert.match(probe, /firewall: \{ rules: \[\] \}/);
  assert.match(probe, /ttlSeconds: 900/);
  assert.match(probe, /ttlSeconds: 1800/);
});
