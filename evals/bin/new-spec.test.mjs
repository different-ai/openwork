import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshCaseId, parseOptions, scaffold, writeScaffold } from './new-spec.mjs';
import { journeyEntry, journeyName } from '../scripts/journeys.mjs';
import { classifySpec, violations } from '../scripts/spec-boundary-ratchet.mjs';
import { compareWorldContracts, countRawEscapes } from '../scripts/spec-channel-ratchet.mjs';

const options = argv => parseOptions(argv);

test('a user-flow scaffold carries the name line, flow tag, resources and a before/action/after/boundary story', () => {
  const { files, caseId } = scaffold(options(['invite-teammate']));
  assert.equal(caseId, undefined);
  assert.deepEqual(files.map(file => file.path), ['specs/invite-teammate.e2e.test.ts', 'worlds/invite-teammate.ts']);
  const [spec, world] = files.map(file => file.content);
  assert.equal(journeyName(spec), 'Invite teammate');
  assert.match(spec, /import \{ inviteTeammate \} from "\.\.\/worlds\/invite-teammate\.ts";/);
  assert.match(spec, /resources: \{ surfaces: \["appWeb"\], services: \[\] \}/);
  assert.match(spec, /\{ tags: \["user-flow"\] \}/);
  assert.match(spec, /docs\/testing\.md#add-a-journey/);
  const steps = [...spec.matchAll(/await step\("([^"]+)"/g)].map(match => match[1]);
  assert.equal(steps.length, 4);
  assert.match(steps[0], /^before: /);
  assert.match(steps[2], /^after: /);
  assert.equal([...spec.matchAll(/user\.screenshot\(\)/g)].length, 4);
  assert.match(spec, /evidence\.recordAssertionEvidence/);
  assert.doesNotMatch(spec, /@module-tag/);
  assert.match(world, /export async function inviteTeammate\(seed: Seed\)/);
  assert.match(world, /seed\.appWeb\(/);
});

test('an agent-flow scaffold is given/when/then/after with a witness, and --engine/--critical register a unique case', () => {
  const taken = ['test("SYNC-01 old", async () => {});'];
  const { files, caseId } = scaffold(options(['sync-org', '--flow', 'agent', '--engine', 'v1,v2', '--critical']), taken);
  assert.equal(caseId, 'SYNC-02');
  const spec = files[0].content;
  assert.match(spec, /@module-tag critical/);
  assert.match(spec, /test\("SYNC-02 an MCP client/);
  assert.match(spec, /\{ tags: \["agent-flow", "engine-v1", "engine-v2"\] \}/);
  assert.deepEqual([...spec.matchAll(/await step\("(\w+)/g)].map(match => match[1]), ['given', 'when', 'then', 'after']);
  assert.match(spec, /witness/);
  assert.match(spec, /services: \["den"\]/);
  // What CI would plan from it (the same parser Vitest feeds).
  const entry = journeyEntry('sync-org.e2e.test.ts', spec, [{ name: 'SYNC-02 an MCP client can now TODO', tags: ['critical', 'agent-flow', 'engine-v1', 'engine-v2'] }]);
  assert.equal(entry.critical, true);
  assert.deepEqual(entry.cases.map(value => [value.id, value.engines]), [['SYNC-02', ['v1', 'v2']]]);
  assert.equal(freshCaseId('a-b', []), 'A-01');
});

test('every scaffold passes the boundary and channel ratchets as a new-layer spec', () => {
  for (const argv of [['one'], ['two', '--flow', 'agent'], ['three', '--world', 'chat.ts:streamedMarkdown']]) {
    const spec = scaffold(options(argv)).files[0];
    assert.deepEqual(violations(spec.path, classifySpec(spec.content)), []);
    assert.equal(countRawEscapes(spec.content), 0);
    assert.deepEqual(compareWorldContracts(spec.path, spec.content), []);
    assert.match(spec.content, /^import .* from "(?:vitest|@openwork\/testkit|\.\.\/worlds\/[\w-]+\.ts)";$/m);
    for (const [, from] of spec.content.matchAll(/from "([^"]+)"/g)) assert.match(from, /^(?:vitest|@openwork\/testkit|\.\.\/worlds\/[\w-]+\.ts)$/);
  }
});

test('names, flows, engines and worlds are validated; existing files are never overwritten', async () => {
  for (const argv of [[], ['Bad_Name'], ['a', 'b'], ['ok', '--flow', 'robot'], ['ok', '--engine', 'v3'], ['ok', '--engine', 'v1,v1'], ['ok', '--world', 'chat']])
    assert.throws(() => options(argv), `rejects ${argv.join(' ')}`);
  assert.equal(options(['--help']).help, true);
  const root = await mkdtemp(join(tmpdir(), 'evals-new-'));
  try {
    await mkdir(join(root, 'specs'));
    await mkdir(join(root, 'worlds'));
    await writeFile(join(root, 'worlds', 'shared.ts'), 'export async function sharedWorld() {}\n');
    const created = writeScaffold(options(['fresh']), root);
    assert.equal(created.files.length, 2);
    assert.match(await readFile(join(root, 'specs', 'fresh.e2e.test.ts'), 'utf8'), /user-flow/);
    assert.throws(() => writeScaffold(options(['fresh']), root), /Refusing to overwrite evals\/specs\/fresh\.e2e\.test\.ts, evals\/worlds\/fresh\.ts/);
    assert.equal(writeScaffold(options(['reuse', '--world', 'shared.ts:sharedWorld']), root).files.length, 1);
    assert.throws(() => writeScaffold(options(['other', '--world', 'shared.ts:missing']), root), /does not export missing/);
    assert.throws(() => writeScaffold(options(['other', '--world', 'nope.ts:x']), root), /does not exist/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
