import assert from "node:assert/strict";
import { test } from "node:test";
import { renameWithRetry } from "../src/utils.js";

function failing(codes: string[]) {
  const calls: Array<[string, string]> = [];
  const renameImpl = async (from: string, to: string) => {
    calls.push([from, to]);
    const code = codes.shift();
    if (code) throw Object.assign(new Error(`${code}: rename`), { code });
  };
  return { calls, renameImpl };
}

test("retries EPERM on Windows until the lock clears", async () => {
  const { calls, renameImpl } = failing(["EPERM", "EBUSY"]);
  await renameWithRetry("a.tmp", "a.png", { platform: "win32", renameImpl, delaysMs: [0, 0, 0] });
  assert.equal(calls.length, 3);
});

test("rethrows the last error once retries are exhausted", async () => {
  const { calls, renameImpl } = failing(["EPERM", "EPERM", "EPERM"]);
  await assert.rejects(
    renameWithRetry("a.tmp", "a.png", { platform: "win32", renameImpl, delaysMs: [0, 0] }),
    (error: NodeJS.ErrnoException) => error.code === "EPERM",
  );
  assert.equal(calls.length, 3);
});

test("does not retry errors that are not file locks", async () => {
  const { calls, renameImpl } = failing(["ENOENT"]);
  await assert.rejects(
    renameWithRetry("a.tmp", "a.png", { platform: "win32", renameImpl, delaysMs: [0, 0] }),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(calls.length, 1);
});

test("does not retry off Windows", async () => {
  const { calls, renameImpl } = failing(["EPERM"]);
  await assert.rejects(renameWithRetry("a.tmp", "a.png", { platform: "linux", renameImpl }));
  assert.equal(calls.length, 1);
});
