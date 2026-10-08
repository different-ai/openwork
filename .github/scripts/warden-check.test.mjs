import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedAtHead, checkRunBody, CHECK_NAME } from './warden-check.mjs';

const sha = 'a'.repeat(40);

test('a clear verdict is a successful warden-clear check on that commit', () => {
  const body = checkRunBody({ sha, verdict: 'clear', detailsUrl: 'https://example.test/run' });
  assert.equal(body.name, CHECK_NAME);
  assert.equal(body.head_sha, sha);
  assert.equal(body.status, 'completed');
  assert.equal(body.conclusion, 'success');
  assert.equal(body.details_url, 'https://example.test/run');
});

test('anything other than clear fails, with a reason a person can act on', () => {
  for (const [reason, text] of [
    ['changes-warden', /admin merges/],
    ['confidentiality-findings', /confidentiality/],
    ['major-security-findings', /high or medium/],
    ['review-incomplete', /didn't finish/],
    ['flagged', /flagged/],
    ['analysis-cancelled', /analysis-cancelled/],
  ]) {
    const body = checkRunBody({ sha, verdict: 'flagged', reason });
    assert.equal(body.conclusion, 'failure', reason);
    assert.match(body.output.summary, text, reason);
  }
  assert.equal(checkRunBody({ sha, verdict: undefined }).conclusion, 'failure');
});

test('backfill only trusts a diff-warden approval of the exact current head', () => {
  const bot = 'diff-warden[bot]';
  assert.equal(approvedAtHead([{ user: { login: bot }, state: 'APPROVED', commit_id: sha }], bot, sha), true);
  assert.equal(approvedAtHead([{ user: { login: bot }, state: 'APPROVED', commit_id: 'b'.repeat(40) }], bot, sha), false);
  assert.equal(approvedAtHead([{ user: { login: bot }, state: 'DISMISSED', commit_id: sha }], bot, sha), false);
  assert.equal(approvedAtHead([{ user: { login: 'someone' }, state: 'APPROVED', commit_id: sha }], bot, sha), false);
});
