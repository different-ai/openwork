import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDecision, ciDecision, finalDecision, gateDecision, latestStatuses, machineryFiles, parseTestCommand } from './contributor-pr.mjs';

const head = 'a'.repeat(40);
const base = { repo: { full_name: 'sample-org/sample-project', fork: false } };
const fork = { state: 'open', user: { type: 'User' }, base, head: { sha: head, repo: { full_name: 'someone/sample-project', fork: true } } };
const sameRepo = { ...fork, head: { sha: head, repo: base.repo } };
const file = (filename) => ({ filename });

test('CI and agent configuration counts as review machinery, including renames', () => {
  assert.deepEqual(machineryFiles([file('.github/workflows/ci-tests.yml'), file('apps/desktop/src/a.ts')]), ['.github/workflows/ci-tests.yml']);
  assert.deepEqual(machineryFiles([{ filename: 'docs/x.md', previous_filename: '.opencode/skills/a/SKILL.md' }]), ['.opencode/skills/a/SKILL.md']);
  assert.equal(machineryFiles([file('warden.toml'), file('opencode.json'), file('.claude/skills/x.md')]).length, 3);
});

test('/test parses an optional commit and ignores anything else', () => {
  assert.deepEqual(parseTestCommand('/test'), { sha: null });
  assert.deepEqual(parseTestCommand('  /test ABCDEF1234\nthanks'), { sha: 'abcdef1234' });
  assert.equal(parseTestCommand('please /test'), null);
  assert.equal(parseTestCommand('/test abc'), null);
  assert.equal(parseTestCommand('/testing'), null);
});

test('gate: same-repo and bot PRs pass, forks wait for a maintainer, no sign-off needed', () => {
  assert.deepEqual(gateDecision({ pr: sameRepo, files: [] }), { state: 'success', description: 'Pull request from this repository' });
  assert.equal(gateDecision({ pr: sameRepo, files: [file('.github/workflows/x.yml')] }).state, 'success');
  assert.equal(gateDecision({ pr: fork, files: [file('ee/a.ts')] }).state, 'pending');
  assert.equal(gateDecision({ pr: fork, files: [file('.github/workflows/x.yml')] }).state, 'failure');
  assert.equal(gateDecision({ pr: { ...fork, user: { type: 'Bot' } }, files: [] }).state, 'success');
  assert.equal(gateDecision({ pr: { ...fork, head: { sha: head, repo: null } }, files: [] }).state, 'pending');
});

test('authorize: only maintainers, only forks, only the reviewed head, only after the screen', () => {
  const screen = { state: 'pending', description: 'Held for maintainer review: database changes' };
  const input = { permission: 'write', pr: fork, files: [], command: { sha: head.slice(0, 7) }, screen };
  assert.deepEqual(authorizeDecision(input), { ok: true, sha: head });
  assert.equal(authorizeDecision({ ...input, permission: 'read' }).ok, false);
  assert.equal(authorizeDecision({ ...input, permission: 'triage' }).ok, false);
  assert.equal(authorizeDecision({ ...input, pr: sameRepo }).ok, false);
  assert.equal(authorizeDecision({ ...input, pr: { ...fork, state: 'closed' } }).ok, false);
  assert.match(authorizeDecision({ ...input, command: { sha: 'bbbbbbb' } }).reply, /head is now/);
  assert.match(authorizeDecision({ ...input, files: [file('.github/x.yml')] }).reply, /carry/);
  assert.match(authorizeDecision({ ...input, screen: undefined }).reply, /hasn't finished/);
  assert.match(authorizeDecision({ ...input, screen: { state: 'failure', description: 'Blocked: 1 hidden character' } }).reply, /blocked/);
});

test('plain /test binds the head only if it was pushed before the comment', () => {
  const input = { permission: 'write', pr: fork, files: [], command: { sha: null }, screen: { state: 'success' } };
  assert.deepEqual(authorizeDecision({ ...input, pushedAt: '2026-10-07T10:00:00Z', commentedAt: '2026-10-07T10:05:00Z' }), { ok: true, sha: head });
  assert.match(authorizeDecision({ ...input, pushedAt: '2026-10-07T10:06:00Z', commentedAt: '2026-10-07T10:05:00Z' }).reply, /after your comment/);
  assert.equal(authorizeDecision({ ...input, pushedAt: undefined, commentedAt: '2026-10-07T10:05:00Z' }).ok, false);
});

test('CI decision uses the newest Actions run of the required check', () => {
  const run = (conclusion, started_at, extra = {}) => ({ name: 'openwork-tests-required', app: { slug: 'github-actions' }, status: 'completed', conclusion, started_at, ...extra });
  assert.deepEqual(ciDecision([]), { done: false });
  assert.deepEqual(ciDecision([run(null, '2026-10-07T10:00:00Z', { status: 'in_progress' })]), { done: false });
  assert.equal(ciDecision([run('failure', '2026-10-07T09:00:00Z'), run('success', '2026-10-07T10:00:00Z')]).success, true);
  assert.equal(ciDecision([run('success', '2026-10-07T09:00:00Z'), run('failure', '2026-10-07T10:00:00Z')]).success, false);
  assert.deepEqual(ciDecision([run('success', '2026-10-07T10:00:00Z', { app: { slug: 'some-other-app' } })]), { done: false });
});

test('the required status passes only when screen, Warden and tests all pass', () => {
  const ci = { done: true, success: true };
  const clear = { state: 'success' };
  assert.equal(finalDecision({ ci, warden: clear, screen: { state: 'success' } }).state, 'success');
  assert.equal(finalDecision({ ci, warden: clear, screen: { state: 'pending' } }).state, 'success');
  assert.equal(finalDecision({ ci, warden: clear, screen: { state: 'failure', description: 'x' } }).state, 'failure');
  assert.equal(finalDecision({ ci, warden: { state: 'failure', description: 'x' }, screen: { state: 'success' } }).state, 'failure');
  assert.equal(finalDecision({ ci: { done: true, success: false, conclusion: 'failure' }, warden: clear, screen: { state: 'success' } }).state, 'failure');
});

test('latest status per context wins', () => {
  const statuses = latestStatuses({ statuses: [
    { context: 'contributor-pr/screen', state: 'pending', updated_at: '2026-10-07T10:00:00Z' },
    { context: 'contributor-pr/screen', state: 'success', updated_at: '2026-10-07T10:01:00Z' },
  ] });
  assert.equal(statuses['contributor-pr/screen'].state, 'success');
});
