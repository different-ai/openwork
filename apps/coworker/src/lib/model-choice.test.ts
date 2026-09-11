import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carryVariant,
  chooseFallbackModel,
  chooseModelForLane,
  classifyRequest,
  clearAutoPicked,
  costsNoMoreThan,
  markAutoPicked,
  modelModeOf,
  peekStartingModel,
  previewAutomaticChoice,
  resolveDiscussionModel,
  setStartingModel,
  takeStartingModel,
  wasAutoPicked,
} from "./model-choice.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";
import { connectedModelCatalog, type EngineModelOption } from "./threads.ts";
import { chooseIndexedModel, MODEL_INTELLIGENCE_INDEX, modelSelectionDefaults, normalizeModelSelectionPreferences } from "./model-intelligence.ts";
import { describeTurnFailure } from "./turn-failure.ts";
import { DEFAULT_MODEL_DEFAULTS } from "./model-defaults.ts";

test("the model mode a stored record means: explicit wins, otherwise one model every time (Automatic is chosen in the picker)", () => {
  assert.equal(modelModeOf({ modelMode: "auto", model: "openai/gpt-5" }), "auto");
  assert.equal(modelModeOf({ modelMode: "fixed", model: "" }), "fixed");
  assert.equal(modelModeOf({ model: "openai/gpt-5" }), "fixed");
  assert.equal(modelModeOf({ model: "" }), "fixed");
  assert.equal(modelModeOf({ modelMode: "whatever", model: "  " }), "fixed");
});

test("a lane pick never costs more than the standard model: on a provider that mixes free and paid models the free standard stays among the free", () => {
  const model = (id: string, extra: Partial<EngineModelOption>): EngineModelOption => ({
    id, providerId: id.split("/")[0] ?? "", providerLabel: "OpenCode", modelId: id.split("/")[1] ?? "", modelLabel: id.split("/")[1] ?? "", label: id, description: "", family: "",
    variants: [], isProviderDefault: false, source: "local", tier: "free", toolCall: true, reasoning: true, status: "active", releaseDate: "2026-01-01", cost: { input: 0, output: 0 }, knownPrice: true, ...extra,
  });
  const catalog = { models: [
    model("opencode/big-pickle", { reasoning: true }),
    model("opencode/claude-3-5-haiku", { reasoning: false, cost: { input: 0.8, output: 4 }, releaseDate: "2026-02-01" }),
    model("opencode/ling-2.6-flash-free", { reasoning: false, cost: { input: 0, output: 0 }, releaseDate: "2026-01-15" }),
    model("opencode/claude-opus-4-8", { reasoning: true, cost: { input: 5, output: 25 }, releaseDate: "2026-03-01" }),
    model("opencode/gpt-5.5-pro", { reasoning: true, cost: { input: 30, output: 120 }, releaseDate: "2026-03-02" }),
  ] };
  assert.equal(chooseModelForLane(catalog, "quick", { standard: "opencode/big-pickle" })?.id, "opencode/ling-2.6-flash-free", "the free fast sibling, never the paid haiku");
  assert.equal(chooseModelForLane(catalog, "deep", { standard: "opencode/big-pickle" })?.id, "opencode/big-pickle", "no free deep sibling: the standard model stays; never opus or pro");
  assert.equal(resolveDiscussionModel(catalog, { model: "opencode/big-pickle", modelChosenBy: "app" }, "Prepare a report").model?.id, "opencode/ling-2.6-flash-free", "inherited speaking stays quick without escalating from free to paid");
  const free = { cost: { input: 0, output: 0 }, knownPrice: true };
  assert.equal(costsNoMoreThan(free, free), true);
  assert.equal(costsNoMoreThan({ cost: { input: 0, output: 0 } }, free), false, "zero without provenance is not free");
  assert.equal(costsNoMoreThan({ cost: { input: 0.05, output: 0 }, knownPrice: true }, free), false);
  assert.equal(costsNoMoreThan({ cost: { input: 0, output: 0.05 }, knownPrice: true }, free), false);
  // A paid standard may still step down to cheaper siblings.
  assert.equal(chooseModelForLane(catalog, "quick", { standard: "opencode/claude-opus-4-8" })?.id, "opencode/ling-2.6-flash-free", "known cheaper non-reasoning wins, not a model name");
});

