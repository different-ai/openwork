import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, selectJourneys } from './journey-catalog.mjs';
import { aggregate, classify, markdown } from './journey-report.mjs';
import { notification, deliver, validateReport } from './notify-journeys.mjs';

const summary = { command: 'evals:e2e', verdict: 'passed', passed: 1, failed: 0, skipped: 0 };
const entry = { spec: 'permissions.e2e.test.ts', name: 'Apply permissions', critical: true, placement: 'daytona' };
const plan = { suite: 'Full regression', entries: [entry], manual: [] };
const run = { name: 'Product journeys', run_number: 10, run_attempt: 1, html_url: 'https://github.com/different-ai/openwork/actions/runs/10' };
const report = status => validateReport({ entries: [{ ...entry, status }] });

test('critical PR selection includes existing critical journeys even when only product source changes', async () => {
  const entries = await catalog();
  const selected = selectJourneys(entries, { critical: true, changed: ['apps/app/src/view.tsx'] });
  assert.equal(selected.length, 4);
  assert(selected.some(value => value.placement === 'local'));
  assert(selected.some(value => value.model === 'live'));
  assert(selected.every(value => value.critical));
});

test('changed additional journey joins critical selection; manual filters work for either placement', async () => {
  const entries = await catalog();
  const extra = entries.find(value => !value.critical && value.placement === 'daytona');
  assert(selectJourneys(entries, { critical: true, changed: [extra.spec] }).includes(extra));
  const handoff = selectJourneys(entries, { only: 'cross-server-handoff-atomic-commit' });
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].placement, 'local');
  assert.equal(selectJourneys(entries, { only: 'does-not-exist' }).length, 0);
});

test('skips, no tests, missing summaries, setup and judging failures never pass', () => {
  assert.equal(classify(summary, 'success', 'success'), 'passed');
  assert.equal(classify({ ...summary, skipped: 1 }, 'success', 'success'), 'not tested');
  assert.equal(classify({ ...summary, passed: 0 }, 'success', 'success'), 'not tested');
  assert.equal(classify(undefined, 'failure', 'skipped'), 'not tested');
  assert.equal(classify(summary, 'failure', 'success'), 'not tested');
  assert.equal(classify(summary, 'success', 'skipped'), 'not tested');
  assert.equal(classify(summary, 'success', 'failure'), 'failed');
  assert.equal(classify({ ...summary, failed: 1 }, 'failure', 'skipped'), 'failed');
});

test('missing or duplicate result cannot turn a selected journey green', () => {
  for (const results of [[], [{ spec: entry.spec, status: 'passed' }, { spec: entry.spec, status: 'passed' }]]) {
    const output = aggregate(plan, results);
    assert.equal(output.ok, false);
    assert.equal(output.counts['not tested'], 1);
    assert.match(markdown(output), /Critical journeys: action needed/);
  }
  const output = aggregate(plan, [{ spec: entry.spec, status: 'passed' }]);
  assert.equal(output.ok, true);
  assert.match(markdown(output), /Critical journeys: all passed/);
});

test('notification distinguishes new failure, repeat, recovery and healthy run', () => {
  const first = notification(undefined, run, report('failed'), 'S123');
  assert.match(first.message.text, /<!subteam\^S123>/);
  assert.match(first.message.text, /Critical journeys: \*ACTION NEEDED\*/);
  assert.equal(first.message.thread_ts, undefined);
  const previous = { ...first.state, thread: '123.456' };
  const repeat = notification(previous, { ...run, run_number: 11 }, report('failed'), 'S123');
  assert.equal(repeat.message.thread_ts, '123.456');
  assert.doesNotMatch(repeat.message.text, /<!subteam/);
  const recovered = notification(repeat.state, { ...run, run_number: 12 }, report('passed'), 'S123');
  assert.match(recovered.message.text, /Recovered/);
  assert.equal(recovered.message.thread_ts, '123.456');
  assert.equal(recovered.state.thread, undefined);
  assert.equal(notification(recovered.state, { ...run, run_number: 13 }, report('passed')).message, null);
  assert.equal(notification(undefined, run, report('passed')).message, null);
});

test('older runs and identical reruns do not regress incident state', () => {
  const previous = { sequence: [11, 1], failures: [], thread: undefined };
  assert.equal(notification(previous, run, report('failed')).message, null);
  assert.equal(notification(previous, { ...run, run_number: 11 }, report('failed')).message, null);
  assert(notification(previous, { ...run, run_number: 11, run_attempt: 2 }, report('failed')).message);
});

test('not tested remains actionable and untrusted names cannot mention Slack users', () => {
  const output = notification(undefined, run, validateReport({ entries: [{ ...entry, name: '<!channel>', status: 'not tested' }] }));
  assert.match(output.message.text, /1 not tested/);
  assert.doesNotMatch(output.message.text, /Recovered/);
  assert.match(output.message.text, /&lt;!channel&gt;/);
  assert.throws(() => validateReport({ entries: [] }));
  assert.throws(() => validateReport({ entries: [{ ...entry, status: 'green-ish' }] }));
});

test('Slack delivery carries thread and state only advances after accepted response', async () => {
  let requestBody;
  const options = { token: 'test-token', channel: 'C123', teamId: 'S123', request: async (url, options) => {
    assert.equal(url, 'https://slack.com/api/chat.postMessage');
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, ts: '123.456' }) };
  } };
  const state = await deliver(undefined, run, report('failed'), options);
  assert.equal(state.thread, '123.456');
  assert.equal(requestBody.channel, 'C123');
  await deliver(state, { ...run, run_number: 11 }, report('failed'), options);
  assert.equal(requestBody.thread_ts, '123.456');
  await assert.rejects(() => deliver(state, { ...run, run_number: 12 }, report('passed'), {
    ...options, request: async () => ({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) }),
  }), /not_in_channel/);
  assert.equal(state.failures.length, 1);
});
