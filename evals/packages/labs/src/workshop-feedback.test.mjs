import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlainWitness } from './workshop-feedback.mjs';
import { feedbackFetch } from './workshop-feedback-preload.mjs';

const customerQuery = 'mutation LandingUpsertCustomer($input: UpsertCustomerInput!) { upsertCustomer(input: $input) { customer { id } error { code } } }';
const threadQuery = 'mutation LandingCreateThread($input: CreateThreadInput!) { createThread(input: $input) { thread { id } error { code } } }';

test('real GraphQL HTTP transport persists only accepted provider mutations and supports operator readback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workshop-feedback-test-'));
  try {
    await using witness = await startPlainWitness({ directory: root, token: 'owned-test-only' });
    const transport = feedbackFetch({ origin: witness.origin, token: 'owned-test-only', fetch });
    const call = (query, input) => transport('https://core-api.uk.plain.com/graphql/v1', { method: 'POST', headers: { authorization: 'Bearer owned-test-only', 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { input } }) });
    assert.equal((await witness.read()).threads.length, 0);
    assert.equal((await call(threadQuery, { customerIdentifier: { customerId: 'missing' } })).status, 400);
    assert.equal((await call(customerQuery, { identifier: { emailAddress: 'alex@acme.test' }, onCreate: { fullName: 'Alex Chen', email: { email: 'alex@acme.test', isVerified: false } }, onUpdate: {} })).status, 200);
    const malformed = await call(threadQuery, { customerIdentifier: { customerId: 'customer_1' }, title: 'OpenWork app feedback', components: [{ componentPlainText: { plainText: 'Must not persist' } }], threadFields: [{ key: 'openwork_metadata', type: 'TEXT', textValue: '{}' }] });
    assert.equal(malformed.status, 400);
    assert.equal((await witness.read()).threads.length, 0);
    const message = 'The product comparison missed the lift capacity. Session ses_owned_feedback; this answer was not useful.';
    const response = await call(threadQuery, { customerIdentifier: { customerId: 'customer_1' }, title: 'OpenWork app feedback', components: [{ componentPlainText: { plainText: message } }], threadFields: [{ key: 'openwork_metadata', type: 'STRING', stringValue: JSON.stringify({ source: 'openwork-app', entrypoint: 'status-bar' }) }, { key: 'openwork_deployment', type: 'STRING', stringValue: 'web' }] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.createThread.thread.id, 'thread_1');
    const state = await witness.read();
    assert.equal(state.threads.length, 1);
    assert.equal(state.threads[0].input.components[0].componentPlainText.plainText, message);
    assert.equal(state.audit.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'plain-state.json'), 'utf8')), state);
    const operator = await fetch(`${witness.origin}/operator/state`, { headers: { authorization: 'Bearer owned-test-only' } });
    assert.deepEqual(await operator.json(), state);
    assert.equal((await fetch(`${witness.origin}/operator/state`)).status, 401);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preload fails closed: never sends a real key, unrelated external request, or alternate Plain path', async () => {
  const observed = [];
  const transport = feedbackFetch({ origin: 'http://127.0.0.1:3999', token: 'owned-test-only', fetch: async (...args) => { observed.push(args); return new Response('{}'); } });
  await assert.rejects(transport('https://core-api.uk.plain.com/graphql/v1', { headers: { authorization: 'Bearer real-key' } }), /synthetic/);
  await assert.rejects(transport('https://core-api.uk.plain.com/other'), /egress/);
  await assert.rejects(transport('https://api.resend.com/emails', { method: 'POST' }), /egress/);
  assert.equal(observed.length, 0);
  await transport('http://127.0.0.1:4000/feedback');
  assert.equal(observed.length, 1);
  assert.throws(() => feedbackFetch({ origin: 'https://external.test', token: 'owned-test-only', fetch }), /loopback/);
});
