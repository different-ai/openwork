import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWithRetry, transientInstallFailure } from './retry-pnpm-install.mjs';

test('recognizes the observed pnpm registry timeout and other transport failures', () => {
  for (const message of [
    'GET https://registry.npmjs.org/foo error (23). Will retry\nThe operation was aborted due to timeout',
    'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/foo reason: ECONNRESET',
    'ERR_PNPM_FETCH_503 GET https://registry.npmjs.org/foo.tgz',
  ]) assert.equal(transientInstallFailure(message), true, message);
});

test('does not retry unrelated, auth, integrity, lockfile, certificate or lifecycle failures', () => {
  for (const message of [
    'ERR_PNPM_OUTDATED_LOCKFILE registry ETIMEDOUT',
    'ERR_PNPM_TARBALL_INTEGRITY registry ECONNRESET',
    'ERR_PNPM_FETCH_401 registry ECONNRESET',
    'ELIFECYCLE registry ETIMEDOUT',
    'registry certificate error (23)',
    'registry EACCES ETIMEDOUT',
    'Typecheck error', 'ETIMEDOUT connecting to our database',
  ]) assert.equal(transientInstallFailure(message), false, message);
});

test('retries once, returns the final status, and never masks persistent failure', async () => {
  const args = ['install', '--frozen-lockfile'];
  for (const finalStatus of [0, 17]) {
    let attempts = 0;
    const waits = [];
    const status = await installWithRetry(args, {
      run: async received => {
        assert.equal(received, args);
        return { status: ++attempts === 1 ? 1 : finalStatus, output: 'registry ETIMEDOUT' };
      },
      wait: async ms => waits.push(ms), warn: () => {},
    });
    assert.equal(attempts, 2);
    assert.equal(status, finalStatus);
    assert.deepEqual(waits, [10_000]);
  }
});

test('healthy installs and deterministic failures run exactly once', async () => {
  for (const expected of [0, 1]) {
    let calls = 0;
    assert.equal(await installWithRetry([], {
      run: async () => { calls++; return { status: expected, output: 'ERR_PNPM_OUTDATED_LOCKFILE' }; },
      wait: async () => assert.fail('must not wait'),
    }), expected);
    assert.equal(calls, 1);
  }
});
