import assert from "node:assert/strict";
import { test } from "node:test";
import { compileVerification, runVerification } from "../packages/testkit/src/verification.ts";
import { normalizeRouterEditorValues, normalizeSavedRouterSnapshot, offlineRoutingEvaluator, routingAnswerMetadata, routingCheckIds, routingDictionary, routingIntent, unsupportedRoutingIntent } from "./gateway-routing-verification.ts";

test("offline fixture covers the complete claim and abstains on unsupported intent", async () => {
  const result = await compileVerification({ intent: routingIntent, dictionary: routingDictionary, evaluate: offlineRoutingEvaluator });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected complete selection");
  assert.deepEqual(result.plan.checkIds, routingCheckIds);
  const unsupported = await compileVerification({ intent: unsupportedRoutingIntent, dictionary: routingDictionary, evaluate: offlineRoutingEvaluator });
  assert.equal(unsupported.status, "incomplete");
});

test("serialized plan replays twice without model calls; wrong revision and categories fail", async () => {
  let calls = 0;
  const compiled = await compileVerification({ intent: routingIntent, dictionary: routingDictionary, evaluate: request => {
    calls++;
    return offlineRoutingEvaluator(request);
  } });
  if (compiled.status !== "ready") throw new Error("Expected complete selection");
  const plan = JSON.parse(JSON.stringify(compiled.plan));
  let revision = 2;
  let category = "Clear business writing";
  let editorCategory = "Clear business writing";
  const input: Parameters<typeof runVerification>[0] = {
    plan, dictionary: routingDictionary,
    observations: {
      "router-editor-values": { version: "1", read: async () => normalizeRouterEditorValues(["Daily work revised", "Code review and debugging", editorCategory, "0.75"]) },
      "saved-router-snapshot": { version: "1", read: async () => normalizeSavedRouterSnapshot([{ revision, name: "Daily work revised", status: "active", minConfidence: 0.75,
        routes: [{ description: "Code review and debugging" }, { description: category }] }]) },
    },
    // Unit-only channel witnesses: no browser actions or network transport.
    channels: {
      user: { see: async () => {}, notSee: async () => {} },
      probe: { text: async () => "", eventually: async (fn, options) => {
        const value = await fn();
        assert.equal(options.until?.(value), true, "persisted value mismatch");
        return value;
      } },
      step: async (_name, fn) => fn(),
    },
  };
  for (let replay = 0; replay < 2; replay++) {
    const result = await runVerification(input);
    assert.equal(result.status, "passed");
    assert.equal(result.modelCalls, 0);
  }
  revision = 1;
  await assert.rejects(() => runVerification(input), /persisted value mismatch/);
  revision = 2;
  category = "Writing and editing";
  await assert.rejects(() => runVerification(input), /persisted value mismatch/);
  category = "Clear business writing";
  editorCategory = "Writing and editing";
  await assert.rejects(() => runVerification(input), /persisted value mismatch/);
  assert.equal(calls, 1);
});

test("observation normalization validates shape without coercion or mutation", () => {
  const values = Object.freeze(["Daily work revised", "Code review and debugging", "Clear business writing", "0.75"]);
  assert.deepEqual(normalizeRouterEditorValues(values), values);
  assert.notEqual(normalizeRouterEditorValues(values), values);
  assert.throws(() => normalizeRouterEditorValues(["name", "one", "two", 0.75]), /Invalid/);
  assert.throws(() => normalizeSavedRouterSnapshot([]), /Invalid/);
  assert.throws(() => normalizeSavedRouterSnapshot([{ name: "name", revision: "2" }]), /Invalid/);
});

test("diagnostic metadata retains below-threshold typed answers but excludes arbitrary provider data", () => {
  assert.deepEqual(routingAnswerMetadata({ answers: {
    coverage: { type: "boolean", probability: 0.89, extra: "excluded" },
    check_0: { type: "boolean", probability: 0.88 },
    check_1: { type: "text", probability: 1 },
    check_2: { type: "boolean", probability: NaN },
    other: { type: "boolean", probability: 1 },
  }, extra: "excluded" }), { answers: {
    coverage: { type: "boolean", probability: 0.89 }, check_0: { type: "boolean", probability: 0.88 },
  } });
});
