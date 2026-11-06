import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayCustomDiscoverResponse, GatewayCustomModel } from "@openwork/types/den/gateway-custom-providers";
import { connectionKey, createWizardStore, currentTestResult, needsDiscovery, wizardFingerprint, wizardTestModelKey, wizardTestPassed } from "./custom-provider-wizard-store";
import { settingsFromCatalogModel } from "./custom-provider-models";

const gpt: GatewayCustomModel = {
  id: "openai/gpt-4o", attachment: true, reasoning: false, tool_call: true, structured_output: true, temperature: true,
  modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 16384 },
};

const response: GatewayCustomDiscoverResponse = {
  status: "basic", baseUrl: "https://api.acme.test/v1", reason: null, upstreamStatus: 200,
  models: [
    { id: "openai/gpt-4o", model: gpt, match: { providerId: "openrouter", modelId: "openai/gpt-4o", by: "id" } },
    { id: "acme-secret", model: null, match: null },
  ],
};

function connected() {
  const store = createWizardStore();
  const state = store.getState();
  state.setName("Acme");
  state.setBaseUrl("https://api.acme.test/v1/chat/completions");
  state.setApiKey("sk-test");
  return store;
}

test("step 1 refuses to continue until the connection is complete, and points at the field", () => {
  const store = createWizardStore();
  assert.equal(store.getState().next(), false);
  assert.deepEqual(store.getState().highlight, { kind: "field", field: "name" });
  store.getState().setName("Acme");
  assert.equal(store.getState().highlight, null, "typing in the field clears it");
  store.getState().setBaseUrl("api.acme.test/v1");
  assert.equal(store.getState().next(), false);
  assert.deepEqual(store.getState().highlight, { kind: "field", field: "baseUrl" });
  store.getState().setBaseUrl("https://api.acme.test/v1");
  assert.equal(store.getState().next(), false);
  assert.deepEqual(store.getState().highlight, { kind: "field", field: "apiKey" });
  store.getState().setApiKey("sk");
  assert.equal(store.getState().next(), true);
  assert.equal(store.getState().step, 2);
});

test("discovery runs once per connection and keeps every model and edit across steps", () => {
  const store = connected();
  store.getState().next();
  assert.equal(needsDiscovery(store.getState()), true);
  const connection = connectionKey(store.getState());
  store.getState().discoveryStarted(connection);
  store.getState().discoveryFinished(connection, response);
  assert.equal(needsDiscovery(store.getState()), false);
  assert.deepEqual(store.getState().models.map((draft) => [draft.settings.id, draft.selected, draft.configured]), [["openai/gpt-4o", true, true], ["acme-secret", false, false]]);
  assert.equal(store.getState().next(), true);

  const [, unknown] = store.getState().models;
  assert.ok(unknown);
  store.getState().applyTemplate(unknown.key, { id: "x/template", name: "Template", settings: settingsFromCatalogModel({ id: "x/template", name: "Template", config: { tool_call: true, limit: { context: 32000, output: 4000 } } }) });
  const applied = store.getState().models[1];
  assert.equal(applied?.settings.id, "acme-secret", "a template keeps the provider's id");
  assert.equal(applied?.settings.context, "32000");
  assert.equal(applied?.selected, true);

  store.getState().back();
  store.getState().back();
  assert.equal(store.getState().step, 1);
  assert.equal(store.getState().apiKey, "sk-test");
  store.getState().next();
  assert.equal(needsDiscovery(store.getState()), false, "same connection: no new fetch");
  store.getState().goTo(1);
  store.getState().setApiKey("sk-other");
  assert.equal(needsDiscovery(store.getState()), true, "a new key fetches again");
  const next = connectionKey(store.getState());
  store.getState().discoveryStarted(next);
  store.getState().discoveryFinished(next, { ...response, models: [...response.models, { id: "brand-new", model: null, match: null }] });
  assert.deepEqual(store.getState().models.map((draft) => draft.settings.id), ["openai/gpt-4o", "acme-secret", "brand-new"]);
  assert.equal(store.getState().models[1]?.settings.context, "32000", "edits survive a second fetch");
});

test("a discovery answer for an older connection is dropped", () => {
  const store = connected();
  const old = connectionKey(store.getState());
  store.getState().discoveryStarted(old);
  store.getState().setApiKey("changed");
  store.getState().discoveryFinished(old, response);
  assert.equal(store.getState().models.length, 0);
});

test("step 3 needs at least one complete model", () => {
  const store = connected();
  store.setState({ step: 3 });
  assert.equal(store.getState().next(), false);
  assert.equal(store.getState().message, "Pick at least one model.");
  store.getState().addCustomModel();
  const [custom] = store.getState().models;
  assert.ok(custom);
  assert.equal(store.getState().next(), false);
  assert.deepEqual(store.getState().highlight, { kind: "model", key: custom.key, field: "id" });
  store.getState().updateModel(custom.key, { id: "acme-1", context: "8k", outputLimit: "2k" });
  assert.equal(store.getState().highlight, null);
  assert.equal(store.getState().next(), true);
  assert.equal(store.getState().step, 4);
  assert.equal(wizardTestModelKey(store.getState()), custom.key);
});

