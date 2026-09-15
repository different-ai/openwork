import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildLabel, journeyBuildKind, manifestSchema, matchesVideoFormat, progressHeading, releaseReceiptSchema, releaseSourcePin, videoFormat } from './manifest.ts';

// Schema-only input fixtures: never rendered or presented as capture evidence.
function input() {
  return {
    version: 1,
    sanitized: true,
    progress: 'partial',
    scenes: ['A', 'B'].map((member) => ({
      variant: 'D', member, kind: 'png', path: 'schema-only.png', actualCapture: true,
      durationSeconds: 10, startSeconds: 0, caption: 'Schema fixture', observed: 'Not capture evidence',
      hiddenApiSetup: true,
      release: { desktopVersion: '0.0.0-dev', desktopTag: 'dev', denBuildIdentity: 'dev',
        buildKind: 'development', releaseSha: '0'.repeat(40), lane: 'local-development', evidencePath: 'schema-only.json' },
      assertion: { state: 'incomplete' },
    })),
  };
}

test('explicit progress never upgrades subset scenes or leaks the partial heading into complete mode', () => {
  assert.equal(progressHeading('partial'), 'PARTIAL PROGRESS — NOT A FULL PASS');
  assert.equal(progressHeading('complete').includes('PARTIAL'), false);
  const subset = input();
  subset.progress = 'complete';
  assert.equal(manifestSchema.safeParse(subset).success, false);
});

test('fixed readable canvas and output geometry guard agree', () => {
  assert.deepEqual(videoFormat, { width: 2560, height: 1920, fps: 30 });
  assert.equal(matchesVideoFormat(2560, 1920, '30/1'), true);
  assert.equal(matchesVideoFormat(1920, 1080, '30/1'), false);
  assert.equal(matchesVideoFormat(2560, 1920, '24/1'), false);
  assert.equal(matchesVideoFormat(2560, 1920, undefined), false);
});

test('explicit unreleased A/B input is valid, without asserting media authenticity', () => {
  assert.equal(manifestSchema.safeParse(input()).success, true);
});

test('unreviewed template is deliberately rejected', async () => {
  const template = JSON.parse(await readFile(new URL('./manifest.template.json', import.meta.url), 'utf8'));
  assert.equal(manifestSchema.safeParse(template).success, false);
});

test('rejects absent release identity, fake release labels, missing B and excess duration', () => {
  const missing = input();
  missing.scenes[0].release.desktopVersion = '';
  assert.equal(manifestSchema.safeParse(missing).success, false);
  const mislabeled = input();
  mislabeled.scenes[0].release.buildKind = 'packaged-release';
  assert.equal(manifestSchema.safeParse(mislabeled).success, false);
  const oneMember = input();
  oneMember.scenes[1].member = 'A';
  assert.equal(manifestSchema.safeParse(oneMember).success, false);
  const long = input();
  for (const scene of long.scenes) scene.durationSeconds = 91;
  assert.equal(manifestSchema.safeParse(long).success, false);
});

test('rejects unsupported media, absent sanitization and passed assertions without evidence', () => {
  const clip = input();
  clip.scenes[0].kind = 'clip';
  assert.equal(manifestSchema.safeParse(clip).success, false);
  const unreviewed = input();
  unreviewed.sanitized = false;
  assert.equal(manifestSchema.safeParse(unreviewed).success, false);
  const unsupportedPass = input();
  unsupportedPass.scenes[0].assertion.state = 'passed';
  assert.equal(manifestSchema.safeParse(unsupportedPass).success, false);
  const url = input();
  url.scenes[0].caption = 'https://example.invalid';
  assert.equal(manifestSchema.safeParse(url).success, false);
});

test('approved local release-source passes both scene and receipt guards with precise caption and filename', () => {
  const source = input();
  for (const scene of source.scenes) {
    scene.release = { ...scene.release, buildKind: 'release-source',
      desktopVersion: releaseSourcePin.version, desktopTag: releaseSourcePin.tag,
      releaseSha: releaseSourcePin.sha, lane: 'local-release-source',
      denBuildIdentity: `local-release-source ${releaseSourcePin.tag}` };
  }
  const parsed = manifestSchema.parse(source);
  const { evidencePath: _evidencePath, ...identity } = parsed.scenes[0].release;
  assert.equal(releaseReceiptSchema.safeParse({ ...identity, member: 'A' }).success, true);
  assert.equal(buildLabel(identity.buildKind), 'release-source, not packaged binary');
  assert.equal(journeyBuildKind(parsed.scenes.map((scene) => scene.release)), 'release-source');
  for (const badIdentity of [
    { ...identity, desktopVersion: '0.18.45' },
    { ...identity, desktopTag: 'v0.18.45' },
    { ...identity, releaseSha: '0'.repeat(40) },
    { ...identity, denBuildIdentity: 'dirty local build' },
    { ...identity, buildKind: 'packaged-release' },
  ]) {
    assert.equal(releaseReceiptSchema.safeParse({ ...badIdentity, member: 'A' }).success, false);
    assert.equal(manifestSchema.safeParse({ ...source,
      scenes: source.scenes.map((scene) => ({ ...scene, release: { ...badIdentity, evidencePath: 'schema-only.json' } })),
    }).success, false);
  }
});

test('packaged and development builds remain explicit and old boolean schema is rejected', () => {
  const identity = releaseReceiptSchema.parse({ member: 'A', buildKind: 'packaged-release',
    desktopVersion: releaseSourcePin.version, desktopTag: releaseSourcePin.tag,
    releaseSha: releaseSourcePin.sha, lane: 'installed-binary', denBuildIdentity: releaseSourcePin.tag });
  assert.equal(journeyBuildKind([identity]), 'packaged-release');
  assert.equal(buildLabel(identity.buildKind), 'packaged-release, binary receipt supplied');
  assert.equal(buildLabel('development'), 'development, not a release');
  assert.equal(journeyBuildKind([{ ...identity, buildKind: 'development' }]), 'development');
  assert.equal(releaseReceiptSchema.safeParse({ ...identity, shippedRelease: true }).success, false);
});

test('release receipts require member and reject unknown fields', () => {
  const release = input().scenes[0].release;
  assert.equal(releaseReceiptSchema.safeParse(release).success, false);
  const { evidencePath: _evidencePath, ...identity } = release;
  assert.equal(releaseReceiptSchema.safeParse({ ...identity, member: 'A' }).success, true);
});
