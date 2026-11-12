import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { WORKFLOW, trusted, notification, fullBuildSucceeded, findStateArtifact, loadJobs, deliver } from './notify-alpha.mjs';

const channel = 'release-channel-from-variable';
const run = (number = 10, attempt = 1, conclusion = 'failure') => ({
  id: number + 1000, name: WORKFLOW, run_number: number, run_attempt: attempt,
  head_sha: number.toString(16).padStart(40, '0'), event: 'push', head_branch: 'dev',
  head_repository: { full_name: 'different-ai/openwork' }, status: 'completed', conclusion,
  html_url: `https://github.com/different-ai/openwork/actions/runs/${number + 1000}`,
});
const failure = (name = 'Build alpha (aarch64-apple-darwin)', step = 'Install dependencies') => ({
  name, conclusion: 'failure', steps: [{ name: step, conclusion: 'failure' }],
});
const success = (name, steps = []) => ({ name, conclusion: 'success', steps: steps.map(name => ({ name, conclusion: 'success' })) });
const greenJobs = () => [
  success('Detect desktop build inputs'), success('packaged-smoke / Build and boot the desktop app'),
  success('Build alpha (aarch64-apple-darwin)', ['Build Electron alpha app', 'Package Electron alpha (macOS, signed + notarized)']),
  success('Publish alpha (aarch64-apple-darwin)'),
  success('Build + Publish alpha (x86_64-pc-windows-msvc)', ['Build Electron alpha app', 'Package Electron alpha (Windows x64)']),
];
const decide = (previous, current = run(), jobs = [failure()]) => notification(previous, current, jobs, channel);

test('first failure includes observed SHA, attempt run link, job and step without causal claim', () => {
  const result = decide();
  assert.match(result.message.text, /First observed failed SHA: 000000000000000000000000000000000000000a/);
  assert.match(result.message.text, /runs\/1010\/attempts\/1/);
  assert.match(result.message.text, /Job: Build alpha/);
  assert.match(result.message.text, /Step: Install dependencies/);
  assert.match(result.message.text, /not a determination of the causal regression/);
  assert.equal(Object.keys(result.state.failures).length, 1);
});

test('same signature stays silent on a subsequent push, exact duplicate and rerun; retains first observation', () => {
  const first = decide();
  const repeated = decide(first.state, run(11));
  const rerun = decide(repeated.state, run(11, 2));
  assert.equal(repeated.message, null);
  assert.equal(rerun.message, null);
  assert.equal(decide(rerun.state, run(11, 2)).message, null);
  assert.deepEqual(Object.values(rerun.state.failures), Object.values(first.state.failures));
});

test('new job/step signature alerts once without repeating existing failures', () => {
  const first = decide();
  const next = decide(first.state, run(11), [failure(), failure('Windows', 'Sign')]);
  assert.match(next.message.text, /Job: Windows/);
  assert.doesNotMatch(next.message.text, /Step: Install dependencies/);
  assert.equal(Object.keys(next.state.failures).length, 2);
  assert.equal(decide(next.state, run(12), [failure('Windows', 'Sign')]).message, null);
  assert.ok(decide(next.state, run(12), [failure('Windows', 'Package')]).message);
});

test('green skipped-only workflow does not recover or hide older failing completion', () => {
  const skipped = [success('Detect desktop build inputs'), { name: 'Build alpha (aarch64-apple-darwin)', conclusion: 'skipped' }];
  const first = decide();
  const noOp = decide(first.state, run(12, 1, 'success'), skipped);
  assert.equal(noOp.message, null);
  assert.deepEqual(noOp.state.failures, first.state.failures);
  const initialNoOp = decide(undefined, run(12, 1, 'success'), skipped);
  assert.ok(decide(initialNoOp.state, run(11)).message);
});

test('recovery requires actual successful build and package steps on both lanes', () => {
  const first = decide();
  assert.equal(fullBuildSucceeded(run(11, 1, 'success'), greenJobs()), true);
  const recovered = decide(first.state, run(11, 1, 'success'), greenJobs());
  assert.match(recovered.message.text, /recovered/);
  assert.deepEqual(recovered.state.failures, {});
  assert.equal(decide(recovered.state, run(12, 1, 'success'), greenJobs()).message, null);
  assert.ok(decide(recovered.state, run(12)).message, 'same signature alerts again after verified recovery');
  for (const jobs of [greenJobs().slice(0, -1), [success('Windows')], greenJobs().map(job => ({ ...job, steps: [] }))]) {
    const partial = decide(first.state, run(11, 2, 'success'), jobs);
    assert.equal(partial.message, null);
    assert.deepEqual(partial.state.failures, first.state.failures);
  }
});