function rawCatalog() {
  return fixtureCatalog({
    connected: ["openai", "anthropic"],
    default: { openai: "gpt-5" },
    all: [
      fixtureProvider({
        id: "openai", name: "OpenAI", source: "env", env: [], options: {},
        models: {
          "gpt-5": { name: "GPT-5", capabilities: { toolcall: true, reasoning: true }, release_date: "2026-06-01" },
          "gpt-5-mini": { name: "GPT-5 mini", capabilities: { toolcall: true, reasoning: false }, release_date: "2026-06-01" },
          "gpt-5-nano": { name: "GPT-5 nano", capabilities: { toolcall: true, reasoning: false }, release_date: "2026-05-01" },
          "gpt-5-pro": { name: "GPT-5 pro", capabilities: { toolcall: true, reasoning: true }, release_date: "2026-07-01" },
          "gpt-4o-mini": { name: "GPT-4o mini", capabilities: { toolcall: true, reasoning: false }, status: "deprecated", release_date: "2024-07-01" },
          "gpt-chat": { name: "GPT Chat", capabilities: { toolcall: false, reasoning: false }, release_date: "2026-08-01" },
        },
      }),
      fixtureProvider({
        id: "anthropic", name: "Anthropic", source: "env", env: [], options: {},
        models: { "claude-haiku-4-5": { name: "Claude Haiku 4.5", capabilities: { toolcall: true, reasoning: false }, release_date: "2025-10-01" } },
      }),
    ],
  });
}

function catalog() { return connectedModelCatalog(rawCatalog()); }

test("chooseModelForLane honours exclusions without replacing an explicit missing or unusable anchor", () => {
  const models = catalog();
  // The fast pick failed: the next fast one, then the standard model itself — never another provider's model for a quick reply.
  assert.equal(chooseModelForLane(models, "quick", { standard: "openai/gpt-5", exclude: ["openai/gpt-5-mini"] })?.id, "openai/gpt-5-nano");
  assert.equal(chooseModelForLane(models, "quick", { standard: "openai/gpt-5", exclude: ["openai/gpt-5-mini", "openai/gpt-5-nano"] })?.id, "openai/gpt-5");
  assert.equal(chooseModelForLane(models, "deep", { standard: "openai/gpt-5", exclude: ["openai/gpt-5-pro"] })?.id, "openai/gpt-5", "a reasoning standard model keeps the deep lane when its bigger sibling is out");
  for (const standard of ["openai/gpt-5", "gone/away", "openai/gpt-4o-mini", "openai/gpt-chat", ""]) {
    for (const lane of ["quick", "standard", "deep"] as const) {
      assert.equal(chooseModelForLane(models, lane, { standard, exclude: ["openai/gpt-5"] }), null, standard);
    }
  }
  assert.equal(chooseModelForLane(models, "standard")?.id, "openai/gpt-5", "recommend only when no anchor is specified");
  // Nothing usable at all.
  assert.equal(chooseModelForLane({ models: [] }, "quick", { standard: "openai/gpt-5" }), null);
  const chatOnly = connectedModelCatalog(fixtureCatalog({
    connected: ["openai"],
    all: [fixtureProvider({ id: "openai", name: "OpenAI", source: "env", env: [], options: {}, models: { "gpt-chat": { name: "GPT Chat", capabilities: { toolcall: false } } } })],
  }));
  assert.equal(chooseModelForLane(chatOnly, "standard", {}), null);
});

