import test from 'node:test';
import assert from 'node:assert/strict';
import { notification, validateReport } from './notify-journeys.mjs';

// Alert transitions when the lane stops scheduling a journey it cannot satisfy.
// Reclassification is not recovery: a journey that went red -> excluded was never fixed.
const run = { name: 'Product journeys', run_number: 10, run_attempt: 1, html_url: 'https://github.com/different-ai/openwork/actions/runs/10' };
const smoke = { spec: 'app-smoke.e2e.test.ts', name: 'Open a working desktop', critical: true };
const quit = { spec: 'desktop-quit-path.e2e.test.ts', name: 'Quit an enterprise install cleanly', critical: false };
const quitExcluded = { spec: quit.spec, name: quit.name, reason: 'set OPENWORK_EVAL_ELECTRON_BINARY' };
const report = (statuses, excluded = []) => validateReport({ entries: Object.entries(statuses).map(([spec, status]) => ({ ...[smoke, quit].find(entry => entry.spec === spec), status })), excluded });

test('excluded journeys travel with the report: counts, reasons, no overlap with executed results', () => {
  const output = report({ [smoke.spec]: 'passed' }, [quitExcluded]);
  assert.deepEqual(output.excluded, [quitExcluded]);
  assert.deepEqual(output.counts, { passed: 1, failed: 0, 'not tested': 0 });
  assert.deepEqual(report({ [smoke.spec]: 'passed' }).excluded, []);
  assert.throws(() => validateReport({ entries: [{ ...smoke, status: 'passed' }], excluded: [{ ...quit }] }), /Invalid journey result/);
  assert.throws(() => validateReport({ entries: [{ ...smoke, status: 'passed' }, { ...quit, status: 'not tested' }], excluded: [quitExcluded] }), /Duplicate/);
  assert.throws(() => validateReport({ entries: [{ ...smoke, status: 'passed' }], excluded: 'none' }), /invalid coverage report/);
});

test('failed -> excluded is reported as reclassified, never as recovered, and closes the thread', () => {
  const red = notification(undefined, run, report({ [smoke.spec]: 'passed', [quit.spec]: 'not tested' }), 'S123');
  assert.deepEqual(red.state.failures, ['desktop-quit-path.e2e.test.ts:not tested']);
  assert.deepEqual(red.state.excluded, []);
  const previous = { ...red.state, thread: '123.456' };
  const reclassified = notification(previous, { ...run, run_number: 11 }, report({ [smoke.spec]: 'passed' }, [quitExcluded]), 'S123');
  assert.doesNotMatch(reclassified.message.text, /Recovered/);
  assert.match(reclassified.message.text, /not a recovery: 1 previously failing journey\(s\) reclassified: prerequisite unsatisfied/);
  assert.match(reclassified.message.text, /• Quit an enterprise install cleanly — reclassified: prerequisite unsatisfied \(needs: set OPENWORK_EVAL_ELECTRON_BINARY\)/);
  assert.doesNotMatch(reclassified.message.text, /<!subteam/);
  assert.equal(reclassified.message.thread_ts, '123.456');
  assert.deepEqual(reclassified.state, { sequence: [11, 1], failures: [], excluded: [quit.spec], thread: undefined });
});

test('a genuine fix still reads as recovered when nothing was reclassified', () => {
  const red = notification(undefined, run, report({ [smoke.spec]: 'passed', [quit.spec]: 'failed' }), 'S123');
  const recovered = notification({ ...red.state, thread: '1.2' }, { ...run, run_number: 11 }, report({ [smoke.spec]: 'passed', [quit.spec]: 'passed' }), 'S123');
  assert.match(recovered.message.text, /Recovered — all selected checks passed/);
  assert.doesNotMatch(recovered.message.text, /reclassified/);
});

test('excluded persists quietly across healthy runs and stays in the incident state', () => {
  const previous = { sequence: [11, 1], failures: [], excluded: [quit.spec], thread: undefined };
  const next = notification(previous, { ...run, run_number: 12 }, report({ [smoke.spec]: 'passed' }, [quitExcluded]), 'S123');
  assert.equal(next.message, null);
  assert.deepEqual(next.state.excluded, [quit.spec]);
  // Without any prior state there is nothing to compare against: quiet.
  assert.equal(notification(undefined, run, report({ [smoke.spec]: 'passed' }, [quitExcluded])).message, null);
});

test('passed -> excluded (or state from before this field existed) announces the selection change once, never as a failure or recovery', () => {
  for (const previous of [{ sequence: [11, 1], failures: [], excluded: [], thread: undefined }, { sequence: [11, 1], failures: [], thread: undefined }]) {
    const changed = notification(previous, { ...run, run_number: 12 }, report({ [smoke.spec]: 'passed' }, [quitExcluded]), 'S123');
    assert.match(changed.message.text, /coverage changed: 1 journey\(s\) newly skipped \(prerequisites unmet\)/);
    assert.match(changed.message.text, /• Quit an enterprise install cleanly — newly skipped \(prerequisites unmet; needs: set OPENWORK_EVAL_ELECTRON_BINARY\)/);
    assert.doesNotMatch(changed.message.text, /Recovered|failed|<!subteam/);
    assert.equal(changed.message.thread_ts, undefined);
    assert.deepEqual(changed.state, { sequence: [12, 1], failures: [], excluded: [quit.spec], thread: undefined });
    // The next healthy run with the same exclusions is quiet again.
    assert.equal(notification(changed.state, { ...run, run_number: 13 }, report({ [smoke.spec]: 'passed' }, [quitExcluded])).message, null);
  }
});

test('excluded -> passed is a healthy run: quiet, and the journey leaves the excluded state', () => {
  const previous = { sequence: [12, 1], failures: [], excluded: [quit.spec], thread: undefined };
  const next = notification(previous, { ...run, run_number: 13 }, report({ [smoke.spec]: 'passed', [quit.spec]: 'passed' }), 'S123');
  assert.equal(next.message, null);
  assert.deepEqual(next.state.excluded, []);
});

test('a failure alert keeps excluded counts and reasons in its payload and state', () => {
  const alert = notification(undefined, run, report({ [smoke.spec]: 'failed' }, [quitExcluded]), 'S123');
  assert.match(alert.message.text, /0 passed · 1 failed · 0 not tested · 1 skipped \(prerequisites unmet\)/);
  assert.match(alert.message.text, /1 skipped \(prerequisites unmet\): Quit an enterprise install cleanly — needs: set OPENWORK_EVAL_ELECTRON_BINARY/);
  assert.deepEqual(alert.state.excluded, [quit.spec]);
  // Untrusted names and reasons cannot mention Slack users.
  const hostile = notification(undefined, run, report({ [smoke.spec]: 'failed' }, [{ ...quitExcluded, reason: '<!channel>' }]));
  assert.match(hostile.message.text, /&lt;!channel&gt;/);
  assert.doesNotMatch(hostile.message.text, /<!channel>/);
});
