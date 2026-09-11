import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeJourneys } from './judge-journeys.mjs';
import assert from 'node:assert/strict';
import { catalog, ciLane, registeredCases, selectJourneys, unmetLaneNeeds } from './journey-catalog.mjs';
import { aggregate, classify, markdown } from './journey-report.mjs';
import { notification, deliver, validateReport, findStateRun } from './notify-journeys.mjs';

const summary = { command: 'evals:e2e', verdict: 'passed', passed: 1, failed: 0, skipped: 0 };
const entry = { spec: 'permissions.e2e.test.ts', name: 'Apply permissions', critical: true, placement: 'daytona' };
const plan = { suite: 'Full regression', entries: [entry], manual: [] };
const run = { name: 'Product journeys', run_number: 10, run_attempt: 1, html_url: 'https://github.com/different-ai/openwork/actions/runs/10' };
const report = status => validateReport({ entries: [{ ...entry, status }] });

test('incident state survives more than 100 newer unrelated alert runs', async () => {
  const pages = [];
  const stateName = 'test-alert-state-42';
  const found = await findStateRun(stateName, '200', async page => {
    pages.push(page);
    return page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: 200 - i })) : [{ id: 100 }, { id: 99 }];
  }, async id => {
    assert.notEqual(id, 200);
    return [{ name: id === 99 || id === 100 ? stateName : 'test-alert-state-43', expired: id === 100 }];
  });
  assert.equal(found, 99);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(await findStateRun(stateName, '200', async () => [], async () => []), undefined);
});

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
  const instantSend = selectJourneys(entries, { only: 'workspace-new-task-hit-target' });
  assert.equal(instantSend.length, 1);
  assert.equal(instantSend[0].name, 'Keep new tasks and sends instantly responsive');
  assert.equal(instantSend[0].placement, 'local');
  assert.equal(instantSend[0].model, 'mock');
  assert.equal(instantSend[0].critical, false);
  assert.equal(selectJourneys(entries, { only: 'does-not-exist' }).length, 0);
  const several = selectJourneys(entries, { only: 'cross-server-handoff-atomic-commit, workspace-new-task-hit-target,' });
  assert.deepEqual(several.map(value => value.spec).sort(), ['cross-server-handoff-atomic-commit.e2e.test.ts', 'workspace-new-task-hit-target.e2e.test.ts']);
  // Delimiters alone are a typo, never "run everything"; blank input still is.
  for (const only of [', ,', ',', ' , ']) assert.throws(() => selectJourneys(entries, { only }), /names no journey/);
  assert.equal(selectJourneys(entries, { only: '  ' }).length, entries.length);
});

