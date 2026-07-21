import assert from "node:assert/strict";
import test from "node:test";

import { EvalContext, EvalError } from "./context.mjs";

function createContext(send) {
  return new EvalContext({
    client: { send },
    outDir: "/tmp/openwork-eval-context-test",
    flowId: "context-test",
    env: {},
  });
}

function evaluated(value) {
  return { result: { value } };
}

function evaluateInPage(expression, window) {
  return Function("window", `return ${expression}`)(window);
}

test("waitForRoute prefers the canonical control route immediately", async () => {
  let calls = 0;
  const ctx = createContext(async (method, params) => {
    calls += 1;
    assert.equal(method, "Runtime.evaluate");
    assert.match(params.expression, /__openworkControl/);
    assert.match(params.expression, /location\.hash/);
    return evaluated(evaluateInPage(params.expression, {
      __openworkControl: { snapshot: () => ({ route: "/settings/general" }) },
      location: { hash: "#/settings/advanced", pathname: "/" },
    }));
  });

  assert.equal(await ctx.waitForRoute("#/settings/general"), "/settings/general");
  assert.equal(calls, 1);
});

test("waitForRoute falls back to the Electron URL hash", async () => {
  const ctx = createContext(async (_method, params) => evaluated(evaluateInPage(params.expression, {
    location: { hash: "#/settings/general", pathname: "/" },
  })));

  assert.equal(await ctx.waitForRoute("/settings/general"), "/settings/general");
});

test("waitForRoute reports the last observed route at the configured deadline", async () => {
  const ctx = createContext(async () => evaluated("/settings/advanced"));
  const startedAt = Date.now();

  await assert.rejects(
    ctx.waitForRoute("/settings/general", { timeoutMs: 30 }),
    (error) => {
      assert(error instanceof EvalError);
      assert.match(error.message, /Timed out after 30ms/);
      assert.match(error.message, /last observed route: "\/settings\/advanced"/);
      return true;
    },
  );
  assert(Date.now() - startedAt < 1_000, "route wait fell through to the 20-second CDP timeout");
});

test("waitForRoute bounds a browser probe that never resolves", async () => {
  const ctx = createContext(async () => new Promise(() => {}));
  const startedAt = Date.now();

  await assert.rejects(
    ctx.waitForRoute("/settings/general", { timeoutMs: 30 }),
    (error) => {
      assert(error instanceof EvalError);
      assert.match(error.message, /Route probe timed out/);
      return true;
    },
  );
  assert(Date.now() - startedAt < 1_000, "stalled route probe fell through to the 20-second CDP timeout");
});
