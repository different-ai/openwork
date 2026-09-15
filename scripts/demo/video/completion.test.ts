import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredClaims, validateCompletion, verifyCompletedMedia } from './completion.ts';

// Schema-only fixtures, never rendered or presented as an actual C run or capture.
function fixture() {
  const gitSha = '1'.repeat(40);
  return {
    runId: 'schema-only-run', runName: 'schema-only-test', runnerSha256: '2'.repeat(64), claimsSha256: '3'.repeat(64),
    runner: { name: 'schema-only-test', dir: '/schema-only/schema-only-run', gitSha,
      createdAt: '2026-09-15T01:00:00.000Z', closedAt: '2026-09-15T01:01:00.000Z', outcome: 'passed',
      summary: { ok: true, totalArtifacts: 1, unvalidatedArtifacts: 0, failedArtifacts: 0, failedExpectations: 0, pendingArtifacts: 0, pendingJudgments: 0, passedExpectations: 1 },
      steps: [{ name: 'Schema step', ok: true }],
      artifacts: [{ ok: true, results: [{ passed: true }], judgments: [{ state: 'passed' }] }],
    },
    claims: { buildKind: 'release-source', desktopVersion: '0.18.46', desktopTag: 'v0.18.46', releaseSha: '4'.repeat(40),
      overlaySha: gitSha, lane: 'local-release-source', denBuildIdentity: 'Schema only',
      claims: requiredClaims.map((claim) => ({ claim, status: 'Passed', detail: 'Schema fixture, not evidence' })),
    },
    binding: { finalized: true, runId: 'schema-only-run', runName: 'schema-only-test', gitSha,
      exitCode: 0, passedTests: 1, failedTests: 0, skippedTests: 0,
      runnerSha256: '2'.repeat(64), claimsSha256: '3'.repeat(64),
      media: [{ kind: 'png', sha256: '5'.repeat(64) }, { kind: 'cdp-capture', sha256: '6'.repeat(64) }],
    },
  };
}

test('canonical ten claims need finalized runner and exact run/hash binding', () => {
  assert.equal(requiredClaims.length, 10);
  assert.equal(validateCompletion(fixture()).claims.claims.length, 10);
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => { value.runner.closedAt = ''; },
    (value: ReturnType<typeof fixture>) => { value.runner.outcome = 'failed'; },
    (value: ReturnType<typeof fixture>) => { value.binding.finalized = false; },
    (value: ReturnType<typeof fixture>) => { value.binding.exitCode = 1; },
    (value: ReturnType<typeof fixture>) => { value.binding.skippedTests = 1; },
    (value: ReturnType<typeof fixture>) => { value.binding.passedTests = 0; },
    (value: ReturnType<typeof fixture>) => { value.binding.failedTests = 1; },
    (value: ReturnType<typeof fixture>) => { value.binding.runName = 'other-run'; },
    (value: ReturnType<typeof fixture>) => { value.runner.dir = '/other/run'; },
    (value: ReturnType<typeof fixture>) => { value.binding.runnerSha256 = '7'.repeat(64); },
    (value: ReturnType<typeof fixture>) => { value.binding.claimsSha256 = '7'.repeat(64); },
    (value: ReturnType<typeof fixture>) => { value.claims.overlaySha = '7'.repeat(40); },
    (value: ReturnType<typeof fixture>) => { value.runner.summary.failedExpectations = 1; },
    (value: ReturnType<typeof fixture>) => { value.runner.steps[0].ok = false; },
    (value: ReturnType<typeof fixture>) => { value.runner.artifacts[0].results[0].passed = false; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateCompletion(value));
  }
});

test('completed assertion-only runners may include unjudged supplementary captures without rewriting evidence', () => {
  const base = fixture();
  const value = { ...base, runner: { ...base.runner, steps: [],
    summary: { ...base.runner.summary, ok: false, totalArtifacts: 2, unvalidatedArtifacts: 1 },
    artifacts: [...base.runner.artifacts, { ok: null, results: [], judgments: [] }],
  } };
  assert.equal(validateCompletion(value).runner.outcome, 'passed');
  assert.throws(() => validateCompletion({ ...value, runner: { ...value.runner, outcome: 'failed' } }));
  for (const summary of [
    { ...value.runner.summary, unvalidatedArtifacts: 0 },
    { ...value.runner.summary, totalArtifacts: 3 },
    { ...value.runner.summary, passedExpectations: 0 },
    { ...value.runner.summary, passedExpectations: 2 },
    { ...value.runner.summary, pendingJudgments: 1 },
    { ...value.runner.summary, failedArtifacts: 1 },
  ]) assert.throws(() => validateCompletion({ ...value, runner: { ...value.runner, summary } }));
  assert.throws(() => validateCompletion({ ...value, runner: { ...value.runner,
    artifacts: [...base.runner.artifacts, { ok: null, results: [{ passed: true }], judgments: [] }],
  } }));
});

test('subset, duplicate, failed, blocked, empty-detail and unknown claims never authorize complete mode', () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => { value.claims.claims.pop(); },
    (value: ReturnType<typeof fixture>) => { value.claims.claims[1] = value.claims.claims[0]; },
    (value: ReturnType<typeof fixture>) => { value.claims.claims[0].status = 'Failed'; },
    (value: ReturnType<typeof fixture>) => { value.claims.claims[0].status = 'Blocked'; },
    (value: ReturnType<typeof fixture>) => { value.claims.claims[0].detail = ''; },
    (value: ReturnType<typeof fixture>) => { value.claims.claims[0].claim = 'Only selected scenes passed'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateCompletion(value));
  }
});

test('complete media must be from the bound run, including derived CDP hash chain', () => {
  const { binding } = validateCompletion(fixture());
  verifyCompletedMedia(binding, { kind: 'png', sha256: '5'.repeat(64) });
  assert.throws(() => verifyCompletedMedia(binding, { kind: 'png', sha256: '9'.repeat(64) }));
  const derivedReceipt = { format: 'cdp-screencast-derived-mp4', captureSha256: '6'.repeat(64), outputSha256: '8'.repeat(64) };
  verifyCompletedMedia(binding, { kind: 'clip', sha256: '8'.repeat(64), derivedReceipt });
  assert.throws(() => verifyCompletedMedia(binding, { kind: 'clip', sha256: '8'.repeat(64) }));
  assert.throws(() => verifyCompletedMedia(binding, { kind: 'clip', sha256: '9'.repeat(64), derivedReceipt }));
  assert.throws(() => verifyCompletedMedia(binding, { kind: 'clip', sha256: '8'.repeat(64),
    derivedReceipt: { ...derivedReceipt, captureSha256: '9'.repeat(64) } }));
});
