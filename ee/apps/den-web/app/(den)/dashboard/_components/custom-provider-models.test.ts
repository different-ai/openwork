import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayCustomDiscoveredModel, GatewayCustomModel } from "@openwork/types/den/gateway-custom-providers";
import {
  accessGrantChanges, chatCompletionsUrl, checkSelectedModels, connectionError, EMPTY_MODEL_SETTINGS, mergeDiscoveredModels, modelFromSettings, parseCost, parseTokenCount,
  newOriginNeedsKey, resolveTestModelKey, savedProviderNeedsTest, settingsFromCatalogModel, settingsFromModel, testFailureTarget, testFingerprint, type ModelDraft,
} from "./custom-provider-models";

const gpt: GatewayCustomModel = {
  id: "openai/gpt-4o", name: "GPT-4o", attachment: true, reasoning: false, tool_call: true, structured_output: true, temperature: true,
  modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 128000, output: 16384 }, cost: { input: 2.5, output: 10 },
};

function draft(key: string, model: GatewayCustomModel, patch: Partial<ModelDraft> = {}): ModelDraft {
  return { key, settings: settingsFromModel(model), origin: { kind: "saved" }, selected: true, configured: true, missing: false, ...patch };
}

test("token counts accept separators and k/M suffixes, and refuse zero or fractions", () => {
  assert.equal(parseTokenCount("128000"), 128000);
  assert.equal(parseTokenCount("128,000"), 128000);
  assert.equal(parseTokenCount(" 128k "), 128000);
  assert.equal(parseTokenCount("1M"), 1000000);
  assert.equal(parseTokenCount("1.5k"), 1500);
  assert.equal(parseTokenCount("0"), null);
  assert.equal(parseTokenCount("1.5"), null);
  assert.equal(parseTokenCount("lots"), null);
  assert.equal(parseTokenCount(""), null);
});

test("costs are optional USD per million tokens; invalid or negative values are refused", () => {
  assert.equal(parseCost(""), undefined);
  assert.equal(parseCost("  "), undefined);
  assert.equal(parseCost("0.5"), 0.5);
  assert.equal(parseCost("$1.25"), 1.25);
  assert.equal(parseCost("0"), 0);
  assert.equal(parseCost("-1"), null);
  assert.equal(parseCost("cheap"), null);
});

test("a model round-trips through the settings form unchanged", () => {
  const result = modelFromSettings(settingsFromModel(gpt));
  assert.ok(result.ok);
  assert.deepEqual(result.model, gpt);
});

test("reasoning options are saved only while reasoning is on", () => {
  const settings = { ...settingsFromModel(gpt), reasoningToggle: true, reasoningEfforts: "low, medium,high, low" };
  const off = modelFromSettings(settings);
  assert.ok(off.ok);
  assert.equal(off.model.reasoning_options, undefined);
  const on = modelFromSettings({ ...settings, reasoning: true });
  assert.ok(on.ok);
  assert.deepEqual(on.model.reasoning_options, [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }]);
});

test("the settings form points at the first field to fix", () => {
  assert.deepEqual(pickField(modelFromSettings({ ...EMPTY_MODEL_SETTINGS })), "id");
  assert.deepEqual(pickField(modelFromSettings({ ...EMPTY_MODEL_SETTINGS, id: "my model" })), "id");
  assert.deepEqual(pickField(modelFromSettings({ ...EMPTY_MODEL_SETTINGS, id: "m" })), "context");
  assert.deepEqual(pickField(modelFromSettings({ ...EMPTY_MODEL_SETTINGS, id: "m", context: "8k" })), "outputLimit");
  assert.deepEqual(pickField(modelFromSettings({ ...EMPTY_MODEL_SETTINGS, id: "m", context: "8k", outputLimit: "2k", input: [] })), "input");
  assert.deepEqual(pickField(modelFromSettings({ ...EMPTY_MODEL_SETTINGS, id: "m", context: "8k", outputLimit: "2k", costCacheRead: "x" })), "costCacheRead");
  const ok = modelFromSettings({ ...EMPTY_MODEL_SETTINGS, id: "m", name: "m", context: "8k", outputLimit: "2k" });
  assert.ok(ok.ok);
  assert.equal(ok.model.name, undefined, "a name equal to the id is not stored");
  assert.equal(ok.model.cost, undefined);
});

function pickField(result: ReturnType<typeof modelFromSettings>) {
  return result.ok ? null : result.field;
}

test("models.dev templates copy settings and leave unknown limits blank", () => {
  const settings = settingsFromCatalogModel({
    id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4",
    config: { attachment: true, reasoning: true, tool_call: true, temperature: true, modalities: { input: ["text", "image", "pdf", "smell"], output: ["text"] }, limit: { context: 200000, output: 0 }, cost: { input: 3, output: 15, cache_read: 0.3 } },
  });
  assert.equal(settings.id, "anthropic/claude-sonnet-4");
  assert.equal(settings.name, "Claude Sonnet 4");
  assert.deepEqual(settings.input, ["text", "image", "pdf"]);
  assert.equal(settings.context, "200000");
  assert.equal(settings.outputLimit, "");
  assert.equal(settings.costCacheRead, "0.3");
  assert.equal(settings.costCacheWrite, "");
  assert.equal(settings.structuredOutput, false);
});