function readyForTest() {
  const store = connected();
  store.setState({ step: 3 });
  store.getState().addCustomModel();
  const [model] = store.getState().models;
  assert.ok(model);
  store.getState().updateModel(model.key, { id: "acme-1", context: "8k", outputLimit: "2k" });
  store.getState().next();
  return { store, key: model.key };
}

test("Add unlocks only after a pass for exactly what is on screen", () => {
  const { store, key } = readyForTest();
  const fingerprint = wizardFingerprint(store.getState());
  store.getState().testStarted(fingerprint);
  store.getState().testFinished(fingerprint, { ok: true, model: "acme-1", status: 200, code: null, message: null, step: null });
  assert.equal(wizardTestPassed(store.getState()), true);
  store.getState().updateModel(key, { temperature: false });
  assert.equal(wizardTestPassed(store.getState()), false, "any change clears the pass");
  assert.equal(currentTestResult(store.getState()), null);
  store.getState().updateModel(key, { temperature: true });
  assert.equal(wizardTestPassed(store.getState()), true, "undoing the change restores it");
});

test("a result for settings that changed while the test ran is dropped", () => {
  const { store } = readyForTest();
  const fingerprint = wizardFingerprint(store.getState());
  store.getState().testStarted(fingerprint);
  store.getState().setApiKey("another");
  store.getState().testFinished(fingerprint, { ok: true, model: "acme-1", status: 200, code: null, message: null, step: null });
  assert.equal(store.getState().test.state, "running");
  assert.equal(wizardTestPassed(store.getState()), false);
});

test("a failed test sends the admin back to the step that caused it, with fields kept", () => {
  const { store, key } = readyForTest();
  let fingerprint = wizardFingerprint(store.getState());
  store.getState().testStarted(fingerprint);
  store.getState().testFinished(fingerprint, { ok: false, model: "acme-1", status: 401, code: "unauthorized", message: "The key was refused.", step: "connection" });
  assert.equal(store.getState().step, 1);
  assert.deepEqual(store.getState().highlight, { kind: "field", field: "apiKey" });
  assert.equal(store.getState().message, "The key was refused.");
  assert.equal(store.getState().name, "Acme");
  assert.equal(store.getState().models.length, 1);

  store.setState({ step: 4, highlight: null, message: null });
  fingerprint = wizardFingerprint(store.getState());
  store.getState().testStarted(fingerprint);
  store.getState().testFinished(fingerprint, { ok: false, model: "acme-1", status: 404, code: "model_not_found", message: "Unknown model.", step: "model" });
  assert.equal(store.getState().step, 3);
  assert.deepEqual(store.getState().highlight, { kind: "model", key, field: null });
  assert.equal(store.getState().expandedKey, key);

  store.setState({ step: 4, highlight: null, message: null });
  fingerprint = wizardFingerprint(store.getState());
  store.getState().testStarted(fingerprint);
  store.getState().testFinished(fingerprint, { ok: false, model: "acme-1", status: 429, code: "rate_limited", message: "Slow down.", step: null });
  assert.equal(store.getState().step, 4, "rate limits stay on the test step");
  assert.equal(currentTestResult(store.getState())?.ok, false);
});

test("the key stays in memory: the store has no persistence", () => {
  const store = connected();
  assert.equal("persist" in store, false);
});

test("a fetch for a new connection flags only models the last fetch listed, never hand-added ones", () => {
  const store = connected();
  store.getState().next();
  const first = connectionKey(store.getState());
  store.getState().discoveryStarted(first);
  store.getState().discoveryFinished(first, response);
  assert.deepEqual(store.getState().listedModelIds, ["openai/gpt-4o", "acme-secret"]);
  store.getState().addCustomModel();
  const added = store.getState().models.at(-1);
  assert.ok(added);
  store.getState().updateModel(added.key, { id: "acme/by-hand" });

  store.getState().setBaseUrl("https://eu.acme.test/v1");
  const second = connectionKey(store.getState());
  store.getState().discoveryStarted(second);
  store.getState().discoveryFinished(second, { ...response, models: response.models.slice(0, 1) });
  const missing = Object.fromEntries(store.getState().models.map((draft) => [draft.settings.id, draft.missing]));
  assert.deepEqual(missing, { "openai/gpt-4o": false, "acme-secret": true, "acme/by-hand": false });
  assert.deepEqual(store.getState().listedModelIds, ["openai/gpt-4o"]);
});
