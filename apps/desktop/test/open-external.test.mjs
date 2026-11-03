import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { openExternalUrl, resetPendingExternalOpensForTest } from "../electron/open-external.mjs";

const URL_A = "https://den.example.test/?mode=sign-in&desktopAuth=1";

function spawnSpy() {
  const calls = [];
  return { calls, spawnProcess: (...args) => { calls.push(args); return { unref() {} }; } };
}

beforeEach(() => resetPendingExternalOpensForTest());

test("a browser that opens in time reports ok", async () => {
  const spy = spawnSpy();
  const result = await openExternalUrl(URL_A, { openExternal: async () => {}, platform: "win32", spawnProcess: spy.spawnProcess, env: {} });
  assert.deepEqual(result, { ok: true });
  assert.equal(spy.calls.length, 0);
});

test("a slow browser is pending, not failed, and never gets a second rundll32 open", async () => {
  const spy = spawnSpy();
  let finish;
  const slow = new Promise((resolve) => { finish = resolve; });
  const result = await openExternalUrl(URL_A, { openExternal: () => slow, timeoutMs: 20, platform: "win32", spawnProcess: spy.spawnProcess, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(spy.calls.length, 0, "the original request may still open the page; a fallback would add a tab");

  // Clicking again while the first open is still pending does not open another tab.
  let secondCalls = 0;
  const again = await openExternalUrl(URL_A, { openExternal: async () => { secondCalls++; }, platform: "win32", spawnProcess: spy.spawnProcess, env: {} });
  assert.equal(again.pending, true);
  assert.equal(secondCalls, 0);

  // Once the slow open settles, the same URL can be opened again.
  finish();
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const later = await openExternalUrl(URL_A, { openExternal: async () => { secondCalls++; }, platform: "win32", spawnProcess: spy.spawnProcess, env: {} });
  assert.deepEqual(later, { ok: true });
  assert.equal(secondCalls, 1);
});

test("a real failure on Windows still tries the rundll32 fallback once and reports the error", async () => {
  const spy = spawnSpy();
  const result = await openExternalUrl(URL_A, { openExternal: async () => { throw new Error("no handler"); }, platform: "win32", spawnProcess: spy.spawnProcess, env: {} });
  assert.deepEqual(result, { ok: false, error: "no handler" });
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0][1], ["url.dll,FileProtocolHandler", URL_A]);
});

test("the simulated failure switch still works for evals", async () => {
  const result = await openExternalUrl(URL_A, { env: { OPENWORK_SIMULATE_OPEN_EXTERNAL_FAILURE: "1" } });
  assert.deepEqual(result, { ok: false, error: "simulated failure" });
});