test("at least one model, all with settings, each id once", () => {
  assert.equal(checkSelectedModels([]).ok, false);
  assert.equal(checkSelectedModels([draft("a", gpt, { selected: false })]).ok, false);
  const unknown: ModelDraft = { key: "u", settings: { ...EMPTY_MODEL_SETTINGS, id: "mystery" }, origin: { kind: "unknown" }, selected: true, configured: false, missing: false };
  const needsSettings = checkSelectedModels([draft("a", gpt), unknown]);
  assert.ok(!needsSettings.ok);
  assert.equal(needsSettings.key, "u");
  const duplicate = checkSelectedModels([draft("a", gpt), draft("b", gpt)]);
  assert.ok(!duplicate.ok);
  assert.equal(duplicate.key, "b");
  assert.equal(duplicate.field, "id");
  const ok = checkSelectedModels([draft("a", gpt), { ...unknown, selected: false }]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.models, [gpt]);
});

test("re-fetching keeps every model and edit, offers new ids and flags missing ones", () => {
  const edited = draft("a", gpt);
  edited.settings.context = "64000";
  const dropped = draft("d", { ...gpt, id: "openai/gpt-3.5" });
  const custom = draft("c", { ...gpt, id: "my-own" }, { origin: { kind: "custom" } });
  const discovered: GatewayCustomDiscoveredModel[] = [
    { id: "openai/gpt-4o", model: gpt, match: { providerId: "openrouter", modelId: "openai/gpt-4o", by: "id" } },
    { id: "new-matched", model: { ...gpt, id: "new-matched" }, match: { providerId: "openrouter", modelId: "x/new-matched", by: "suffix" } },
    { id: "new-unknown", model: null, match: null },
    { id: "new-unknown", model: null, match: null },
  ];
  let next = 0;
  const makeKey = () => `k${++next}`;
  const previouslyListed = new Set(["openai/gpt-4o", "openai/gpt-3.5"]);
  const merged = mergeDiscoveredModels([edited, dropped, custom], discovered, "detailed", { selectMatched: false, makeKey, previouslyListed });
  assert.deepEqual(merged.map((entry) => entry.settings.id), ["openai/gpt-4o", "openai/gpt-3.5", "my-own", "new-matched", "new-unknown"]);
  assert.equal(merged[0]?.settings.context, "64000", "edits stay");
  assert.equal(merged[0]?.missing, false);
  assert.equal(merged[1]?.missing, true, "listed last time, no longer listed");
  assert.equal(merged[1]?.selected, true, "never removed or unticked");
  assert.equal(merged[2]?.missing, false, "a hand-added model was never listed, so it is never flagged");
  assert.equal(merged[3]?.selected, false, "re-fetch offers, doesn't tick");
  assert.equal(merged[3]?.origin.kind, "matched");
  assert.equal(merged[4]?.configured, false);
  const wizard = mergeDiscoveredModels([], discovered, "basic", { selectMatched: true, makeKey, previouslyListed: new Set() });
  assert.deepEqual(wizard.map((entry) => entry.selected), [true, true, false], "the wizard ticks matched models");
  assert.deepEqual(mergeDiscoveredModels([edited], [], "unavailable", { selectMatched: true, makeKey, previouslyListed }), [edited], "an unavailable answer changes nothing");
});

test("connection checks: name, a full URL, and the key when required", () => {
  const base = { name: "Acme", baseUrl: "https://api.acme.test/v1/chat/completions", apiKey: "sk", apiKeyRequired: true };
  assert.equal(connectionError(base), null);
  assert.equal(connectionError({ ...base, name: " " })?.field, "name");
  assert.equal(connectionError({ ...base, baseUrl: "api.acme.test" })?.field, "baseUrl");
  // den-api decides http:// (operator-allowlisted origins only), so the form lets it through.
  assert.equal(connectionError({ ...base, baseUrl: "http://litellm.internal:4000/v1" }), null);
  assert.equal(connectionError({ ...base, baseUrl: "https://user:pw@api.acme.test" })?.field, "baseUrl");
  assert.equal(connectionError({ ...base, apiKey: "" })?.field, "apiKey");
  assert.equal(connectionError({ ...base, apiKey: "", apiKeyRequired: false }), null);
  assert.equal(chatCompletionsUrl(base.baseUrl), "https://api.acme.test/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.acme.test/v1/"), "https://api.acme.test/v1/chat/completions");
  assert.equal(chatCompletionsUrl("nope"), null);
});

