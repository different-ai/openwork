import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeJourneys } from './judge-journeys.mjs';
import assert from 'node:assert/strict';
import { JOURNEY_DOCS, ciLane, collectSpecs, discoverJourneys, journeyName, registeredCases, selectJourneys, unmetLaneNeeds, withTrustedMetadata } from './journeys.mjs';
import { EXCLUDED_LABEL, aggregate, classify, markdown } from './journey-report.mjs';
import { notification, deliver, validateReport, findStateRun } from './notify-journeys.mjs';

const summary = { command: 'evals:e2e', verdict: 'passed', passed: 1, failed: 0, skipped: 0 };
const entry = { spec: 'permissions.e2e.test.ts', name: 'Apply permissions', critical: true, placement: 'daytona' };
const plan = { suite: 'Full regression', entries: [entry], manual: [] };
const run = { name: 'Product journeys', run_number: 10, run_attempt: 1, html_url: 'https://github.com/different-ai/openwork/actions/runs/10' };
const report = status => validateReport({ entries: [{ ...entry, status }] });
// Vitest discovers the journeys once (static parse; no spec is imported).
const specs = await collectSpecs();
const journeys = await discoverJourneys();
const cases = registeredCases(journeys);
// Failure messages name the fix and the doc section (docs/testing.md), so a red run teaches the convention.
const see = `See ${JOURNEY_DOCS}.`;

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
  const entries = journeys;
  const selected = selectJourneys(entries, { critical: true, changed: ['apps/app/src/view.tsx'] });
  assert.equal(selected.length, 3, `expected 3 critical journeys, found ${selected.map(value => value.spec).join(', ')}; when you add or drop @module-tag critical, update this count and docs/testing.md#how-ci-picks-journeys.`);
  assert(selected.some(value => value.placement === 'local'));
  assert(selected.some(value => value.model === 'live'));
  assert(selected.every(value => value.critical));
});