test("fallback keeps the original provider and both known price caps before excluding failed models", () => {
  const raw = rawCatalog(), provider = raw.all.find((item) => item.id === "openai");
  const standard = provider?.models["gpt-5"], mini = provider?.models["gpt-5-mini"];
  assert.ok(provider && standard && mini);
  const options = { standard: "openai/gpt-5", exclude: ["openai/gpt-5"] };
  const fresh = () => connectedModelCatalog(raw);
  assert.equal(chooseFallbackModel(fresh(), "quick", options)?.id, "openai/gpt-5-mini", "explicit free-to-free is allowed");
  for (const model of Object.values(provider.models)) {
    if (model !== standard) model.cost = { ...model.cost, input: 1, output: 1 };
  }
  assert.equal(chooseFallbackModel(fresh(), "quick", options), null, "never free-to-paid or to another provider's free model");
  assert.equal(chooseFallbackModel(fresh(), "deep", { ...options, standard: "gone/away" }), null);
  Reflect.deleteProperty(standard.cost, "input");
  assert.equal(chooseFallbackModel(fresh(), "standard", options), null, "no original price means no fallback");
  assert.equal(chooseModelForLane(fresh(), "deep", { standard: options.standard })?.id, options.standard, "unknown prices keep the anchor");
  standard.cost = { ...standard.cost, input: 2, output: 8 };
  mini.cost = { ...mini.cost, input: 2, output: 4 };
  for (const model of Object.values(provider.models)) {
    if (model.id === "gpt-5-nano") model.cost = { ...model.cost, input: 3, output: 1 };
    if (model.id === "gpt-5-pro") model.cost = { ...model.cost, input: 1, output: 9 };
  }
  for (const lane of ["quick", "standard", "deep"] as const) {
    assert.equal(chooseFallbackModel(fresh(), lane, options)?.id, "openai/gpt-5-mini", "equal input, lower output; reject either higher price");
  }
  Reflect.deleteProperty(mini, "cost");
  assert.equal(chooseFallbackModel(fresh(), "quick", options), null, "missing candidate price is not a free replacement");
  assert.equal(chooseModelForLane(fresh(), "quick", { standard: options.standard })?.id, options.standard);
});

test("preferences normalize bounded exact IDs without losing publisher namespaces", () => {
  const defaults = modelSelectionDefaults();
  for (const input of [null, false, [], "cost", { priority: "speed" }]) assert.deepEqual(normalizeModelSelectionPreferences(input), defaults);
  const namespaced = "openrouter/vendor/model:free";
  const long = `provider/${"x".repeat(247)}`;
  const normalized = normalizeModelSelectionPreferences({
    priority: "capability", preferred: { quick: [namespaced, namespaced, " /model", "p/", "p//m", "p/a b", "p/a\nq", "https://host/model", long, `${long}x`, 3], deep: Array.from({ length: 12 }, (_, n) => `p/m${n}`) },
    avoided: ["vendor/pro", "vendor/Pro"], secrets: "not persisted",
  });
  assert.deepEqual(normalized.preferred.quick, [namespaced, long]);
  assert.equal(normalized.preferred.deep.length, 8);
  assert.deepEqual(normalized.avoided, ["vendor/pro", "vendor/Pro"]);
  assert.equal(normalized.priority, "capability");
  defaults.preferred.quick.push(namespaced);
  assert.deepEqual(modelSelectionDefaults().preferred.quick, []);
});

test("ranking uses facts and versioned criteria, not names or release dates", () => {
  const raw = rawCatalog(), provider = raw.all[0];
  assert.ok(provider);
  const base = provider.models["gpt-5"], deep = provider.models["gpt-5-pro"], cheap = provider.models["gpt-5-mini"];
  assert.ok(base && deep && cheap);
  base.capabilities.reasoning = false;
  base.cost = { ...base.cost, input: 3, output: 6 };
  deep.cost = { ...deep.cost, input: 2, output: 4 };
  cheap.cost = { ...cheap.cost, input: 0.1, output: 0.2 };
  deep.limit.context = 256_000;
  const options = { standard: "openai/gpt-5" };
  const first = chooseIndexedModel(connectedModelCatalog(raw), "deep", options);
  assert.equal(first.model?.id, "openai/gpt-5-pro");
  assert.equal(first.indexVersion, MODEL_INTELLIGENCE_INDEX.version);
  assert.match(first.reason, /Reasoning is confirmed/);
  deep.name = "Tiny old chat";
  deep.release_date = "1990-01-01";
  cheap.name = "Ultra deep reasoning pro";
  cheap.release_date = "2099-01-01";
  assert.equal(chooseIndexedModel(connectedModelCatalog(raw), "deep", options).model?.id, first.model?.id);
  const prefs = modelSelectionDefaults();
  prefs.priority = "capability";
  assert.equal(chooseModelForLane(connectedModelCatalog(raw), "quick", { ...options, preferences: prefs })?.id, "openai/gpt-5-pro", "known larger context, not measured quality");
  const previous = MODEL_INTELLIGENCE_INDEX.tasks.deep.criteria;
  try {
    MODEL_INTELLIGENCE_INDEX.tasks.deep.criteria = ["cost", "reasoning", "anchor", "id"];
    assert.equal(chooseIndexedModel(connectedModelCatalog(raw), "deep", options).model?.id, "openai/gpt-5-nano", "editing the index changes selection");
  } finally { MODEL_INTELLIGENCE_INDEX.tasks.deep.criteria = previous; }
  Reflect.deleteProperty(base.limit, "context");
  assert.notEqual(chooseModelForLane(connectedModelCatalog(raw), "quick", { ...options, preferences: prefs })?.id, "openai/gpt-5-pro", "unknown baseline context cannot establish an upgrade");
});