test("the test fingerprint changes with the URL, key, ticked models, their settings and the test model", () => {
  const first = draft("a", gpt);
  const second = draft("b", { ...gpt, id: "other" }, { selected: false });
  const drafts = [first, second];
  const input = { baseUrl: "https://api.acme.test/v1", apiKey: "sk", drafts, testModelKey: "a" };
  const base = testFingerprint(input);
  assert.equal(testFingerprint({ ...input, baseUrl: "https://api.acme.test/v1/" }), base, "same normalized URL");
  assert.notEqual(testFingerprint({ ...input, apiKey: "sk2" }), base);
  assert.notEqual(testFingerprint({ ...input, testModelKey: "b" }), base);
  assert.notEqual(testFingerprint({ ...input, drafts: [first, { ...second, selected: true }] }), base);
  assert.notEqual(testFingerprint({ ...input, drafts: [{ ...first, settings: { ...first.settings, temperature: false } }, second] }), base);
  assert.equal(testFingerprint({ ...input, drafts: [first, { ...second, settings: { ...second.settings, context: "1" } }] }), base, "unticked models don't count");
});

test("the test model is the chosen one while ticked, else the first ticked", () => {
  const drafts = [draft("a", gpt, { selected: false }), draft("b", gpt), draft("c", gpt)];
  assert.equal(resolveTestModelKey(drafts, "c"), "c");
  assert.equal(resolveTestModelKey(drafts, "a"), "b");
  assert.equal(resolveTestModelKey(drafts, null), "b");
  assert.equal(resolveTestModelKey([], null), null);
});

test("a failed test points at the key, the URL, the model, or nowhere", () => {
  const failure = (patch: { status: number | null; code: string; step: "connection" | "model" | null }) => ({ ok: false as const, model: "m", message: "x", ...patch });
  assert.deepEqual(testFailureTarget(failure({ status: 401, code: "unauthorized", step: "connection" }), "k"), { step: "connection", field: "apiKey" });
  assert.deepEqual(testFailureTarget(failure({ status: 403, code: "upstream_error", step: "connection" }), "k"), { step: "connection", field: "apiKey" });
  assert.deepEqual(testFailureTarget(failure({ status: null, code: "connect_failed", step: "connection" }), "k"), { step: "connection", field: "baseUrl" });
  assert.deepEqual(testFailureTarget(failure({ status: 404, code: "model_not_found", step: "model" }), "k"), { step: "model", modelKey: "k" });
  assert.equal(testFailureTarget(failure({ status: 429, code: "rate_limited", step: null }), "k"), null);
});

test("a saved provider needs a test only for a new URL, key or model id", () => {
  const saved = { baseUrl: "https://api.acme.test/v1", models: [gpt, { ...gpt, id: "b" }] };
  const same = { baseUrl: "https://api.acme.test/v1/", apiKey: "", models: [gpt] };
  assert.equal(savedProviderNeedsTest(saved, same), false, "removing a model saves directly");
  assert.equal(savedProviderNeedsTest(saved, { ...same, models: [{ ...gpt, limit: { context: 1, output: 1 } }] }), false, "settings save directly");
  assert.equal(savedProviderNeedsTest(saved, { ...same, baseUrl: "https://api2.acme.test/v1" }), true);
  assert.equal(savedProviderNeedsTest(saved, { ...same, apiKey: "sk-new" }), true);
  assert.equal(savedProviderNeedsTest(saved, { ...same, models: [{ ...gpt, id: "renamed" }] }), true);
});

test("access grants: everyone replaces people and teams; changes are minimal", () => {
  const grants = [
    { id: "g1", modelGroupId: "grp", credentialSetId: "set", audience: { type: "team" as const, teamId: "t1" } },
    { id: "g2", modelGroupId: "grp", credentialSetId: "set", audience: { type: "member" as const, memberId: "m1" } },
    { id: "g3", modelGroupId: "other", credentialSetId: "set", audience: { type: "organization" as const } },
  ];
  assert.deepEqual(accessGrantChanges({ accessGrants: grants }, "grp", "set", { orgWide: true, memberIds: ["m1"], teamIds: [] }), { add: [{ type: "organization" }], remove: ["g1", "g2"] });
  assert.deepEqual(accessGrantChanges({ accessGrants: grants }, "grp", "set", { orgWide: false, memberIds: ["m1", "m2"], teamIds: ["t1"] }), { add: [{ type: "member", memberId: "m2" }], remove: [] });
});

test("a URL on another host needs the key pasted again", () => {
  const saved = "https://api.acme.test/v1";
  assert.equal(newOriginNeedsKey(saved, "https://api.acme.test/v2", ""), false, "same origin keeps the saved key");
  assert.equal(newOriginNeedsKey(saved, "https://other.test/v1", ""), true);
  assert.equal(newOriginNeedsKey(saved, "https://other.test/v1", "sk-new"), false);
});
