import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMarker, previousPreview, renderPreviewCard, updatePreviewCard } from './evidence-preview-card.mjs';

const input = { repo: 'sample-org/sample-project', pr: 12, sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', title: 'Evidence passed', reportUrl: `https://review.example/r/${'b'.repeat(32)}`, reviewUrl: 'https://review.example', logUrl: 'https://github.com/sample-org/sample-project/actions/runs/123', now: '2026-09-23T12:00:00.000Z' };
const bot = { login: 'github-actions[bot]', type: 'Bot' };

test('ready card exposes report, exact commit link and UTC publication time', () => {
  const body = renderPreviewCard(input);
  assert.match(body, /🟢 Ready · evidence passed/);
  assert.ok(body.includes(`**[Open preview](${input.reportUrl})**`));
  assert.ok(body.includes(`/commit/${input.sha}`));
  assert.match(body, /2026-09-23 12:00:00 UTC/);
  assert.deepEqual(previousPreview(body, input.reviewUrl), { url: input.reportUrl, sha: input.sha, publishedAt: input.now });
});

test('failed evidence is available but never presented as passing', () => {
  const body = renderPreviewCard({ ...input, conclusion: 'failure' });
  assert.match(body, /🔴 Ready · evidence needs attention/);
  assert.doesNotMatch(body, /evidence passed/);
});

test('new runs label previous evidence outdated and retain its identity', () => {
  const previous = previousPreview(renderPreviewCard(input), input.reviewUrl);
  for (const status of ['in_progress', 'completed']) {
    const body = renderPreviewCard({ ...input, sha: 'c'.repeat(40), reportUrl: undefined, status, conclusion: 'failure', previous });
    assert.match(body, /Previous evidence — out of date/);
    assert.match(body, /does not verify the current run/);
    assert.doesNotMatch(body, /\*\*\[Open preview\]/);
    assert.deepEqual(previousPreview(body, input.reviewUrl), previous);
  }
});

test('neutral and failed publication use explicit distinct states', () => {
  assert.match(renderPreviewCard({ ...input, reportUrl: undefined, conclusion: 'neutral', title: 'No change-specific evidence selected' }), /No new preview[\s\S]*No change-specific evidence selected/);
  assert.match(renderPreviewCard({ ...input, reportUrl: undefined, conclusion: 'failure' }), /Preview unavailable/);
});

test('previous metadata rejects foreign origins, credentials, queries and invalid identities', () => {
  for (const override of [{ url: 'https://other.example/r/' + 'b'.repeat(32) }, { url: input.reportUrl + '?token=secret' }, { url: input.reportUrl.replace('https://', 'https://user:secret@') }, { sha: 'invalid' }, { publishedAt: 'invalid' }]) {
    const body = `<!-- openwork-evidence-report:${JSON.stringify({ url: input.reportUrl, sha: input.sha, publishedAt: input.now, ...override })} -->`;
    assert.equal(previousPreview(body, input.reviewUrl), undefined);
  }
  assert.equal(previousPreview('<!-- openwork-evidence-report:{bad} -->', input.reviewUrl), undefined);
});

test('updates only authenticated bot card found on a later page', async () => {
  const writes = [];
  const api = async (path, method, body) => {
    if (method) { writes.push({ path, method, body }); return {}; }
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user: { login: 'someone', type: 'User' }, body: cardMarker }));
    return [{ id: 101, user: bot, body: renderPreviewCard(input) }];
  };
  await updatePreviewCard({ ...input, reportUrl: undefined, status: 'in_progress' }, api, async () => true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, 'repos/sample-org/sample-project/issues/comments/101');
  assert.equal(writes[0].method, 'PATCH');
  assert.match(writes[0].body.body, /out of date/);
});

test('creates one card without editing manual evidence or other bots', async () => {
  const writes = [];
  const api = async (path, method, body) => {
    if (method) { writes.push({ path, method, body }); return {}; }
    return [{ id: 1, user: bot, body: '<!-- test-evidence -->manual' }, { id: 2, user: { login: 'other[bot]', type: 'Bot' }, body: cardMarker }];
  };
  await updatePreviewCard(input, api, async () => true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].path, 'repos/sample-org/sample-project/issues/12/comments');
});

test('stale run never writes a card', async () => {
  await updatePreviewCard(input, async (_path, method) => { assert.equal(method, undefined); return []; }, async () => false);
});
