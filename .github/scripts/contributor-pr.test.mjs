import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { authorizeDecision, isFork, latestStatuses, machineryFiles, parseTestCommand, runsForPr } from './contributor-pr.mjs';

const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const base = { ref: 'dev', sha: 'c'.repeat(40), repo: { full_name: 'sample-org/sample-project', fork: false } };
const fork = { number: 1, state: 'open', changed_files: 1, user: { type: 'User' }, base, head: { sha: head, repo: { full_name: 'sample-fork/sample-project', fork: true } } };
const sameRepo = { ...fork, head: { sha: head, repo: base.repo } };
const file = (filename) => ({ filename });
const input = { permission: 'write', pr: fork, files: [file('apps/a.ts')], command: { sha: head }, screen: { state: 'success' } };
const run = (extra = {}) => ({ id: 11, event: 'pull_request', head_sha: head, head_repository: fork.head.repo, pull_requests: [{ number: 1 }], created_at: '2026-10-07T10:00:00Z', status: 'action_required', ...extra });

test('CI and agent configuration includes deletions and renames', () => {
  assert.deepEqual(machineryFiles([file('.github/workflows/ci-tests.yml'), file('apps/a.ts')]), ['.github/workflows/ci-tests.yml']);
  assert.deepEqual(machineryFiles([{ filename: 'docs/x.md', previous_filename: '.opencode/skills/a/SKILL.md' }]), ['.opencode/skills/a/SKILL.md']);
  for (const path of ['warden.toml', 'opencode.json', 'opencode.jsonc', '.warden/x', '.agents/skills/x', '.claude/skills/x']) {
    assert.deepEqual(machineryFiles([file(path)]), [path]);
  }
});

test('fork bots and deleted fork repositories are not exempt; same repo has no contributor gate', () => {
  assert.equal(isFork(sameRepo), false);
  assert.equal(isFork({ ...fork, user: { type: 'Bot' } }), true);
  assert.equal(isFork({ ...fork, head: { sha: head, repo: null } }), true);
  assert.equal(authorizeDecision({ ...input, pr: sameRepo }).ok, false);
});

test('/test parses optional SHA and rejects other commands', () => {
  assert.deepEqual(parseTestCommand('/test'), { sha: null });
  assert.deepEqual(parseTestCommand('  /test ABCDEF1234\nthanks'), { sha: 'abcdef1234' });
  for (const command of ['please /test', '/test abc', '/testing', '/test deadbee extra']) assert.equal(parseTestCommand(command), null);
});

test('authorization requires maintainer, open dev fork, matching head and completed nonblocked free screen', () => {
  for (const permission of ['write', 'maintain', 'admin']) assert.deepEqual(authorizeDecision({ ...input, permission }), { ok: true, sha: head });
  for (const permission of ['read', 'triage', 'none']) assert.equal(authorizeDecision({ ...input, permission }).ok, false);
  assert.equal(authorizeDecision({ ...input, pr: { ...fork, state: 'closed' } }).ok, false);
  assert.equal(authorizeDecision({ ...input, pr: { ...fork, base: { ...base, ref: 'main' } } }).ok, false);
  assert.match(authorizeDecision({ ...input, command: { sha: nextHead } }).reply, /head is now/);
  assert.match(authorizeDecision({ ...input, command: { sha: head.slice(0, 7) } }).reply, /abbreviated SHAs/);
  assert.match(authorizeDecision({ ...input, files: [file('.github/x.yml')] }).reply, /carry/);
  assert.match(authorizeDecision({ ...input, screen: undefined }).reply, /hasn't finished/);
  for (const state of ['failure', 'error', 'unexpected']) assert.equal(authorizeDecision({ ...input, screen: { state } }).ok, false);
  assert.deepEqual(authorizeDecision({ ...input, screen: { state: 'pending' } }), { ok: true, sha: head });
});

test('plain /test fails closed on missing, malformed or newer push timestamps', () => {
  const plain = { ...input, command: { sha: null }, commentedAt: '2026-10-07T10:05:00Z' };
  assert.deepEqual(authorizeDecision({ ...plain, pushedAt: '2026-10-07T10:00:00Z' }), { ok: true, sha: head });
  for (const pushedAt of [undefined, 'invalid', '2026-10-07T10:06:00Z']) assert.equal(authorizeDecision({ ...plain, pushedAt }).ok, false);
  assert.equal(authorizeDecision({ ...plain, pushedAt: '2026-10-07T10:00:00Z', commentedAt: 'invalid' }).ok, false);
});

test('run selection excludes different SHA, repository, PR and event, and missing PR attribution', () => {
  assert.deepEqual(runsForPr([run(), run({ head_sha: nextHead }), run({ event: 'push' }), run({ pull_requests: [] }), run({ pull_requests: [{ number: 2 }] }), run({ head_repository: base.repo })], fork), [run()]);
});

test('latest status per context wins', () => {
  assert.equal(latestStatuses({ statuses: [
    { context: 'screen', state: 'pending', updated_at: '2026-10-07T10:00:00Z' },
    { context: 'screen', state: 'success', updated_at: '2026-10-07T10:01:00Z' },
  ] }).screen.state, 'success');
});

// Exercise the real CLI with an HTTP fixture, not just pure policy helpers.
async function cli(t, mode, handler, extraEnv = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams });
    const result = handler(url.pathname, req.method, calls, url.searchParams);
    res.writeHead(result === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result ?? { error: 'unexpected request' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'fork-gate-test-'));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true }); });
  const output = join(dir, 'output');
  let result;
  try {
    result = await promisify(execFile)(process.execPath, [new URL('./contributor-pr.mjs', import.meta.url).pathname, mode], {
      env: { ...process.env, GH_TOKEN: 'test-only', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: base.repo.full_name, GITHUB_RUN_ID: '123', GITHUB_OUTPUT: output, PR_NUMBER: '1', HEAD_SHA: head, COMMENT_BODY: `/test ${head}`, COMMENT_AUTHOR: 'test-maintainer', COMMENT_CREATED_AT: '2026-10-07T10:05:00Z', ...extraEnv },
      timeout: 10000,
    });
  } catch (error) { result = { code: error.code, stderr: error.stderr }; }
  return { ...result, calls, output: await readFile(output, 'utf8').catch(() => '') };
}