test("exact preferred IDs apply only after route, price and avoidance gates; cost priority stays cheapest", () => {
  const provider = fixtureProvider({ id: "openrouter", name: "Router", models: {
    "vendor/anchor": { name: "Anchor", capabilities: { reasoning: true } },
    "vendor/a:free": { name: "A" }, "vendor/b": { name: "B" }, "vendor/c": { name: "C" },
  } });
  const anchor = provider.models["vendor/anchor"], b = provider.models["vendor/b"], c = provider.models["vendor/c"];
  assert.ok(anchor && b && c);
  anchor.cost = { ...anchor.cost, input: 1, output: 2 };
  b.cost = { ...b.cost, input: 1, output: 1 };
  c.cost = { ...c.cost, input: 0, output: 3 };
  const other = fixtureProvider({ id: "openai", name: "OpenAI", models: { preferred: { name: "Preferred" } } });
  const models = connectedModelCatalog(fixtureCatalog({ all: [provider, other], connected: [provider.id, other.id] }));
  const standard = "openrouter/vendor/anchor", preferences = modelSelectionDefaults();
  preferences.preferred.quick = ["openai/preferred", "openrouter/vendor/c", "openrouter/vendor/b"];
  assert.equal(chooseModelForLane(models, "quick", { standard, preferences })?.id, "openrouter/vendor/b");
  assert.equal(resolveDiscussionModel(models, { model: standard, modelMode: "auto", modelSelectionPreferences: preferences }, "hello").model?.id, "openrouter/vendor/b");
  assert.equal(previewAutomaticChoice(models, standard, preferences).quick?.id, "openrouter/vendor/b");
  assert.equal(chooseFallbackModel(models, "quick", { standard, preferences, exclude: [standard] })?.id, "openrouter/vendor/b");
  preferences.priority = "cost";
  assert.equal(chooseModelForLane(models, "quick", { standard, preferences })?.id, "openrouter/vendor/a:free");
  preferences.avoided = ["openrouter/vendor/a:free", "openrouter/vendor/b"];
  assert.equal(chooseModelForLane(models, "quick", { standard, preferences })?.id, standard);
  assert.equal(chooseFallbackModel(models, "quick", { standard, preferences, exclude: [standard] }), null);
  preferences.avoided = [standard];
  for (const lane of ["quick", "standard", "deep"] as const) assert.equal(chooseModelForLane(models, lane, { standard, preferences }), null);
});

test("unknown metadata never becomes false or confidence; substitutions preserve known modalities and limits", () => {
  for (const missing of ["reasoning", "tools", "status", "text", "image", "context", "input", "output", "price", "none"]) {
    const provider = fixtureProvider({ id: "openai", name: "OpenAI", models: {
      anchor: { name: "Anchor", capabilities: { reasoning: true } },
      sibling: { name: "Flash pro reasoning" },
    } });
    const anchor = provider.models.anchor, sibling = provider.models.sibling;
    assert.ok(anchor && sibling);
    anchor.capabilities.input.image = sibling.capabilities.input.image = true;
    anchor.limit.input = sibling.limit.input = 100_000;
    if (missing === "reasoning") Reflect.deleteProperty(sibling.capabilities, "reasoning");
    if (missing === "tools") Reflect.deleteProperty(sibling.capabilities, "toolcall");
    if (missing === "status") Reflect.deleteProperty(sibling, "status");
    if (missing === "text" || missing === "image") Reflect.deleteProperty(sibling.capabilities.input, missing);
    if (missing === "context" || missing === "input" || missing === "output") sibling.limit[missing] = 1;
    if (missing === "price") sibling.cost.output = -1;
    const catalog = connectedModelCatalog(fixtureCatalog({ all: [provider], connected: [provider.id] }));
    const options = { standard: "openai/anchor" };
    assert.equal(chooseModelForLane(catalog, "quick", options)?.id, missing === "none" ? "openai/sibling" : options.standard, missing);
    assert.equal(chooseFallbackModel(catalog, "quick", { ...options, exclude: [options.standard] })?.id ?? null, missing === "none" ? "openai/sibling" : null, missing);
  }
});

