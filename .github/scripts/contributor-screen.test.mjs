import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodedPayload, hiddenCharacters, isDatabasePath, isValidUtf8, nonRegistrySpec, packageJsonChanges,
  parseWardenJsonl, renderScreenComment, reviewDecision, safe, scanRepository, screenDecision,
} from './contributor-screen.mjs';

const cp = (...points) => String.fromCodePoint(...points);

test('finds invisible, bidirectional and control characters by code point', () => {
  assert.deepEqual(hiddenCharacters('const ok = 1;'), []);
  const bidi = hiddenCharacters(`if (role ${cp(0x202e)}== "admin")`);
  assert.equal(bidi[0].codePoint, 'U+202E');
  assert.equal(bidi[0].name, 'BIDIRECTIONAL OVERRIDE');
  assert.equal(hiddenCharacters(`a${cp(0x200b)}b`)[0].name, 'ZERO WIDTH CHARACTER');
  assert.equal(hiddenCharacters(`x${cp(0xe0041)}`)[0].name, 'TAG CHARACTER');
  assert.equal(hiddenCharacters(`x${cp(0xe0100)}`)[0].name, 'VARIATION SELECTOR SUPPLEMENT');
  assert.equal(hiddenCharacters(`x${cp(0x1b)}[31m`)[0].name, 'CONTROL CHARACTER');
  assert.deepEqual(hiddenCharacters('\tindented\r'), []);
});

test('allows a leading byte order mark and emoji presentation selectors', () => {
  assert.deepEqual(hiddenCharacters(`${cp(0xfeff)}first`, { firstLine: true }), []);
  assert.equal(hiddenCharacters(`${cp(0xfeff)}later`).length, 1);
  assert.deepEqual(hiddenCharacters(`"Done ${cp(0x2764, 0xfe0f)}"`), []);
  assert.equal(hiddenCharacters(`let a${cp(0xfe0f)} = 1`).length, 1);
});

test('flags identifiers that mix Latin with look-alike letters, not translations', () => {
  const mixed = hiddenCharacters(`const p${cp(0x0430)}ssword = 1`); // Cyrillic a
  assert.equal(mixed[0].name, 'MIXED-SCRIPT IDENTIFIER (look-alike letters)');
  assert.deepEqual(hiddenCharacters('title: "Привет мир"'), []);
  assert.deepEqual(hiddenCharacters('label: "こんにちは"'), []);
});

test('detects invalid UTF-8', () => {
  assert.equal(isValidUtf8(Buffer.from('ok')), true);
  assert.equal(isValidUtf8(Buffer.from([0x61, 0xff, 0x62])), false);
});

test('dependency changes: added, changed, non-registry, overrides and install scripts', () => {
  const before = { dependencies: { zod: '^3.0.0' }, scripts: { build: 'tsc' } };
  const after = {
    dependencies: { zod: '^3.1.0', lodahs: '^4.0.0', evil: 'github:someone/evil' },
    pnpm: { overrides: { zod: '3.0.0' } },
    scripts: { build: 'tsc', postinstall: 'node x.js' },
  };
  const items = packageJsonChanges('package.json', before, after).map((item) => item.kind);
  assert.deepEqual(items.sort(), ['added', 'added', 'changed', 'install-script', 'override'].sort());
  assert.equal(nonRegistrySpec('^1.2.3'), false);
  assert.equal(nonRegistrySpec('workspace:*'), false);
  assert.equal(nonRegistrySpec('catalog:'), false);
  for (const spec of ['github:a/b', 'git+https://x/y.git', 'https://x/y.tgz', 'file:../x', 'npm:react@18', 'someone/repo']) {
    assert.equal(nonRegistrySpec(spec), true, spec);
  }
});

test('database paths need a human', () => {
  assert.equal(isDatabasePath('ee/packages/den-db/drizzle/0100_x.sql'), true);
  assert.equal(isDatabasePath('ee/packages/den-db/src/schema.ts'), true);
  assert.equal(isDatabasePath('scripts/seed.sql'), true);
  assert.equal(isDatabasePath('packaging/helm/openwork-ee/templates/migration-job.yaml'), true);
  assert.equal(isDatabasePath('apps/app/src/app/lib/migration.ts'), false);
});

test('flags lines that look encoded or dynamically executed', () => {
  assert.equal(encodedPayload('const a = 1;'), null);
  assert.match(encodedPayload(`const p = "${'QUJD'.repeat(100)}";`), /base64/);
  assert.match(encodedPayload(`x = "${'\\x41'.repeat(25)}"`), /escaped/);
  assert.match(encodedPayload('eval(payload)'), /dynamic code/);
  assert.match(encodedPayload('const f = new Function("a", body)'), /dynamic code/);
  assert.match(encodedPayload(`String.fromCharCode(104, 116, 116, 112, 115, 58, 47, 47, 101, 120)`), /character codes/);
});

const chunk = (skill, findings = [], extra = {}) => JSON.stringify({ schemaVersion: 1, skill, status: 'ok', findings, ...extra });
const summary = (total, extra = {}) => JSON.stringify({ type: 'summary', totalFindings: total, bySeverity: {}, ...extra });
const finding = (severity, title = 'x') => ({ id: title, severity, title, description: 'd' });