const prefix = `/repos/${base.repo.full_name}`;
function fixture(path) {
  if (path === `${prefix}/pulls/1`) return fork;
  if (path === `${prefix}/compare/${base.sha}...${head}`) return { files: [file('apps/a.ts')] };
  if (path.endsWith('/permission')) return { permission: 'write' };
  if (path === `${prefix}/actions/runs`) return { workflow_runs: [run()] };
  if (path.endsWith('/statuses')) return [{ context: 'contributor-pr/screen', state: 'success', updated_at: '2026-10-07T10:00:00Z' }];
  if (path.endsWith('/comments') || path.endsWith('/approve')) return {};
}

test('CLI same-repository /test is a read-only no-op', async (t) => {
  const result = await cli(t, 'authorize', () => sameRepo);
  assert.equal(result.code, undefined);
  assert.equal(result.output, '');
  assert.deepEqual(result.calls.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: `${prefix}/pulls/1` }]);
});

test('CLI /test binds the immutable comparison without custom status writes or App token', async (t) => {
  const result = await cli(t, 'authorize', fixture);
  assert.equal(result.code, undefined, result.stderr);
  assert.match(result.output, new RegExp(`sha=${head}`));
  assert.ok(result.calls.some((call) => call.path === `${prefix}/compare/${base.sha}...${head}`));
  assert.ok(!result.calls.some((call) => call.path.endsWith('/files')));
  assert.deepEqual(result.calls.filter((call) => call.method === 'POST').map((call) => call.path), [`${prefix}/issues/1/comments`]);
});

test('CLI refuses a push during metadata reads; nothing is authorized', async (t) => {
  let reads = 0;
  const result = await cli(t, 'authorize', (path) => path === `${prefix}/pulls/1` && ++reads === 3 ? { ...fork, head: { ...fork.head, sha: nextHead } } : fixture(path));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PR changed/);
  assert.equal(result.output, '');
  assert.ok(!result.calls.some((call) => call.method === 'POST'));
});

test('CLI refuses truncated/oversized comparisons instead of overlooking CI changes', async (t) => {
  const result = await cli(t, 'authorize', (path) => path.includes('/compare/') ? { files: Array.from({ length: 300 }, () => file('apps/a.ts')) } : fixture(path));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /oversized/);
  assert.equal(result.output, '');
});

test('CLI approves only exact reviewed PR run IDs and refuses a new head at start-tests', async (t) => {
  const result = await cli(t, 'approve-runs', (path) => path === `${prefix}/actions/runs` ? { workflow_runs: [run(), run({ id: 12, head_sha: nextHead }), run({ id: 13, pull_requests: [{ number: 2 }] }), run({ id: 14, status: 'completed' })] } : fixture(path));
  assert.equal(result.code, undefined, result.stderr);
  assert.deepEqual(result.calls.filter((call) => call.method === 'POST').map((call) => call.path), [`${prefix}/actions/runs/11/approve`]);
  const stale = await cli(t, 'approve-runs', fixture, { HEAD_SHA: nextHead });
  assert.equal(stale.code, 1);
  assert.ok(!stale.calls.some((call) => call.method === 'POST'));
});

test('CLI fork machinery is refused, including a rename out of the protected path', async (t) => {
  const result = await cli(t, 'authorize', (path) => path.includes('/compare/') ? { files: [{ filename: 'docs/x.md', previous_filename: '.github/workflows/x.yml' }] } : fixture(path));
  assert.equal(result.output, '');
  assert.match(result.stdout, /carry/);
  assert.ok(!result.calls.some((call) => call.path.endsWith('/approve')));
});

test('CLI non-maintainer cannot authorize paid jobs; start-tests independently refuses machinery', async (t) => {
  const refused = await cli(t, 'authorize', (path) => path.endsWith('/permission') ? { permission: 'read' } : fixture(path));
  assert.equal(refused.code, undefined, refused.stderr);
  assert.equal(refused.output, '');
  assert.match(refused.stdout, /Only maintainers/);
  assert.ok(!refused.calls.some((call) => call.path.endsWith('/approve')));
  const machinery = await cli(t, 'approve-runs', (path) => path.includes('/compare/') ? { files: [file('.github/workflows/x.yml')] } : fixture(path));
  assert.equal(machinery.code, 1);
  assert.ok(!machinery.calls.some((call) => call.method === 'POST'));
});

test('CLI missing comparison files or count mismatch fails closed', async (t) => {
  for (const comparison of [{}, { files: [] }]) {
    const result = await cli(t, 'authorize', (path) => path.includes('/compare/') ? comparison : fixture(path));
    assert.equal(result.code, 1);
    assert.equal(result.output, '');
    assert.ok(!result.calls.some((call) => call.method === 'POST'));
  }
});

test('CLI manual backfill includes fork bots only, never writes a required status', async (t) => {
  const result = await cli(t, 'backfill', () => [sameRepo, { ...fork, user: { type: 'Bot' } }, { ...fork, number: 2, state: 'closed' }], { PR_NUMBER: '' });
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(result.output, `forks=${JSON.stringify([{ number: 1, sha: head }])}\n`);
  assert.ok(result.calls.every((call) => call.method === 'GET'));
});