test("discussion resolution shares adjusted message effort across private/group callers and fixed/auto modes", () => {
  const models = catalog();
  for (const model of models.models) model.variants = ["minimal", "low", "medium", "high", "xhigh", "max"];
  for (const scenario of [
    { text: "hello", stop: "balanced", lane: "quick", model: "openai/gpt-5-mini", variant: "low" },
    { text: "hello", stop: "thorough", lane: "standard", model: "openai/gpt-5", variant: "high" },
    { text: "Summarize notes.", stop: "all-in", lane: "deep", model: "openai/gpt-5", variant: "max" },
    { text: "Audit code.", stop: "light", lane: "standard", model: "openai/gpt-5", variant: "minimal" },
    { text: "hello", stop: "invalid", lane: "quick", model: "openai/gpt-5-mini", variant: "low" },
  ]) {
    for (const mode of ["auto", "fixed"]) {
      const coworker = { model: "openai/gpt-5", modelMode: mode, effortPreference: scenario.stop };
      const privateChoice = resolveDiscussionModel(models, coworker, scenario.text);
      const groupMember = { ...coworker, slug: "member", groupId: "group" };
      assert.deepEqual(resolveDiscussionModel(models, groupMember, scenario.text), privateChoice, "caller context does not change model/effort resolution");
      assert.equal(privateChoice.model?.id, mode === "auto" ? scenario.model : coworker.model);
      assert.equal(privateChoice.lane, mode === "auto" ? scenario.lane : "standard");
      assert.equal(privateChoice.variant, scenario.variant, "fixed mode still uses adjusted message effort, not the standard lane's effort");
      assert.equal(privateChoice.indexVersion, MODEL_INTELLIGENCE_INDEX.version);
      assert.ok(privateChoice.reason);
    }
  }
  const base = { model: "openai/gpt-5", modelMode: "auto", effortPreference: "balanced", modelVariant: " high " };
  const inherited = { ...base, useAppModelDefaults: true };
  assert.equal(resolveDiscussionModel(models, inherited, "Prepare a report").variant, "low", "normal speaking ignores the retained override's effort");
  assert.equal(resolveDiscussionModel(models, inherited, "Think carefully about this").variant, "high", "explicit depth still wins");
  const appDefaults = { ...DEFAULT_MODEL_DEFAULTS, conversation: { model: "anthropic/claude-haiku-4-5", modelVariant: "max" } };
  const appChoice = resolveDiscussionModel(models, { ...inherited, model: "gone/retained" }, "hello", appDefaults);
  assert.equal(appChoice.model?.id, appDefaults.conversation.model, "an intentional app choice may change provider; the retained override need not be available");
  assert.equal(appChoice.variant, "max");
  assert.equal(resolveDiscussionModel(models, base, "hello", appDefaults).model?.id, "openai/gpt-5-mini", "legacy selected models do not inherit app choices");
  assert.equal(resolveDiscussionModel(models, inherited, "hello", { ...appDefaults, conversation: { model: "gone/exact", modelVariant: "" } }).model, null, "an unavailable explicit app model cannot fall back");
  const appModel = models.models.find((model) => model.id === appDefaults.conversation.model);
  assert.ok(appModel);
  for (const variants of [["low"], []]) {
    appModel.variants = variants;
    const incompatible = resolveDiscussionModel(models, inherited, "hello", appDefaults);
    assert.equal(incompatible.model, null, "an explicit app effort cannot silently become automatic");
    assert.equal(incompatible.variant, "");
    assert.match(incompatible.reason, /no longer offers thinking effort "max"/);
  }
  const next = chooseFallbackModel(models, "deep", { standard: base.model, exclude: [base.model] });
  assert.ok(next);
  const savedFallback = { ...base, model: next.id, modelVariant: carryVariant("", next), modelChosenBy: "app", useAppModelDefaults: false };
  assert.equal(resolveDiscussionModel(models, savedFallback, "Audit code").variant, "high");
  assert.equal(savedFallback.modelVariant, "", "computed request effort is not a saved fixed preference");
  assert.equal(resolveDiscussionModel(models, savedFallback, "hello").variant, "low", "later turns remain adaptive and opted out of app defaults");
  assert.equal(resolveDiscussionModel(models, base, "hello").variant, "high", "supported fixed effort wins on the selected sibling");
  const sibling = models.models.find((model) => model.id === "openai/gpt-5-mini");
  assert.ok(sibling);
  sibling.variants = ["minimal", "medium"];
  assert.equal(resolveDiscussionModel(models, base, "hello").variant, "minimal", "unsupported fixed effort snaps from the adjusted message baseline");
  sibling.variants = [];
  assert.equal(resolveDiscussionModel(models, base, "hello").variant, "");
});

