import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDecision, ciDecision, gateDecision, machineryFiles, parseTestCommand, unsignedCommits } from './contributor-pr.mjs';

const head = 'a'.repeat(40);
const base = { repo: { full_name: 'sample-org/sample-project', fork: false } };
const fork = { state: 'open', user: { type: 'User' }, base, head: { sha: head, repo: { full_name: 'someone/sample-project', fork: true } } };
const sameRepo = { ...fork, head: { sha: head, repo: base.repo } };
const commit = (email, message, sha = 'c'.repeat(40)) => ({ sha, parents: [{}], commit: { author: { email }, message } });
const signed = commit('dev@example.com', 'fix: thing\n\nSigned-off-by: Dev <dev@example.com>');
const unsigned = commit('dev@example.com', 'fix: thing', 'd'.repeat(40));
const file = (filename) => ({ filename });

test('a commit is signed off only by its own author', () => {
  assert.deepEqual(unsignedCommits([signed]), []);
  assert.deepEqual(unsignedCommits([unsigned]), [unsigned.sha]);
  assert.deepEqual(unsignedCommits([commit('dev@example.com', 'x\n\nSigned-off-by: Other <other@example.com>')]).length, 1);
  assert.deepEqual(unsignedCommits([commit('Dev@Example.com', 'x\n\nSigned-off-by: Dev <dev@example.com>')]), []);
});

test("the author's own GitHub noreply address counts as their sign-off", () => {
  const noreply = 'x\n\nSigned-off-by: Dev <123+dev-user@users.noreply.github.com>';
  assert.deepEqual(unsignedCommits([{ ...commit('dev@example.com', noreply), author: { login: 'Dev-User' } }]), []);
  assert.equal(unsignedCommits([{ ...commit('dev@example.com', noreply), author: { login: 'someone-else' } }]).length, 1);
  assert.equal(unsignedCommits([commit('dev@example.com', noreply)]).length, 1);
});

test('merge commits are not checked for sign-off', () => {
  assert.deepEqual(unsignedCommits([{ ...unsigned, parents: [{}, {}] }]), []);
});

test('CI and agent configuration counts as review machinery, including renames', () => {
  assert.deepEqual(machineryFiles([file('.github/workflows/ci-tests.yml'), file('apps/desktop/src/a.ts')]), ['.github/workflows/ci-tests.yml']);
  assert.deepEqual(machineryFiles([{ filename: 'docs/x.md', previous_filename: '.opencode/skills/a/SKILL.md' }]), ['.opencode/skills/a/SKILL.md']);
  assert.deepEqual(machineryFiles([file('warden.toml'), file('opencode.json'), file('.claude/skills/x.md')]).length, 3);
});

test('/test parses an optional commit and ignores anything else', () => {
  assert.deepEqual(parseTestCommand('/test'), { sha: null });
  assert.deepEqual(parseTestCommand('  /test ABCDEF1234\nthanks'), { sha: 'abcdef1234' });
  assert.equal(parseTestCommand('please /test'), null);
  assert.equal(parseTestCommand('/test abc'), null);
  assert.equal(parseTestCommand('/testing'), null);
});

test('gate: same-repo PRs pass with sign-off, forks wait for a maintainer', () => {
  assert.equal(gateDecision({ pr: sameRepo, commits: [signed], files: [] }).state, 'success');
  assert.equal(gateDecision({ pr: sameRepo, commits: [signed, unsigned], files: [] }).state, 'failure');
  const waiting = gateDecision({ pr: fork, commits: [signed], files: [file('ee/a.ts')] });
  assert.equal(waiting.state, 'pending');
  assert.match(waiting.description, /\/test aaaaaaaaaa/);
  assert.equal(gateDecision({ pr: fork, commits: [signed], files: [file('.github/workflows/x.yml')] }).state, 'failure');
  assert.equal(gateDecision({ pr: sameRepo, commits: [signed], files: [file('.github/workflows/x.yml')] }).state, 'success');
  assert.equal(gateDecision({ pr: { ...fork, user: { type: 'Bot' } }, commits: [unsigned], files: [] }).state, 'success');
});

test('a fork whose repository was deleted is still a fork', () => {
  assert.equal(gateDecision({ pr: { ...fork, head: { sha: head, repo: null } }, commits: [signed], files: [] }).state, 'pending');
});

test('authorize: only maintainers, only forks, only the reviewed head', () => {
  const input = { permission: 'write', pr: fork, commits: [signed], files: [], command: { sha: head.slice(0, 7) } };
  assert.deepEqual(authorizeDecision(input), { ok: true, sha: head });
  assert.equal(authorizeDecision({ ...input, permission: 'read' }).ok, false);
  assert.equal(authorizeDecision({ ...input, permission: 'triage' }).ok, false);
  assert.equal(authorizeDecision({ ...input, pr: sameRepo }).ok, false);
  assert.equal(authorizeDecision({ ...input, pr: { ...fork, state: 'closed' } }).ok, false);
  assert.match(authorizeDecision({ ...input, command: { sha: null } }).reply, /\/test aaaaaaaaaa/);
  assert.match(authorizeDecision({ ...input, command: { sha: 'bbbbbbb' } }).reply, /head is now/);
  assert.match(authorizeDecision({ ...input, commits: [unsigned] }).reply, /Signed-off-by/);
  assert.match(authorizeDecision({ ...input, files: [file('.github/x.yml')] }).reply, /carry/);
});

test('CI decision uses the newest Actions run of the required check', () => {
  const run = (conclusion, started_at, extra = {}) => ({ name: 'openwork-tests-required', app: { slug: 'github-actions' }, status: 'completed', conclusion, started_at, ...extra });
  assert.deepEqual(ciDecision([]), { done: false });
  assert.deepEqual(ciDecision([run(null, '2026-10-07T10:00:00Z', { status: 'in_progress' })]), { done: false });
  assert.equal(ciDecision([run('failure', '2026-10-07T09:00:00Z'), run('success', '2026-10-07T10:00:00Z')]).state, 'success');
  assert.equal(ciDecision([run('success', '2026-10-07T09:00:00Z'), run('failure', '2026-10-07T10:00:00Z')]).state, 'failure');
  assert.deepEqual(ciDecision([run('success', '2026-10-07T10:00:00Z', { app: { slug: 'some-other-app' } })]), { done: false });
});
