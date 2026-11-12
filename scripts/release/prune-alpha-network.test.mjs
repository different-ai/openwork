import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDeferPruning } from './prune-alpha-assets.mjs';

test('post-publication cleanup can defer exhausted transport outages only when opted in', () => {
  for (const message of ['gh: Server Error (HTTP 502)', 'read: connection reset by peer', 'HTTP 503']) {
    assert.equal(canDeferPruning(new Error(message), []), false);
    assert.equal(canDeferPruning(new Error(message), ['--allow-transient-failure']), true);
  }
  for (const message of ['HTTP 403 forbidden', 'HTTP 401', 'Invalid --keep', 'checksum mismatch', 'HTTP 502 followed by HTTP 403']) {
    assert.equal(canDeferPruning(new Error(message), ['--allow-transient-failure']), false);
  }
});