test("fixed discussion models ignore automatic preferences and never replace an exact missing ID; empty records inherit", () => {
  const models = catalog(), preferences = modelSelectionDefaults();
  preferences.avoided = ["openai/gpt-5"];
  preferences.preferred.quick = ["openai/gpt-5-mini"];
  for (const modelMode of ["fixed", "unknown", undefined]) {
    const fixed = resolveDiscussionModel(models, { model: "openai/gpt-5", modelMode, modelSelectionPreferences: preferences }, "hello");
    assert.equal(fixed.model?.id, "openai/gpt-5");
    assert.equal(fixed.lane, "standard");
    assert.match(fixed.reason, /exact fixed model/);
  }
  assert.equal(resolveDiscussionModel(models, { model: "openai/gpt-5", modelMode: "auto", modelSelectionPreferences: preferences }, "hello").model, null);
  for (const modelMode of ["auto", "fixed"]) {
    assert.equal(resolveDiscussionModel(models, { model: "", modelMode }, "hello").model?.id, "openai/gpt-5-mini");
    assert.equal(resolveDiscussionModel(models, { model: "", modelMode, useAppModelDefaults: false }, "hello").model, null);
    for (const model of ["gone/model", " openai/gpt-5 "]) {
      const choice = resolveDiscussionModel(models, { model, modelMode, modelVariant: "high" }, "hello");
      assert.equal(choice.model, null);
      assert.equal(choice.variant, "");
      if (modelMode === "fixed" && model === "gone/model") {
        assert.ok(choice.reason.includes(model));
        const failure = describeTurnFailure(choice.reason, "Editor");
        assert.equal(failure.headline, "Editor's AI model is not available.");
        assert.equal(failure.modelRelated, true);
        assert.equal(failure.transient, false);
      }
    }
  }
});

test("legacy explicit anchors survive unknown metadata but automatic use refuses explicit unsupported tools/text or deprecation", () => {
  const provider = fixtureProvider({ id: "openai", name: "OpenAI", models: { anchor: { name: "Anchor" } } });
  const raw = provider.models.anchor;
  assert.ok(raw);
  Reflect.deleteProperty(raw, "capabilities");
  Reflect.deleteProperty(raw, "status");
  const models = connectedModelCatalog(fixtureCatalog({ all: [provider], connected: [provider.id] }));
  const anchor = models.models[0];
  assert.ok(anchor?.intelligence);
  for (const lane of ["quick", "standard", "deep"] as const) assert.equal(chooseIndexedModel(models, lane, { standard: anchor.id }).model, anchor);
  assert.equal(chooseIndexedModel(models, "standard").model, null, "unknown metadata does not qualify an initial automatic recommendation");
  for (const refusal of ["tools", "input", "output", "status"]) {
    const facts = anchor.intelligence;
    if (refusal === "tools") facts.tools = false;
    if (refusal === "input" || refusal === "output") facts[refusal].text = false;
    if (refusal === "status") facts.status = "deprecated";
    assert.equal(resolveDiscussionModel(models, { model: anchor.id, modelMode: "auto" }, "hello").model, null, refusal);
    assert.equal(resolveDiscussionModel(models, { model: anchor.id, modelMode: "fixed" }, "hello").model, anchor, "fixed preserves the exact choice, without automatic eligibility or substitution");
    facts.tools = facts.status = facts.input.text = facts.output.text = null;
  }
});