test('Warden output is complete only when the summary and findings agree', () => {
  const ok = parseWardenJsonl([chunk('contributor-screen', [finding('low')]), summary(1)].join('\n'), ['contributor-screen']);
  assert.equal(ok.complete, true);
  assert.equal(ok.findings[0].skill, 'contributor-screen');
  assert.equal(parseWardenJsonl('', ['contributor-screen']).complete, false);
  assert.equal(parseWardenJsonl('not json', ['contributor-screen']).complete, false);
  assert.equal(parseWardenJsonl([chunk('contributor-screen'), summary(0, { failedSkills: ['contributor-screen'] })].join('\n'), ['contributor-screen']).complete, false);
  assert.equal(parseWardenJsonl([chunk('contributor-screen', [], { status: 'error' }), summary(0)].join('\n'), ['contributor-screen']).complete, false);
  assert.equal(parseWardenJsonl([chunk('other-skill'), summary(0)].join('\n'), ['contributor-screen']).complete, false);
  assert.equal(parseWardenJsonl([chunk('contributor-screen', [finding('high')]), summary(2)].join('\n'), ['contributor-screen']).complete, false);
});

const emptyScan = { files: [], hidden: [], malformed: [], dependencies: [], database: [], binaries: [], images: [], encoded: [] };
const cleanWarden = { complete: true, findings: [] };

test('screen: hidden characters block; dependencies, database, binaries and findings hold', () => {
  assert.equal(screenDecision(emptyScan, cleanWarden).verdict, 'clean');
  assert.equal(screenDecision(emptyScan, { complete: true, findings: [finding('low')] }).verdict, 'clean');
  assert.equal(screenDecision({ ...emptyScan, hidden: [{}] }, cleanWarden).verdict, 'blocked');
  assert.equal(screenDecision({ ...emptyScan, malformed: [{}] }, cleanWarden).verdict, 'blocked');
  assert.equal(screenDecision({ ...emptyScan, database: ['x.sql'] }, cleanWarden).verdict, 'held');
  assert.equal(screenDecision({ ...emptyScan, dependencies: [{}] }, cleanWarden).verdict, 'held');
  assert.equal(screenDecision({ ...emptyScan, binaries: ['x.bin'] }, cleanWarden).verdict, 'held');
  assert.equal(screenDecision({ ...emptyScan, encoded: [{}] }, cleanWarden).verdict, 'held');
  assert.equal(screenDecision(emptyScan, { complete: true, findings: [finding('medium')] }).verdict, 'held');
  assert.equal(screenDecision(emptyScan, { complete: false, reason: 'x', findings: [] }).verdict, 'held');
});

test('review: confidentiality or high/medium security findings are not clear', () => {
  const sec = (severity) => ({ ...finding(severity), skill: 'diff-security-review' });
  assert.equal(reviewDecision({ complete: true, findings: [sec('low')] }).state, 'success');
  assert.equal(reviewDecision({ complete: true, findings: [sec('medium')] }).state, 'failure');
  assert.equal(reviewDecision({ complete: true, findings: [{ ...finding('low'), skill: 'confidentiality-review' }] }).state, 'failure');
  assert.equal(reviewDecision({ complete: false, reason: 'x', findings: [] }).state, 'failure');
});

test('rendered text never carries secrets, mentions, markup or hidden characters', () => {
  const out = safe(`<img src=x> @maintainer sk-${'a'.repeat(30)} ghp_${'b'.repeat(36)} a${cp(0x202e)}b \`code\``);
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /@maintainer/);
  assert.doesNotMatch(out, /sk-a{30}|ghp_b{36}/);
  assert.doesNotMatch(out, /\u202e/);
  assert.doesNotMatch(out, /`/);
});

test('the screen comment names code points, never the raw characters', () => {
  const scan = { ...emptyScan, hidden: [{ path: 'a.ts', line: 3, column: 9, codePoint: 'U+202E', name: 'BIDIRECTIONAL OVERRIDE' }], database: ['ee/packages/den-db/drizzle/1.sql'] };
  const body = renderScreenComment({ sha: 'a'.repeat(40), decision: screenDecision(scan, cleanWarden), scan, warden: cleanWarden, runUrl: 'https://example.test/run' });
  assert.match(body, /blocked/);
  assert.match(body, /a\.ts:3.*U\+202E BIDIRECTIONAL OVERRIDE/);
  assert.match(body, /Database changes need a human review/);
  assert.doesNotMatch(body, /\u202e/);
});

test('scans a real git range: only added lines, from git objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contributor-screen-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'dev');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(dir, 'old.ts'), `// existing ${cp(0x200b)} is not new\nexport const a = 1;\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { zod: '^3.0.0' } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'old.ts'), `// existing ${cp(0x200b)} is not new\nexport const a = 1;\nexport const b = "x${cp(0x202e)}y";\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { zod: '^3.0.0', 'left-padd': '1.0.0' } }));
  mkdirSync(join(dir, 'ee/packages/den-db/drizzle'), { recursive: true });
  writeFileSync(join(dir, 'ee/packages/den-db/drizzle/0200_x.sql'), 'ALTER TABLE x ADD y INT;\n');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(dir, 'bad.txt'), Buffer.from([0x61, 0xff, 0x0a]));
  git('add', '.');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');

  const scan = scanRepository({ gitDir: join(dir, '.git'), base, head });
  assert.deepEqual(scan.hidden.map((hit) => `${hit.path}:${hit.line}:${hit.codePoint}`), ['old.ts:3:U+202E']);
  assert.deepEqual(scan.database, ['ee/packages/den-db/drizzle/0200_x.sql']);
  assert.deepEqual(scan.binaries, ['blob.bin']);
  assert.deepEqual(scan.malformed.map((item) => item.path), ['bad.txt']);
  assert.ok(scan.dependencies.some((item) => item.text.includes('left-padd')));
  assert.equal(screenDecision(scan, cleanWarden).verdict, 'blocked');
});