test('journeys needing a packaged binary or macOS are skipped in the CI lane (prerequisites unmet); everything else runs', async () => {
  const entries = await catalog();
  const excluded = entries.filter(entry => entry.placement !== 'manual' && unmetLaneNeeds(entry).length > 0);
  assert.deepEqual(excluded.map(entry => [entry.spec, unmetLaneNeeds(entry).join(', ')]), [
    ['computer-use-window-scope.e2e.test.ts', 'run on darwin'],
    ['desktop-quit-path.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-activated-launch.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-first-launch.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-preactivation-egress.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-preactivation-updater.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['released-enterprise-activated.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY, set OPENWORK_EVAL_RELEASED_BASELINE_BINARY'],
  ]);
  assert(excluded.every(entry => entry.placement === 'local'));
  assert(excluded.every(entry => !entry.critical));
  // A lane that packages the enterprise desktop still lacks a released baseline and macOS.
  const packagedLane = { ...ciLane, env: ['OPENWORK_EVAL_ELECTRON_BINARY'] };
  assert.deepEqual(excluded.filter(entry => unmetLaneNeeds(entry, packagedLane).length > 0).map(entry => entry.spec), ['computer-use-window-scope.e2e.test.ts', 'released-enterprise-activated.e2e.test.ts']);
  assert.deepEqual(unmetLaneNeeds(entry), []);
});

// What a spec and the worlds it imports actually gate on: `needs: { env, platform }` declarations,
// plus env reads and platform checks in the lines leading to a `throw new SkipError`. Scoped to
// journeys that declare `needs`: shared worlds (first-run.ts) hold scenario-specific guards, and
// per-scenario world plans are #4771's job — this guard only keeps declared needs from drifting.
async function guardedPrerequisites(spec, root = new URL('../specs/', import.meta.url)) {
  const source = await readFile(new URL(spec, root), 'utf8');
  const worlds = [...new Set([...source.matchAll(/from\s+["']\.\.\/worlds\/([\w-]+\.ts)["']/g)].map(match => match[1]))];
  const sources = [source, ...await Promise.all(worlds.map(world => readFile(new URL(`../worlds/${world}`, root), 'utf8')))];
  const env = new Set();
  let platform;
  for (const text of sources) {
    for (const match of text.matchAll(/needs:\s*\{[^}]*\benv:\s*\[([^\]]*)\]/g)) for (const name of match[1].matchAll(/"(OPENWORK_EVAL_\w+)"/g)) env.add(name[1]);
    for (const match of text.matchAll(/needs:\s*\{[^}]*\bplatform:\s*"(\w+)"/g)) platform = match[1];
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('throw new SkipError')) return;
      const window = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
      for (const match of window.matchAll(/process\.env\.(OPENWORK_EVAL_\w+)/g)) env.add(match[1]);
      platform = window.match(/process\.platform\s*!==\s*"(\w+)"/)?.[1] ?? platform;
    });
  }
  return { env: [...env].sort(), platform };
}

test('catalog needs match the prerequisites each spec and its worlds guard, in both directions', async () => {
  const entries = await catalog();
  const declared = entries.filter(entry => entry.needs);
  assert.equal(declared.length, 7);
  for (const entry of declared) {
    assert.deepEqual({ env: [...(entry.needs.env ?? [])].sort(), platform: entry.needs.platform }, await guardedPrerequisites(entry.spec), `${entry.spec}: catalog needs drifted from the spec/world guards`);
  }
  // The scanner itself sees the guards it is trusted to see.
  assert.deepEqual(await guardedPrerequisites('released-enterprise-activated.e2e.test.ts'), { env: ['OPENWORK_EVAL_ELECTRON_BINARY', 'OPENWORK_EVAL_RELEASED_BASELINE_BINARY'], platform: undefined });
  assert.deepEqual(await guardedPrerequisites('computer-use-window-scope.e2e.test.ts'), { env: [], platform: 'darwin' });
  assert.deepEqual(await guardedPrerequisites('mcp-oauth-start-unreadable-response.e2e.test.ts'), { env: [], platform: undefined });
});

test('registered case metadata names exact files, supported execution axes, and defaults', async () => {
  const entries = await catalog();
  assert.deepEqual(registeredCases.map(({ spec, id, engines }) => ({ spec, id, engines })), [
    {
      spec: 'composer-model-picker-no-subscribe-promo.e2e.test.ts',
      id: 'MODEL-01',
      engines: ['v2'],
    },
    {
      spec: 'task-activity-shimmer.e2e.test.ts',
      id: 'ACT-01',
      engines: ['v1', 'v2'],
    },
    {
      spec: 'desktop-policy-restricted-mode.e2e.test.ts',
      id: 'POLICY-ROLLBACK',
      engines: ['v1', 'v2'],
    },
    {
      spec: 'streamed-markdown-answer.e2e.test.ts',
      id: 'CONT-01',
      engines: ['v1', 'v2'],
    },
    {
      spec: 'live-tool-visible-after-session-switch.e2e.test.ts',
      id: 'SWITCH-10',
      engines: ['v1', 'v2'],
    },
    {
      spec: 'unfinished-tool-lifecycle.e2e.test.ts',
      id: 'STOP-01',
      engines: ['v1', 'v2'],
    },
    {
      spec: 'saved-app-creation.e2e.test.ts',
      id: 'APP-ISOLATION',
      engines: ['v1', 'v2'],
    },
  ]);
  for (const registered of registeredCases) {
    assert(entries.some(entry => entry.spec === registered.spec));
    assert.equal('surfaces' in registered, false);
  }
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

test('not applicable journeys are listed with their reason and never decide the verdict', () => {
  const quit = { spec: 'desktop-quit-path.e2e.test.ts', name: 'Quit an enterprise install cleanly', critical: false, placement: 'local', reason: 'set OPENWORK_EVAL_ELECTRON_BINARY' };
  const output = aggregate({ ...plan, notApplicable: [quit] }, [{ spec: entry.spec, status: 'passed' }]);
  assert.equal(output.ok, true);
  assert.deepEqual(output.counts, { passed: 1, failed: 0, 'not tested': 0 });
  const text = markdown(output);
  assert.match(text, /1 passed · 0 failed · 0 not tested · 1 not applicable/);
  assert.match(text, /\| Quit an enterprise install cleanly \| not applicable — needs: set OPENWORK_EVAL_ELECTRON_BINARY \|/);
  // A stray result for an excluded journey cannot count as coverage, and a plan without the field still reports.
  assert.equal(aggregate({ ...plan, notApplicable: [quit] }, [{ spec: entry.spec, status: 'passed' }, { spec: quit.spec, status: 'passed' }]).counts.passed, 1);
  assert.match(markdown(aggregate(plan, [{ spec: entry.spec, status: 'passed' }])), /0 not applicable/);
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
  await deliver(state, { ...run, run_number: 12 }, report('failed'), { ...options, channel: 'C456' });
  assert.equal(requestBody.channel, 'C456');
  assert.equal(requestBody.thread_ts, undefined);
  await assert.rejects(() => deliver(state, { ...run, run_number: 12 }, report('passed'), {
    ...options, request: async () => ({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) }),
  }), /not_in_channel/);
  assert.equal(state.failures.length, 1);
});


test('every journey record is judged; the last passing test cannot hide earlier failure or pending evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journey-evidence-'));
  try {
    for (const name of ['first', 'second']) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, 'test-run.json'), JSON.stringify({ gitSha: 'expected' }));
    }
    const visited = [];
    assert.deepEqual(await judgeJourneys(root, 'expected', path => { visited.push(path); return path.endsWith('first') ? 1 : 0; }), { count: 2, result: 'failure' });
    assert.equal(visited.length, 2);
    assert.deepEqual(await judgeJourneys(root, 'expected', path => path.endsWith('first') ? 2 : 0), { count: 2, result: 'incomplete' });
    assert.deepEqual(await judgeJourneys(root, 'expected', () => 0), { count: 2, result: 'success' });
    assert.deepEqual(await judgeJourneys(root, 'wrong-sha', () => { throw new Error('must not judge mismatched evidence'); }), { count: 0, result: 'incomplete' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing evidence and a different executed spec are not passing coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journey-empty-'));
  try {
    assert.deepEqual(await judgeJourneys(root, 'expected'), { count: 0, result: 'incomplete' });
    assert.equal(classify({ ...summary, files: ['other.e2e.test.ts'] }, 'success', 'success', entry.spec), 'not tested');
    assert.equal(classify({ ...summary, files: [entry.spec] }, 'success', 'success', entry.spec), 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidence paths cannot escape the run directory through traversal or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journey-paths-'));
  const directory = join(root, 'run');
  try {
    await mkdir(directory);
    await writeFile(join(root, 'outside.png'), 'outside');
    await writeFile(join(directory, 'inside.png'), 'inside');
    await symlink(join(root, 'outside.png'), join(directory, 'linked.png'));
    for (const fileName of ['../outside.png', join(root, 'outside.png'), 'linked.png', 'missing.png']) {
      await writeFile(join(directory, 'test-run.json'), JSON.stringify({ gitSha: 'expected', artifacts: [{ fileName }] }));
      assert.deepEqual(await judgeJourneys(root, 'expected', () => { throw new Error('must not judge unsafe evidence'); }), { count: 0, result: 'incomplete' });
    }
    await writeFile(join(directory, 'test-run.json'), JSON.stringify({ gitSha: 'expected', artifacts: [{ fileName: 'inside.png' }] }));
    assert.deepEqual(await judgeJourneys(root, 'expected', () => 0), { count: 1, result: 'success' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