test('successful job with skipped packaging step and failed workflow cannot recover', () => {
  const first = decide();
  const jobs = greenJobs();
  jobs.at(-1).steps.at(-1).conclusion = 'skipped';
  assert.equal(decide(first.state, run(11, 1, 'success'), jobs).message, null);
  assert.equal(decide(first.state, run(11, 1, 'failure'), greenJobs()).message, null);
});

test('out-of-order old failure cannot reopen after newer verified recovery', () => {
  const recovered = decide(decide().state, run(12, 1, 'success'), greenJobs());
  const old = decide(recovered.state, run(11, 9), [failure('Other job', 'New step')]);
  assert.equal(old.message, null);
  assert.deepEqual(old.state, recovered.state);
});

test('out-of-order old green cannot clear newer failure, old same-job failure cannot replace new evidence', () => {
  const recent = decide(undefined, run(12));
  const oldGreen = decide(recent.state, run(11, 1, 'success'), greenJobs());
  assert.equal(oldGreen.message, null);
  assert.deepEqual(oldGreen.state.failures, recent.state.failures);
  assert.equal(decide(recent.state, run(11), [failure(undefined, 'Old different step')]).message, null);
});

test('late failure in a lane skipped by newer observation is still observed', () => {
  const recent = decide(undefined, run(12), [failure('Windows', 'Sign')]);
  assert.ok(decide(recent.state, run(11), [failure('Mac', 'Package')]).message);
});

test('trusted gate rejects forks, PRs, manual dispatches, other branches and workflows', () => {
  assert.equal(trusted(run(), 'different-ai/openwork'), true);
  for (const change of [
    { event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'main' },
    { name: 'Another workflow' }, { status: 'in_progress' },
    { head_repository: { full_name: 'fork/openwork' } }, { html_url: 'https://example.com' },
  ]) assert.equal(trusted({ ...run(), ...change }, 'different-ai/openwork'), false);
  assert.equal(trusted(run(), 'fork/openwork'), false);
});

test('select newest uploaded trusted state, not highest producer run number; reject PR impostor', async () => {
  const artifacts = [{ id: 3, workflow_run: { id: 11 } }, { id: 5, workflow_run: { id: 9 } }, { id: 6, workflow_run: { id: 8 } }];
  const self = { workflow_id: 42, head_repository: { full_name: 'different-ai/openwork' } };
  const selected = await findStateArtifact(artifacts, self, 20, async id => ({
    ...self, status: 'completed', conclusion: 'success', event: id === 8 ? 'pull_request' : 'workflow_run',
  }));
  assert.equal(selected.id, 5);
  assert.equal((await findStateArtifact(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, workflow_run: { id: i + 1 } })), self, 200,
    async () => ({ ...self, status: 'completed', conclusion: 'success', event: 'workflow_run' }))).id, 100);
});

test('API evidence is bounded and truncation fails closed', async () => {
  await assert.rejects(loadJobs(async () => ({ total_count: 301, jobs: [] })), /safety bound/);
  let pages = 0;
  await assert.rejects(loadJobs(async () => { pages++; return { total_count: 200, jobs: [] }; }), /Incomplete/);
  assert.equal(pages, 3);
  let requests = 0;
  await assert.rejects(findStateArtifact(Array.from({ length: 30 }, (_, id) => ({ id, workflow_run: { id } })), {}, -1,
    async () => { requests++; return {}; }), /bound exceeded/);
  assert.equal(requests, 20);
});

test('Slack delivery validates response and quiet runs make no request', async () => {
  const first = decide();
  let payload;
  await deliver(first, { token: 'test', channel, request: async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, ts: '123.4' }) };
  } });
  assert.equal(payload.channel, channel);
  assert.equal(payload.unfurl_links, false);
  await assert.rejects(deliver(first, { token: 'test', channel, request: async () => ({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) }) }), /not_in_channel/);
  await deliver(decide(first.state, run(11)), { request: async () => { throw new Error('must not post'); } });
});

test('workflow uses default-branch observer and existing release channel without adding premerge checks', async () => {
  const workflow = await readFile(new URL('../workflows/alpha-failure-alerts.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /vars\.SLACK_RELEASE_CHANNEL_ID/);
  assert.doesNotMatch(workflow, /ref:|pull_request:|SLACK_TEST_ALERT/);
  assert.match(workflow, /head_repository\.full_name == github.repository/);
});