test("unknown anchor reasoning stays unknown when a confirmed sibling meets auto preferences; catalog prices remain authoritative", () => {
  const raw = rawCatalog(), provider = raw.all[0], anchor = provider?.models["gpt-5"];
  assert.ok(anchor);
  Reflect.deleteProperty(anchor.capabilities, "reasoning");
  const models = connectedModelCatalog(raw);
  const selected = resolveDiscussionModel(models, { model: "openai/gpt-5", modelMode: "auto" }, "Research the migration");
  assert.equal(selected.model?.id, "openai/gpt-5-pro");
  assert.match(selected.reason, /Reasoning is confirmed/);
  const baseline = models.models.find((model) => model.id === "openai/gpt-5");
  assert.ok(baseline && selected.model);
  assert.equal(baseline.intelligence?.reasoning, null);
  selected.model.cost = { input: 100, output: 100 };
  selected.model.knownPrice = false;
  assert.equal(costsNoMoreThan(selected.model, baseline), true, "display edits do not replace normalized price evidence");
  Reflect.deleteProperty(anchor.cost, "input");
  assert.equal(resolveDiscussionModel(connectedModelCatalog(raw), { model: baseline.id, modelMode: "auto" }, "Research the migration").model?.id, baseline.id, "missing baseline price blocks the substitution on refresh");
});

test("concise or fast output does not make substantive work shallow; explicit thinking instructions still win", () => {
  for (const prompt of [
    "Quickly audit authentication; give a short answer.",
    "TLDR: research the migration trade-offs.",
    "Briefly implement a fix for this race condition.",
    "One-liner please: ```ts\nconst answer = broken();\n```",
    "Think carefully about the time, but reply briefly.",
  ]) assert.equal(classifyRequest(prompt), "deep", prompt);
  assert.equal(classifyRequest("hello!"), "quick");
  assert.equal(classifyRequest("Summarize yesterday's notes."), "standard");
  assert.equal(classifyRequest("Quickly summarize yesterday's notes in one sentence."), "standard");
  assert.equal(classifyRequest("Audit these files; no need to think."), "quick");
  assert.equal(classifyRequest("No need to think, but double-check the audit carefully."), "deep");
});

test("the person's thinking effort stays across a model change only when the new model offers it", () => {
  const withHigh = { variants: ["low", "medium", "high"] };
  assert.equal(carryVariant("high", withHigh), "high", "kept when offered");
  assert.equal(carryVariant("xhigh", withHigh), "", "an effort the new model does not know returns to the model default");
  assert.equal(carryVariant("high", { variants: [] }), "", "a model without efforts runs at its default");
  assert.equal(carryVariant("high", null), "", "an unknown model (no catalog entry) never keeps a guess");
  assert.equal(carryVariant("", withHigh), "", "the model default stays the model default");
});

test("a model the app picked may be swapped once it fails; a model the person picked never is — before and after a relaunch", () => {
  clearAutoPicked("nova");
  const record = (model: string, modelChosenBy: "app" | "person" | "") => ({ slug: "nova", model, modelChosenBy });
  // Before the record catches up: the session remembers the app's pick.
  assert.equal(wasAutoPicked(record("", ""), "openwork/claude"), false, "nothing picked yet");
  markAutoPicked("nova", "openwork/claude");
  assert.equal(wasAutoPicked(record("", ""), "openwork/claude"), true);
  assert.equal(wasAutoPicked(record("", ""), "openwork/other"), false, "only the exact model the app chose");
  assert.equal(wasAutoPicked({ ...record("", ""), slug: "editor" }, "openwork/claude"), false, "per coworker");
  assert.equal(wasAutoPicked(record("", ""), ""), false, "an empty model is never an automatic pick");
  clearAutoPicked("nova");
  assert.equal(wasAutoPicked(record("", ""), "openwork/claude"), false, "the person choosing (a model or an effort) ends the app's claim on it");
  // After a relaunch the session is empty; the record on disk answers the same way.
  assert.equal(wasAutoPicked(record("openwork/claude", "app"), "openwork/claude"), true, "the app's pick stays the app's pick across a relaunch");
  assert.equal(wasAutoPicked(record("openwork/claude", "app"), "openwork/other"), false, "a turn on another model is not the app's pick");
  assert.equal(wasAutoPicked(record("openwork/claude", "person"), "openwork/claude"), false, "the person's model is never swapped");
  assert.equal(wasAutoPicked(record("openwork/claude", ""), "openwork/claude"), false, "a record that never said who chose is the person's");
});

test("the model chosen on the local mode screen goes to the first coworker once", () => {
  setStartingModel("  ollama/llama3  ");
  assert.equal(peekStartingModel(), "ollama/llama3", "peeking keeps it");
  assert.equal(takeStartingModel(), "ollama/llama3");
  assert.equal(takeStartingModel(), "", "taken once");
  assert.equal(peekStartingModel(), "");
});
