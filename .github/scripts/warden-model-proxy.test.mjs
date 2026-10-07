import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from './warden-model-proxy.mjs';

const base = { method: 'POST', url: '/v1/responses', allowedModels: ['gpt-6-luna'], count: 0, maxRequests: 10 };
const body = (extra = {}) => JSON.stringify({ model: 'gpt-6-luna', input: 'review', tools: [{ type: 'function', name: 'read' }], ...extra });

test('forwards a Responses call for an allowed model with function tools', () => {
  assert.deepEqual(checkRequest({ ...base, body: body() }), { ok: true });
});

test('refuses other paths, methods, models and malformed bodies', () => {
  assert.equal(checkRequest({ ...base, url: '/v1/files', body: body() }).ok, false);
  assert.equal(checkRequest({ ...base, method: 'GET', body: '' }).ok, false);
  assert.equal(checkRequest({ ...base, url: '/v1/responses?x=1', body: body() }).ok, false);
  assert.equal(checkRequest({ ...base, body: body({ model: 'gpt-expensive' }) }).status, 403);
  assert.equal(checkRequest({ ...base, body: 'nope' }).status, 400);
});

test('refuses hosted tools that would give the model a way out', () => {
  for (const type of ['web_search', 'web_search_preview', 'mcp', 'code_interpreter', 'file_search', 'computer_use_preview', 'image_generation']) {
    assert.equal(checkRequest({ ...base, body: body({ tools: [{ type: 'function', name: 'read' }, { type }] }) }).ok, false, type);
  }
});

test('refuses server-side state and background jobs', () => {
  assert.equal(checkRequest({ ...base, body: body({ previous_response_id: 'resp_1' }) }).ok, false);
  assert.equal(checkRequest({ ...base, body: body({ background: true }) }).ok, false);
  assert.equal(checkRequest({ ...base, body: body({ previous_response_id: null }) }).ok, true);
});

test('stops after the request budget', () => {
  assert.equal(checkRequest({ ...base, count: 10, body: body() }).status, 429);
});
