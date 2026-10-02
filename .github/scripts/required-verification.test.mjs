import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CHECK, POLICY, digest, externalId, upstreamIdentity, validateReceipt, reconcile, summaryText } from './required-verification.mjs';
import { complete, optionalPublication, readBinding, requiredStatus } from './required-verification-controller.mjs';

const repo = 'sample-org/sample-project';
const sha = '1'.repeat(40);
const repository = { id: 10, full_name: repo };
test('verification workflows pin every setup-node action to an immutable commit', async () => {
  for (const workflow of ['required-verification.yml', 'evidence-review.yml', 'daytona-e2e.yml']) {
    const source = await readFile(new URL(`../workflows/${workflow}`, import.meta.url), 'utf8');
    const pins = [...source.matchAll(/uses:\s*actions\/setup-node@([^\s#]+)/g)].map(match => match[1]);
    assert.ok(pins.includes('49933ea5288caeca8642d1e84afbd3f7d6820020'), `${workflow}: expected verified v4 pin`);
    for (const pin of pins) assert.match(pin, /^[a-f0-9]{40}$/, `${workflow}: mutable setup-node reference`);
  }
});

const workflows = { upstream: { id: 20, path: '.github/workflows/warden.yml' }, producer: { id: 21, path: '.github/workflows/daytona-e2e.yml' } };
function fixture() {
  const current = { number: 7, state: 'open', base: { repo: repository }, head: { repo: repository, sha } };
  const upstream = { id: 30, run_attempt: 2, repository, head_repository: repository, workflow_id: 20, path: workflows.upstream.path,
    event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: sha,
    pull_requests: [{ number: 7, base: { repo: repository }, head: { repo: repository, sha } }] };
  const producer = { ...upstream, id: 31, run_attempt: 3, workflow_id: 21, path: workflows.producer.path, event: 'workflow_run',
    head_sha: '2'.repeat(40), html_url: `https://github.com/${repo}/actions/runs/31`, pull_requests: [] };
  const entry = { spec: 'session-history-status-paged.e2e.test.ts', name: 'history', placement: 'local', engine: 'v2' };
  const receipt = { version: 1, policy: POLICY, repo, pr: 7, sha, upstream: { id: 30, attempt: 2 }, producer: { id: 31, attempt: 3 },
    plan: { entries: [entry], manual: [{ spec: 'manual.e2e.test.ts' }], excluded: [{ spec: 'packaged.e2e.test.ts', reason: 'packaged binary' }], unresolved: [] } };
  const check = { name: CHECK, head_sha: sha, app: { slug: 'github-actions' }, external_id: externalId(receipt), details_url: producer.html_url,
    output: { text: `Receipt SHA256: ${digest(receipt)}` } };
  const job = { name: 'Journey — history', status: 'completed', conclusion: 'success', steps: [
    { name: 'Run user journey', conclusion: 'success' }, { name: 'Judge deferred vision claims', conclusion: 'success' }] };
  const result = { spec: entry.spec, sha, runId: 31, attempt: 3, summary: { command: 'evals:e2e', files: [entry.spec], placement: 'local', engine: 'v2', passed: 1, failed: 0, skipped: 0, verdict: 'passed' } };
  const context = { currentSha: sha, producer, jobs: [job], results: [result], trusted: true };
  return { current, upstream, producer, receipt, check, job, result, context };
}

test('smoke passed while required history journey waits is waiting, never passed', () => {
  const f = fixture();
  f.producer.status = 'in_progress';
  f.producer.conclusion = null;
  f.job.status = 'waiting'; f.job.conclusion = null;
  f.context.results = Array.from({ length: 12 }, (_, i) => ({ ...f.result, spec: `smoke-${i}.e2e.test.ts` }));
  const result = reconcile(f.receipt, f.context);
  assert.equal(result.state, 'waiting');
  assert.deepEqual(result.missing, [f.result.spec]);
  assert.match(summaryText(result, f.producer.html_url), /Selected evidence is separate/);
  f.job.status = 'in_progress';
  assert.equal(reconcile(f.receipt, f.context).state, 'running');
});

test('complete exact current required specs pass without inventing manual or excluded executions', () => {
  const f = fixture();
  validateReceipt(f.receipt, f.check, f.producer, f.upstream, f.current, workflows);
  assert.equal(reconcile(f.receipt, f.context).state, 'passed');
  delete f.receipt.plan.entries[0].engine;
  delete f.result.summary.engine;
  assert.equal(reconcile(f.receipt, f.context).state, 'passed');
});

test('a failed required job or assertion is failed, not selected-evidence success', () => {
  for (const change of [f => { f.job.conclusion = 'failure'; f.job.steps[0].conclusion = 'failure'; f.result.summary.failed = 1; },
    f => { f.result.summary.failed = 1; }, f => { f.job.steps[1].conclusion = 'failure'; f.result.vision = 'failure'; }]) {
    const f = fixture(); change(f);
    assert.equal(reconcile(f.receipt, f.context).state, 'failed');
  }
});

test('wrong SHA, engine, attempt, duplicate, skip, cancelled, absent and unresolved results cannot satisfy plan', () => {
  for (const change of [
    f => { f.result.sha = '2'.repeat(40); },
    f => { f.result.summary.engine = 'v1'; },
    f => { f.result.summary.placement = 'daytona'; },
    f => { f.result.attempt = 2; },
    f => { f.result.runId = 32; },
    f => { f.context.results.push(f.result); },
    f => { f.context.jobs.push(f.job); },
    f => { f.result.summary.skipped = 1; },
    f => { f.job.conclusion = 'cancelled'; },
    f => { f.job.conclusion = 'skipped'; },
    f => { f.job.conclusion = 'failure'; }, // Upload/setup failure is incomplete, not a failed test.
    f => { f.job.steps[1].conclusion = 'failure'; f.result.vision = 'not tested'; },
    f => { f.context.results = []; },
    f => { f.job.steps = []; },
    f => { f.receipt.plan.entries.push(f.receipt.plan.entries[0]); },
    f => { f.receipt.plan.unresolved.push('engine selection unresolved'); },
    f => { f.receipt.plan.entries[0].placement = undefined; },
    f => { f.context.trusted = false; },
    f => { f.producer.run_attempt++; },
    f => { f.producer.conclusion = 'cancelled'; },
    f => { f.context.currentSha = '3'.repeat(40); },
  ]) {
    const f = fixture(); change(f);
    assert.equal(reconcile(f.receipt, f.context).state, 'incomplete');
  }
});

test('Daytona requires exact sandbox SHA, not artifact-declared producer identity alone', () => {
  const f = fixture();
  f.receipt.plan.entries[0].placement = f.result.summary.placement = 'daytona';
  assert.equal(reconcile(f.receipt, f.context).state, 'incomplete');
  f.result.summary.sandboxSha = sha;
  assert.equal(reconcile(f.receipt, f.context).state, 'passed');
});

test('external associations, wrong workflows, new push and forged receipt endorsements fail closed', () => {
  for (const change of [
    f => { f.upstream.pull_requests[0].base = { repo: { id: 99 } }; },
    f => { f.upstream.pull_requests.push(f.upstream.pull_requests[0]); },
    f => { f.upstream.event = 'workflow_run'; },
    f => { f.upstream.workflow_id = 99; },
    f => { f.upstream.run_attempt++; },
    f => { f.producer.run_attempt++; },
    f => { f.producer.head_repository = { id: 99, full_name: 'other/project' }; },
    f => { f.producer.path = '.github/workflows/other.yml'; },
    f => { f.current.head.sha = '3'.repeat(40); },
    f => { f.check.app.slug = 'untrusted'; },
    f => { f.check.external_id = 'required-v1:31:2'; },
    f => { f.check.details_url = 'https://example.invalid'; },
    f => { f.check.output.text = 'Receipt SHA256: forged'; },
    f => { f.receipt.plan.entries = []; },
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => validateReceipt(f.receipt, f.check, f.producer, f.upstream, f.current, workflows));
  }
});

test('only the single validated same-base upstream association is used, never chained PR stubs', () => {
  const f = fixture();
  f.upstream.pull_requests.unshift({ number: 99, base: { repo: { id: 999 } } });
  f.producer.pull_requests = [{ number: 99, base: { repo: { id: 999 } } }];
  assert.deepEqual(upstreamIdentity(f.upstream, repo, workflows.upstream, f.current), { pr: 7, sha });
  validateReceipt(f.receipt, f.check, f.producer, f.upstream, f.current, workflows);
});

test('optional comment/storage failure cannot manufacture a pass or test failure', async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    if (failed) f.result.summary.failed = 1;
    const before = reconcile(f.receipt, f.context);
    await optionalPublication(async () => { throw new Error('optional storage unavailable'); });
    assert.deepEqual(reconcile(f.receipt, f.context), before);
  }
});

test('credentialed controllers use default-branch code; evidence publishing is independent', async () => {
  const producer = await readFile(new URL('../workflows/daytona-e2e.yml', import.meta.url), 'utf8');
  const publisher = await readFile(new URL('../workflows/evidence-review.yml', import.meta.url), 'utf8');
  const contracts = await readFile(new URL('../workflows/required-verification.yml', import.meta.url), 'utf8');
  const authorization = producer.split('  authorize:')[1].split('  plan:')[0];
  assert.match(authorization, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.doesNotMatch(authorization, /pnpm|npm|environment:|secrets\./);
  assert.doesNotMatch(producer, /pull_requests\[0\]/);
  assert.match(authorization, /internalContributor: \$\{\{ steps.authorize.outputs.internalContributor \}\}/);
  const journeyEnvironments = producer.split("\n").filter(line => line.trim().startsWith("environment:"));
  assert.equal(journeyEnvironments.length, 2);
  for (const environment of journeyEnvironments) {
    assert.ok(environment.includes("github.event_name == 'workflow_run'"));
    assert.ok(environment.includes("needs.authorize.outputs.internalContributor == 'true' && 'pr-internal-specs' || 'pr-slow-specs'"));
    assert.ok(environment.includes("|| 'scheduled-e2e-regression'"));
  }
  const gate = publisher.split('  required-verification:')[1].split('  check-publisher:')[0];
  assert.match(gate, /checks: write/);
  assert.doesNotMatch(gate, /OPENWORK_REVIEW_URL|BLOB|conclusion ==/);
  assert.match(publisher, /needs: required-verification[\s\S]*?if: >-\n      always\(\)/);
  assert.doesNotMatch(contracts, /secrets\.|checks: write|pull-requests: write|environment:/);
});

test('trusted completion lifecycle uses API provenance and attempt artifacts before updating check; publication failure is optional', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'required-controller-test-'));
  const previousPath = process.env.PATH;
  const statePath = join(directory, 'state.json');
  // A local, secret-free GitHub API double; never contacts GitHub or needs credentials.
  const stub = `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
let value;
if (args[0] === 'api') {
  const path = args[1].split('?')[0];
  if (args.includes('--input')) {
    const body = JSON.parse(readFileSync(0, 'utf8'));
    if (path.endsWith('/check-runs/40')) { state.check = { ...state.check, ...body }; state.writes.push(body); value = state.check; }
    else if (path.includes('/issues/')) process.exit(1);
    else throw new Error('Unexpected write');
  } else if (path.endsWith('/workflows/warden.yml')) value = state.workflows.upstream;
  else if (path.endsWith('/workflows/daytona-e2e.yml')) value = state.workflows.producer;
  else if (path.endsWith('/runs/31')) value = state.producer;
  else if (path.endsWith('/runs/30')) value = state.upstream;
  else if (path.endsWith('/pulls/7')) value = state.current;
  else if (path.endsWith('/check-runs/40')) value = state.check;
  else if (path.endsWith('/check-runs')) value = { check_runs: [state.check] };
  else if (path.endsWith('/attempts/3/jobs')) value = { jobs: state.jobs };
  else if (path.endsWith('/runs/31/artifacts')) value = { artifacts: state.artifacts };
  else if (path.endsWith('/issues/7/comments')) value = [];
  else throw new Error('Unexpected API path: ' + path);
} else if (args[0] === 'run' && args[1] === 'download') {
  const name = args[args.indexOf('--name') + 1];
  const destination = args[args.indexOf('--dir') + 1];
  mkdirSync(destination, { recursive: true });
  if (name === 'required-verification-3') writeFileSync(join(destination, 'required-verification.json'), JSON.stringify({ checkId: 40, receipt: state.receipt }));
  else writeFileSync(join(destination, 'journey-result.json'), JSON.stringify(state.result));
  value = null;
} else throw new Error('Unexpected command');
writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify(value));
`;
  await writeFile(join(directory, 'gh'), stub);
  await chmod(join(directory, 'gh'), 0o755);
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    for (const scenario of ['passed', 'waiting', 'cancelled', 'failed', 'stale', 'forged', 'old-artifact', 'no-authorization']) {
      const f = fixture();
      f.check.id = 40;
      f.check.status = 'in_progress';
      f.producer.run_started_at = '2026-01-01T00:00:00Z';
      const created_at = '2026-01-01T00:01:00Z';
      const state = { ...f, workflows, jobs: [{ name: 'Required verification authorization', conclusion: 'success' }, f.job], writes: [], artifacts: [
        { id: 50, name: 'required-verification-3', expired: false, created_at },
        { id: 51, name: `journey-result-3-${f.result.spec}`, expired: false, created_at },
      ] };
      if (scenario === 'waiting') { state.producer.status = 'in_progress'; state.job.status = 'waiting'; }
      if (scenario === 'cancelled') { state.producer.conclusion = 'cancelled'; state.job.conclusion = 'cancelled'; state.artifacts.pop(); }
      if (scenario === 'failed') { state.job.conclusion = 'failure'; state.job.steps[0].conclusion = 'failure'; state.result.summary.failed = 1; }
      if (scenario === 'stale') state.current.head.sha = '3'.repeat(40);
      if (scenario === 'forged') state.receipt.upstream.attempt = 1;
      if (scenario === 'old-artifact') state.artifacts[0].created_at = '2025-12-31T00:00:00Z';
      if (scenario === 'no-authorization') state.jobs.shift();
      await writeFile(statePath, JSON.stringify(state));
      if (scenario === 'waiting') {
        assert.equal((await requiredStatus(repo, 7, sha)).state, 'waiting');
        await assert.rejects(() => complete(repo, 31, 3), /completed chained producer/);
      } else if (['stale', 'forged', 'old-artifact', 'no-authorization'].includes(scenario)) {
        await assert.rejects(() => readBinding(repo, 31));
      } else {
        await assert.rejects(() => complete(repo, 31, 2), /Completion event attempt mismatch/);
        const result = await complete(repo, 31, 3);
        assert.equal(result.summary.state, scenario === 'cancelled' ? 'incomplete' : scenario);
        const saved = JSON.parse(await readFile(statePath, 'utf8'));
        assert.equal(saved.writes.length, 1);
        assert.equal(saved.check.conclusion, scenario === 'passed' ? 'success' : 'failure');
        assert.equal((await requiredStatus(repo, 7, sha)).state, result.summary.state);
      }
    }
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
