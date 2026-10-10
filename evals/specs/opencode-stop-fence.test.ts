import { expect, test } from "vitest";
import { assertSessionContinuation } from "../../apps/server/src/opencode-plugins/opencode-stop-fence-client.js";
import { beginOpencodeStop, normalizeStopDirectory, opencodeSessionIsStopping } from "../../apps/server/src/opencode-stop-fence.js";

const parent = { directory: "/workspace/a", sessionID: "parent" };

test("macOS workspace aliases match the native canonical directory without changing other platforms", () => {
  expect(normalizeStopDirectory("/private/var/folders/workspace", "darwin")).toBe("/var/folders/workspace");
  expect(normalizeStopDirectory("/private/tmp/workspace", "darwin")).toBe("/tmp/workspace");
  expect(normalizeStopDirectory("/private/var/folders/workspace", "linux")).toBe("/private/var/folders/workspace");
  expect(normalizeStopDirectory("/private/variant/workspace", "darwin")).toBe("/private/variant/workspace");
});

test("a native abort fences only its owned session and host instance", () => {
  const host = {};
  const release = beginOpencodeStop(host, parent.directory, parent.sessionID);
  expect(opencodeSessionIsStopping(host, parent)).toBe(true);
  expect(opencodeSessionIsStopping({}, parent)).toBe(false);
  expect(opencodeSessionIsStopping(host, { ...parent, directory: "/workspace/b" })).toBe(false);
  expect(opencodeSessionIsStopping(host, { ...parent, sessionID: "unrelated" })).toBe(false);
  expect(opencodeSessionIsStopping(host, { sessionID: parent.sessionID })).toBe(false);
  release();
  expect(opencodeSessionIsStopping(host, parent)).toBe(false);
});

test("overlapping aborts retain the fence until both settle and disposal is idempotent", () => {
  const host = {};
  const first = beginOpencodeStop(host, parent.directory, parent.sessionID);
  const second = beginOpencodeStop(host, parent.directory, parent.sessionID);
  first();
  first();
  expect(opencodeSessionIsStopping(host, parent)).toBe(true);
  second();
  expect(opencodeSessionIsStopping(host, parent)).toBe(false);
  const next = beginOpencodeStop(host, parent.directory, parent.sessionID);
  expect(opencodeSessionIsStopping(host, parent)).toBe(true);
  next();
  expect(opencodeSessionIsStopping(host, parent)).toBe(false);
});

test("the installed V1 extension forwards its owner and fences dispatch only during abort", async () => {
  const host = {};
  const post = async (path: string, input: Record<string, unknown>) => {
    expect(path).toBe("/experimental/session-stop-fence/check");
    expect(input.directory).toBe(parent.directory);
    if (opencodeSessionIsStopping(host, input)) throw new Error("This task was stopped.");
    return { allowed: true };
  };
  const release = beginOpencodeStop(host, parent.directory, parent.sessionID);
  try {
    await expect(assertSessionContinuation(post, parent)).rejects.toThrow("This task was stopped.");
    await expect(assertSessionContinuation(post, { ...parent, sessionID: "unrelated" })).resolves.toBeUndefined();
    release();
    await expect(assertSessionContinuation(post, parent)).resolves.toBeUndefined();
  } finally {
    release();
  }
});