test('changed additional journey joins critical selection; manual filters work for either placement', async () => {
  const entries = journeys;
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

test('journeys needing a packaged binary, macOS, or paid live consent are skipped in the CI lane', async () => {
  const entries = journeys;
  const excluded = entries.filter(entry => entry.placement !== 'manual' && unmetLaneNeeds(entry).length > 0);
  assert.deepEqual(excluded.map(entry => [entry.spec, unmetLaneNeeds(entry).join(', ')]), [
    ['computer-use-window-scope.e2e.test.ts', 'run on darwin'],
    ['desktop-quit-path.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['live-stream-continuity.e2e.test.ts', 'set OPENAI_API_KEY, set OPENWORK_EVAL_LIVE_OPENAI=1'],
    ['packaged-activated-launch.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-first-launch.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-preactivation-egress.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['packaged-preactivation-updater.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
    ['released-enterprise-activated.e2e.test.ts', 'set OPENWORK_EVAL_ELECTRON_BINARY'],
  ], `the journeys CI skips for unmet prerequisites changed; if you added or removed a packaged/macos/live-openai @module-tag on purpose, update this list. ${see}`);
  assert(excluded.every(entry => entry.placement === 'local'));
  assert(excluded.every(entry => !entry.critical));
  // A lane that packages the enterprise desktop would schedule the packaged journeys again; released-enterprise-activated's
  // update case still skips itself there without OPENWORK_EVAL_RELEASED_BASELINE_BINARY, which the verdict counts as not tested.
  const packagedLane = { ...ciLane, env: ['OPENWORK_EVAL_ELECTRON_BINARY'] };
  assert.deepEqual(excluded.filter(entry => unmetLaneNeeds(entry, packagedLane).length > 0).map(entry => entry.spec), [
    'computer-use-window-scope.e2e.test.ts', 'live-stream-continuity.e2e.test.ts',
  ]);
  assert.deepEqual(unmetLaneNeeds(entry), []);
});

// The WHOLE-FILE blockers a spec and the worlds it imports actually gate on: env vars every
// `needs: { env }` declaration in the spec shares (a prerequisite only one case declares is that
// case's own, not the file's), plus env reads and platform checks in the lines leading to a
// `throw new SkipError` or `throw new Error` in a world body (which every case runs; #4814 made a
// missing packaged binary a hard error rather than a skip). Scoped to journeys that declare
// `needs`: shared worlds (first-run.ts) hold scenario-specific guards, and per-scenario world
// plans are #4771's job — this guard only keeps declared needs from drifting either way.
function wholeFileBlockers(specSource, worldSources) {
  const declarations = [...specSource.matchAll(/needs:\s*\{([^}]*)\}/g)].map(match => match[1]);
  const envSets = declarations.map(body => new Set([...(body.match(/\benv:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map(name => name[1])));
  const env = new Set(envSets.length ? [...envSets[0]].filter(name => envSets.every(set => set.has(name))) : []);
  const platforms = declarations.map(body => body.match(/\bplatform:\s*"(\w+)"/)?.[1]);
  let platform = platforms.length && platforms.every(value => value && value === platforms[0]) ? platforms[0] : undefined;
  for (const text of worldSources) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (!/throw new (?:SkipError|Error)\(/.test(line)) return;
      const window = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
      for (const match of window.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) env.add(match[1]);
      platform = window.match(/process\.platform\s*!==\s*"(\w+)"/)?.[1] ?? platform;
    });
  }
  return { env: [...env].sort(), platform };
}

async function guardedPrerequisites(spec, root = new URL('../specs/', import.meta.url)) {
  const source = await readFile(new URL(spec, root), 'utf8');
  const worlds = [...new Set([...source.matchAll(/from\s+["']\.\.\/worlds\/([\w-]+\.ts)["']/g)].map(match => match[1]))];
  return wholeFileBlockers(source, await Promise.all(worlds.map(world => readFile(new URL(`../worlds/${world}`, root), 'utf8'))));
}

test('needs from journey tags match the whole-file prerequisites each spec and its worlds guard, in both directions', async () => {
  const entries = journeys;
  const declared = entries.filter(entry => entry.needs);
  assert.equal(declared.length, 8, `expected 8 journeys with packaged/macos/live-openai needs, found ${declared.map(entry => entry.spec).join(', ')}; update this count when you add or remove one of those tags. ${see}`);
  for (const entry of declared) {
    assert.deepEqual({ env: [...(entry.needs.env ?? [])].sort(), platform: entry.needs.platform }, await guardedPrerequisites(entry.spec), `${entry.spec}: its packaged/macos/live-openai @module-tags drifted from what the spec's needs and its worlds' skip guards check; add or remove the tag so both agree. ${see}`);
  }
  // The released spec's update case alone needs the baseline binary; that is not a whole-file blocker.
  assert.deepEqual(await guardedPrerequisites('released-enterprise-activated.e2e.test.ts'), { env: ['OPENWORK_EVAL_ELECTRON_BINARY'], platform: undefined });
  assert.deepEqual(await guardedPrerequisites('computer-use-window-scope.e2e.test.ts'), { env: [], platform: 'darwin' });
  assert.deepEqual(await guardedPrerequisites('mcp-oauth-start-unreadable-response.e2e.test.ts'), { env: [], platform: undefined });
});

test('mixed-world specs: a prerequisite one case declares is never promoted to the whole file; world-body guards always are', () => {
  const mixed = `const launch = spec.world(w, { needs: { env: ["OPENWORK_EVAL_A"] } });\nconst update = spec.world(w, { needs: { env: ["OPENWORK_EVAL_A", "OPENWORK_EVAL_B"], platform: "darwin" } });`;
  const world = `export async function w() {\n  const binary = process.env.OPENWORK_EVAL_C?.trim();\n  if (!binary) throw new SkipError("set it");\n  if (process.platform !== "linux") throw new SkipError("linux only");\n}`;
  assert.deepEqual(wholeFileBlockers(mixed, [world]), { env: ['OPENWORK_EVAL_A', 'OPENWORK_EVAL_C'], platform: 'linux' });
  // A world that hard-errors on a missing prerequisite (not a skip) still declares a whole-file blocker.
  const strict = `if (!process.env.OPENWORK_EVAL_D?.trim()) {\n  throw new Error("OPENWORK_EVAL_D must point at a packaged desktop binary");\n}`;
  assert.deepEqual(wholeFileBlockers('', [strict]), { env: ['OPENWORK_EVAL_D'], platform: undefined });
  assert.deepEqual(wholeFileBlockers(mixed, []), { env: ['OPENWORK_EVAL_A'], platform: undefined });
  assert.deepEqual(wholeFileBlockers('spec.world(w, { timeout: 1, needs: { platform: "darwin" } });', []), { env: [], platform: 'darwin' });
  // An env read that is not followed by a SkipError (optional pin) is not a blocker.
  assert.deepEqual(wholeFileBlockers('', ['const v = process.env.OPENWORK_EVAL_OPTIONAL?.trim() || null;\nreturn v;']), { env: [], platform: undefined });
});

const specsRoot = new URL('../specs/', import.meta.url);
const JOURNEY_TAGS = ['critical', 'local-only', 'live-model', 'live-openai', 'packaged', 'macos', 'raw-desktop'];
const ENGINE_TAGS = ['engine-v1', 'engine-v2'];

test('journey tags are declared in vitest.config.ts and file-level, and engine tags mark ID-titled cases', async () => {
  const config = await readFile(new URL('../vitest.config.ts', import.meta.url), 'utf8');
  const declared = new Set([...config.matchAll(/\{\s*name:\s*"([^"]+)",\s*description:\s*"[^"]+"/g)].map(match => match[1]));
  for (const tag of [...JOURNEY_TAGS, ...ENGINE_TAGS]) assert(declared.has(tag), `${tag} must be declared (with a description) in evals/vitest.config.ts, then run \`pnpm --dir evals docs:tags\`. ${see}`);
  assert.equal(specs.length, journeys.length);
  for (const { spec, tests } of specs) {
    // A test's tags include its file's @module-tags, so a journey tag on only some tests was set per test.
    for (const tag of JOURNEY_TAGS.filter(value => tests.some(test => test.tags.includes(value))))
      assert(tests.every(test => test.tags.includes(tag)), `${spec}: ${tag} describes the whole journey; move it from the test's { tags } to a \` * @module-tag ${tag}\` line in the JSDoc block at the top of the file. ${see}`);
    for (const { name, tags } of tests) {
      if (tags.some(tag => ENGINE_TAGS.includes(tag))) assert.match(name, /^[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+[\s:]/, `${spec}: "${name}" carries an engine tag, so its title must start with a unique case ID, e.g. test("HOME-01 …", { tags: ["engine-v2"] }, …). ${see}`);
    }
  }
});

test('raw-desktop marks exactly the specs that drive a raw desktop host, which no lane schedules', async () => {
  for (const entry of journeys) {
    const source = await readFile(new URL(entry.spec, specsRoot), 'utf8');
    const rawDesktop = /import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source);
    assert.equal(entry.placement === 'manual', rawDesktop, `${entry.spec}: tag it @module-tag raw-desktop exactly when it imports desktop from @openwork/hosts (prefer seed.appWeb, which CI can run). ${see}`);
  }
});

test('registered cases come from the specs: unique IDs, at least one engine, and the e2e opt-in', async () => {
  assert(cases.length >= 20);
  const duplicates = cases.filter((value, index) => cases.findIndex(other => other.id === value.id) !== index).map(value => `${value.id} (${value.spec})`);
  assert.deepEqual(duplicates, [], `case IDs must be unique across specs; rename the later one (pnpm evals:new --engine picks a free ID). ${see}`);
  for (const registered of cases) {
    const entry = journeys.find(value => value.spec === registered.spec);
    assert(entry.cases.some(value => value.id === registered.id));
    assert(registered.engines.length > 0 && registered.engines.every(engine => ['v1', 'v2'].includes(engine)));
    assert.equal(registered.optIns[0], 'OPENWORK_EVAL_E2E_TESTS');
    assert.deepEqual(registered.example, { placement: '--local', engine: registered.engines.at(-1) });
    assert.equal('surfaces' in registered, false);
  }
  assert.deepEqual(cases.filter(value => value.spec === 'opencode-v2-session-home.e2e.test.ts').map(({ id, engines }) => ({ id, engines })), [
    { id: 'HOME-01', engines: ['v2'] }, { id: 'HOME-02', engines: ['v2'] }, { id: 'HOME-03', engines: ['v2'] },
  ]);
});

test('Vitest discovers journeys from spec files as data: names, module tags, template titles and test tags, without running them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journey-discovery-'));
  const marker = join(root, 'executed');
  try {
    await mkdir(join(root, 'specs', 'nested'), { recursive: true });
    await writeFile(join(root, 'specs', 'thing.e2e.test.ts'), `/**\n * Keep a thing working\n *\n * @module-tag local-only\n * @module-tag packaged\n * @module-tag live-openai\n */\n` +
      `import { writeFileSync } from "node:fs";\nimport { spec } from "@openwork/testkit";\nwriteFileSync(${JSON.stringify(marker)}, "spec code ran");\n` +
      'const latencyTest = spec.world(w, { needs: { optIn: ["OPENWORK_EVAL_LIVE_OPENAI"] } });\n' +
      'test(`EDIT-BUSY ${engine()}: edits`, { tags: ["engine-v1", "engine-v2"] }, async () => { regex.test("NOT-A-TEST x"); });\n' +
      'latencyTest("SWITCH-10 measures", {\n  tags: ["engine-v2"],\n  timeout: 1,\n}, async () => {});\n' +
      'test("PLAIN-01 no engines", async () => {});\ntest("an untitled flow", { tags: ["user-flow"] }, async () => {});\n');
    await writeFile(join(root, 'specs', 'raw-host.e2e.test.ts'), '/**\n * @module-tag raw-desktop\n */\nimport { desktop } from "@openwork/hosts";\ntest("drives a desktop", async () => {});\n');
    await writeFile(join(root, 'specs', 'nested', 'deep.e2e.test.ts'), 'test("not a journey", async () => {});\n');
    await writeFile(join(root, 'vitest.config.ts'), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "root config ran");\nexport default {};\n`);
    const optIns = ['OPENWORK_EVAL_E2E_TESTS', 'OPENWORK_EVAL_LIVE_OPENAI'];
    assert.deepEqual(await discoverJourneys(root), [
      { spec: 'raw-host.e2e.test.ts', name: 'raw host', critical: false, model: 'mock', placement: 'manual' },
      {
        spec: 'thing.e2e.test.ts', name: 'Keep a thing working', critical: false, model: 'mock', placement: 'local',
        needs: { env: ['OPENWORK_EVAL_ELECTRON_BINARY', 'OPENAI_API_KEY'], optIn: ['OPENWORK_EVAL_LIVE_OPENAI'] },
        cases: [
          { id: 'EDIT-BUSY', engines: ['v1', 'v2'], optIns, example: { placement: '--local', engine: 'v2' } },
          { id: 'SWITCH-10', engines: ['v2'], optIns, example: { placement: '--local', engine: 'v2' } },
        ],
      },
    ]);
    // Neither the spec nor a config next to it was executed: only this checkout's config is loaded.
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
    await writeFile(join(root, 'specs', 'unknown-tag.e2e.test.ts'), 'test("SMUGGLE-01 x", { tags: ["not-declared"] }, async () => {});\n');
    await assert.rejects(discoverJourneys(root), /Vitest could not read the journey specs[\s\S]*vitest --list-tags[\s\S]*docs\/testing\.md#journey-tags/);
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(journeyName('/**\n * @module-tag critical\n */\n'), undefined);
  assert.equal(journeyName('import x from "y";\n/** Not at the top */'), undefined);
});

test('untrusted spec sources cannot retag an existing journey or drop a critical one', () => {
  const trusted = [
    { spec: 'smoke.e2e.test.ts', name: 'Smoke', critical: true, model: 'mock', placement: 'daytona' },
    { spec: 'old.e2e.test.ts', name: 'Old', critical: false, model: 'mock', placement: 'daytona' },
  ];
  const candidate = [
    { spec: 'smoke.e2e.test.ts', name: 'Smoke', critical: false, model: 'mock', placement: 'local', needs: { env: ['OPENWORK_EVAL_ELECTRON_BINARY'] } },
    { spec: 'new.e2e.test.ts', name: 'New', critical: false, model: 'mock', placement: 'local' },
  ];
  assert.deepEqual(withTrustedMetadata(candidate, trusted), [trusted[0], candidate[1]]);
  assert.throws(() => withTrustedMetadata(candidate.slice(1), trusted), /Critical journey missing: smoke\.e2e\.test\.ts/);
});

test('live continuity is isolated, local, v1-only and never scheduled from a provider key alone', async () => {
  const entries = journeys;
  const live = entries.find(entry => entry.spec === 'live-stream-continuity.e2e.test.ts');
  assert.equal(live.placement, 'local');
  assert.equal(live.model, 'live');
  assert.equal(live.critical, false);
  assert.deepEqual(unmetLaneNeeds(live, { ...ciLane, env: ['OPENAI_API_KEY'] }), ['set OPENWORK_EVAL_LIVE_OPENAI=1']);
  assert.deepEqual(unmetLaneNeeds(live, { ...ciLane, optIns: ['OPENWORK_EVAL_LIVE_OPENAI'] }), ['set OPENAI_API_KEY']);
  assert.deepEqual(unmetLaneNeeds(live, { ...ciLane, env: ['OPENAI_API_KEY'], optIns: ['OPENWORK_EVAL_LIVE_OPENAI'] }), []);
  for (const registered of live.cases) {
    assert.deepEqual(registered.engines, ['v1']);
    assert.deepEqual(registered.optIns, ['OPENWORK_EVAL_E2E_TESTS', 'OPENWORK_EVAL_LIVE_OPENAI']);
    assert.equal(registered.example.placement, '--local');
  }
  const mock = entries.find(entry => entry.spec === 'streamed-markdown-answer.e2e.test.ts');
  assert.equal(mock.model, 'mock');
  assert.equal(mock.needs, undefined);
  assert.deepEqual(mock.cases.map(entry => entry.id), ['CONT-01']);
  const source = await readFile(new URL('../specs/live-stream-continuity.e2e.test.ts', import.meta.url), 'utf8');
  assert.match(source, /needs:\s*\{\s*placement:\s*"local",\s*optIn:\s*\["OPENWORK_EVAL_LIVE_OPENAI"\]/);
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

test('skipped journeys (prerequisites unmet) are listed with their reason in every report and never decide the verdict', () => {
  const quit = { spec: 'desktop-quit-path.e2e.test.ts', name: 'Quit an enterprise install cleanly', critical: false, placement: 'local', reason: 'set OPENWORK_EVAL_ELECTRON_BINARY' };
  const output = aggregate({ ...plan, excluded: [quit] }, [{ spec: entry.spec, status: 'passed' }]);
  assert.equal(output.ok, true);
  assert.deepEqual(output.counts, { passed: 1, failed: 0, 'not tested': 0 });
  assert.deepEqual(output.excluded, [quit]);
  const text = markdown(output);
  assert.match(text, /1 passed · 0 failed · 0 not tested · 1 skipped \(prerequisites unmet\)/);
  assert.match(text, new RegExp(`\\| Quit an enterprise install cleanly \\| ${EXCLUDED_LABEL} — needs: set OPENWORK_EVAL_ELECTRON_BINARY \\|`));
  assert.match(text, /1 journeys skipped \(prerequisites unmet\): desktop-quit-path\.e2e\.test\.ts\./);
  assert.doesNotMatch(text, /not applicable/);
  // A stray result for an excluded journey cannot count as coverage, and a plan without the field still reports.
  assert.equal(aggregate({ ...plan, excluded: [quit] }, [{ spec: entry.spec, status: 'passed' }, { spec: quit.spec, status: 'passed' }]).counts.passed, 1);
  assert.match(markdown(aggregate(plan, [{ spec: entry.spec, status: 'passed' }])), /0 skipped \(prerequisites unmet\)/);
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
