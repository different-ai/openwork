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
  setStartingModel,
  takeStartingModel,
  wasAutoPicked,
} from "./model-choice.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";
import { connectedModelCatalog, type EngineModelOption } from "./threads.ts";

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
  const free = { cost: { input: 0, output: 0 }, knownPrice: true };
  assert.equal(costsNoMoreThan(free, free), true);
  assert.equal(costsNoMoreThan({ cost: { input: 0, output: 0 } }, free), false, "zero without provenance is not free");
  assert.equal(costsNoMoreThan({ cost: { input: 0.05, output: 0 }, knownPrice: true }, free), false);
  assert.equal(costsNoMoreThan({ cost: { input: 0, output: 0.05 }, knownPrice: true }, free), false);
  // A paid standard may still step down to cheaper siblings.
  assert.equal(chooseModelForLane(catalog, "quick", { standard: "opencode/claude-opus-4-8" })?.id, "opencode/claude-3-5-haiku");
});

function catalog() {
  return connectedModelCatalog(fixtureCatalog({
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
  }));
}

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
  const models = catalog();
  const standard = models.models.find((model) => model.id === "openai/gpt-5");
  const mini = models.models.find((model) => model.id === "openai/gpt-5-mini");
  assert.ok(standard && mini);
  const options = { standard: standard.id, exclude: [standard.id] };
  assert.equal(chooseFallbackModel(models, "quick", options)?.id, mini.id, "explicit free-to-free is allowed");
  for (const model of models.models) {
    if (model.providerId === standard.providerId && model !== standard) model.cost = { input: 1, output: 1 };
  }
  assert.equal(chooseFallbackModel(models, "quick", options), null, "never free-to-paid or to another provider's free model");
  assert.equal(chooseFallbackModel(models, "deep", { ...options, standard: "gone/away" }), null);
  standard.knownPrice = false;
  assert.equal(chooseFallbackModel(models, "standard", options), null, "no original price means no fallback");
  assert.equal(chooseModelForLane(models, "deep", { standard: standard.id })?.id, standard.id, "unknown prices keep the anchor");
  standard.knownPrice = true;
  standard.cost = { input: 2, output: 8 };
  mini.cost = { input: 2, output: 4 };
  for (const model of models.models) {
    if (model.modelId === "gpt-5-nano") model.cost = { input: 3, output: 1 };
    if (model.modelId === "gpt-5-pro") model.cost = { input: 1, output: 9 };
  }
  for (const lane of ["quick", "standard", "deep"] as const) {
    assert.equal(chooseFallbackModel(models, lane, options)?.id, mini.id, "equal input, lower output; reject either higher price");
  }
  mini.cost = { input: 0, output: 0 };
  delete mini.knownPrice;
  assert.equal(chooseFallbackModel(models, "quick", options), null, "missing candidate price is not a free replacement");
  assert.equal(chooseModelForLane(models, "quick", { standard: standard.id })?.id, standard.id);
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
