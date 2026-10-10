import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSessionContinuation } from "../src/opencode-plugins/opencode-stop-fence-client.js";
import { beginOpencodeStop, normalizeStopDirectory, opencodeSessionIsStopping } from "../src/opencode-stop-fence.js";

const parent = { directory: "/workspace/a", sessionID: "parent" };

test("macOS workspace aliases match the native canonical directory without changing other platforms", () => {
  assert.equal(normalizeStopDirectory("/private/var/folders/workspace", "darwin"), "/var/folders/workspace");
  assert.equal(normalizeStopDirectory("/private/tmp/workspace", "darwin"), "/tmp/workspace");
  assert.equal(normalizeStopDirectory("/private/var/folders/workspace", "linux"), "/private/var/folders/workspace");
  assert.equal(normalizeStopDirectory("/private/variant/workspace", "darwin"), "/private/variant/workspace");
});

test("a native abort fences only its owned session and host instance", () => {
  const host = {};
  const release = beginOpencodeStop(host, parent.directory, parent.sessionID);
  assert.equal(opencodeSessionIsStopping(host, parent), true);
  assert.equal(opencodeSessionIsStopping({}, parent), false);
  assert.equal(opencodeSessionIsStopping(host, { ...parent, directory: "/workspace/b" }), false);
  assert.equal(opencodeSessionIsStopping(host, { ...parent, sessionID: "unrelated" }), false);
  assert.equal(opencodeSessionIsStopping(host, { sessionID: parent.sessionID }), false);
  release();
  assert.equal(opencodeSessionIsStopping(host, parent), false);
});

test("overlapping aborts retain the fence until both settle and disposal is idempotent", () => {
  const host = {};
  const first = beginOpencodeStop(host, parent.directory, parent.sessionID);
  const second = beginOpencodeStop(host, parent.directory, parent.sessionID);
  first();
  first();
  assert.equal(opencodeSessionIsStopping(host, parent), true);
  second();
  assert.equal(opencodeSessionIsStopping(host, parent), false);
  const next = beginOpencodeStop(host, parent.directory, parent.sessionID);
  assert.equal(opencodeSessionIsStopping(host, parent), true);
  next();
  assert.equal(opencodeSessionIsStopping(host, parent), false);
});

test("the installed V1 extension forwards its owner and fences dispatch only during abort", async () => {
  const host = {};
  const post = async (path: string, input: Record<string, unknown>) => {
    assert.equal(path, "/experimental/session-stop-fence/check");
    assert.equal(input.directory, parent.directory);
    if (opencodeSessionIsStopping(host, input)) throw new Error("This task was stopped.");
    return { allowed: true };
  };
  const release = beginOpencodeStop(host, parent.directory, parent.sessionID);
  try {
    await assert.rejects(assertSessionContinuation(post, parent), /This task was stopped\./);
    assert.equal(await assertSessionContinuation(post, { ...parent, sessionID: "unrelated" }), undefined);
    release();
    assert.equal(await assertSessionContinuation(post, parent), undefined);
  } finally {
    release();
  }
});
