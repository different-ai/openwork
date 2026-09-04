import assert from "node:assert/strict";
import { test } from "node:test";
import { bannedWordIn } from "./local-providers.ts";
import {
  carryVariant,
  chooseModelForLane,
  classifyRequest,
  clearAutoPicked,
  describeModelChoice,
  describeModelPick,
  markAutoPicked,
  modelModeOf,
  peekStartingModel,
  previewAutomaticChoice,
  setStartingModel,
  takeStartingModel,
  wasAutoPicked,
} from "./model-choice.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";
import { connectedModelCatalog } from "./threads.ts";

test("the model mode a stored record means: explicit wins, a chosen model is fixed, a blank is automatic", () => {
  assert.equal(modelModeOf({ modelMode: "auto", model: "openai/gpt-5" }), "auto");
  assert.equal(modelModeOf({ modelMode: "fixed", model: "" }), "fixed");
  assert.equal(modelModeOf({ model: "openai/gpt-5" }), "fixed");
  assert.equal(modelModeOf({ model: "" }), "auto");
  assert.equal(modelModeOf({ modelMode: "whatever", model: "  " }), "auto");
});

test("classifyRequest: the person's words about speed or depth win over the shape of the message", () => {
  assert.equal(classifyRequest("Quickly: what's our launch date?"), "quick");
  assert.equal(classifyRequest("Give me a short answer — should we ship Friday?"), "quick");
  assert.equal(classifyRequest("tl;dr the vendor thread"), "quick");
  assert.equal(classifyRequest("Think carefully about whether we should ship Friday."), "deep");
  assert.equal(classifyRequest("Take your time and be thorough: is the migration plan sound?"), "deep");
  // Both kinds of hint: depth wins, because a careful answer is what the person cannot get back.
  assert.equal(classifyRequest("Quickly but think it through: which vendor?"), "deep");
});

test("classifyRequest: greetings and one-line questions that need no work are quick", () => {
  for (const text of ["hi", "Hey!", "thanks", "Thank you so much", "ok", "Sounds good, will do", "Good morning Nova", "yes", "cool 👍"]) {
    assert.equal(classifyRequest(text), "quick", text);
  }
  assert.equal(classifyRequest("What time is the vendor call tomorrow?"), "quick");
  assert.equal(classifyRequest("Is Priya on the call?"), "quick");
  assert.equal(classifyRequest("What's 15% of 240?"), "quick");
});

test("classifyRequest: anything that asks the coworker to do something is at least standard", () => {
  for (const text of [
    "Check my calendar for Friday",
    "Summarize this",
    "Explain how OAuth refresh works",
    "Why did the build fail?",
    "Schedule a reminder for 9am",
    "Find the latest invoice from Acme",
    "Send Tom the notes",
    "Rewrite this paragraph so it's warmer",
  ]) {
    assert.equal(classifyRequest(text), "standard", text);
  }
});

test("classifyRequest: research, plans, comparisons, drafts, code, and long or many-part messages are deep", () => {
  for (const text of [
    "Compare hosting our own model with using an API.",
    "Put together a launch plan for the onboarding redesign.",
    "Research the top three CRM vendors for a 40-person team.",
    "Draft a proposal for the Q4 roadmap.",
    "What are the trade-offs of moving to Postgres?",
    "Analyze last quarter's churn and tell me the root cause.",
    "```ts\nconst x = foo();\n```\nwhy is x undefined?",
    "TypeError: cannot read properties of undefined (reading 'map') — what happened?",
    "Can you help with three things?\n1. the budget\n2. the hiring plan\n3. the offsite agenda",
    "Where are we on the launch? Who owns the vendor handoff? What's the risk if it slips?",
  ]) {
    assert.equal(classifyRequest(text), "deep", text);
  }
  const long = Array.from({ length: 130 }, (_, index) => `word${index}`).join(" ");
  assert.equal(classifyRequest(long), "deep");
  assert.equal(classifyRequest(""), "standard");
});

function catalog() {
  return connectedModelCatalog(fixtureCatalog({
    connected: ["openai", "anthropic", "opencode"],
    default: { openai: "gpt-5", anthropic: "claude-sonnet-4-5", opencode: "free-chat" },
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
        models: {
          "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", capabilities: { toolcall: true, reasoning: true }, release_date: "2025-09-01" },
          "claude-haiku-4-5": { name: "Claude Haiku 4.5", capabilities: { toolcall: true, reasoning: false }, release_date: "2025-10-01" },
          "claude-opus-4-1": { name: "Claude Opus 4.1", capabilities: { toolcall: true, reasoning: true }, release_date: "2025-08-01" },
        },
      }),
      fixtureProvider({
        id: "opencode", name: "OpenCode", source: "config", env: [], options: {},
        models: {
          "free-chat": { name: "Free Chat", capabilities: { toolcall: true, reasoning: false }, release_date: "2026-01-01" },
        },
      }),
    ],
  }));
}

test("chooseModelForLane anchors on the standard model and stays with its provider: fast for quick, most capable reasoning for deep", () => {
  const models = catalog();
  assert.equal(chooseModelForLane(models, "standard", { standard: "openai/gpt-5" })?.id, "openai/gpt-5");
  assert.equal(chooseModelForLane(models, "quick", { standard: "openai/gpt-5" })?.id, "openai/gpt-5-mini", "newest fast, non-reasoning, not deprecated");
  assert.equal(chooseModelForLane(models, "deep", { standard: "openai/gpt-5" })?.id, "openai/gpt-5-pro", "a bigger reasoning model by name beats the standard one");
  // Anthropic as the standard: Haiku for quick, Opus for deep.
  assert.equal(chooseModelForLane(models, "quick", { standard: "anthropic/claude-sonnet-4-5" })?.id, "anthropic/claude-haiku-4-5");
  assert.equal(chooseModelForLane(models, "deep", { standard: "anthropic/claude-sonnet-4-5" })?.id, "anthropic/claude-opus-4-1");
  // The standard model already being the deep one keeps it.
  assert.equal(chooseModelForLane(models, "deep", { standard: "openai/gpt-5-pro" })?.id, "openai/gpt-5-pro");
  assert.equal(chooseModelForLane(models, "deep", { standard: "anthropic/claude-opus-4-1" })?.id, "anthropic/claude-opus-4-1");
  // A quick standard model stays quick; a standard non-reasoning model keeps itself when nothing faster exists.
  assert.equal(chooseModelForLane(models, "quick", { standard: "openai/gpt-5-mini" })?.id, "openai/gpt-5-mini");
  assert.equal(chooseModelForLane(models, "quick", { standard: "opencode/free-chat" })?.id, "opencode/free-chat");
  // Deep with no reasoning model anywhere near falls back to the standard model, never to a chat-only one.
  assert.equal(chooseModelForLane(models, "deep", { standard: "opencode/free-chat" })?.id, "opencode/free-chat");
});

test("chooseModelForLane honours exclusions and falls back through the standard model to the recommendation", () => {
  const models = catalog();
  // The fast pick failed: the next fast one, then the standard model itself — never another provider's model for a quick reply.
  assert.equal(chooseModelForLane(models, "quick", { standard: "openai/gpt-5", exclude: ["openai/gpt-5-mini"] })?.id, "openai/gpt-5-nano");
  assert.equal(chooseModelForLane(models, "quick", { standard: "openai/gpt-5", exclude: ["openai/gpt-5-mini", "openai/gpt-5-nano"] })?.id, "openai/gpt-5");
  assert.equal(chooseModelForLane(models, "deep", { standard: "openai/gpt-5", exclude: ["openai/gpt-5-pro"] })?.id, "openai/gpt-5", "a reasoning standard model keeps the deep lane when its bigger sibling is out");
  // The standard model itself is excluded: the recommendation anchors the lanes instead.
  const anchored = chooseModelForLane(models, "standard", { standard: "openai/gpt-5", exclude: ["openai/gpt-5"] });
  assert.ok(anchored && anchored.id !== "openai/gpt-5" && anchored.toolCall);
  // Unknown standard (a model that left the catalog) behaves the same way.
  assert.ok(chooseModelForLane(models, "deep", { standard: "gone/away" }));
  // Nothing usable at all.
  assert.equal(chooseModelForLane({ models: [] }, "quick", { standard: "openai/gpt-5" }), null);
  const chatOnly = connectedModelCatalog(fixtureCatalog({
    connected: ["openai"],
    all: [fixtureProvider({ id: "openai", name: "OpenAI", source: "env", env: [], options: {}, models: { "gpt-chat": { name: "GPT Chat", capabilities: { toolcall: false } } } })],
  }));
  assert.equal(chooseModelForLane(chatOnly, "standard", {}), null);
});

test("describeModelChoice names the model only when it differs from the standard lane, and previewAutomaticChoice shows all three", () => {
  const models = catalog();
  const preview = previewAutomaticChoice(models, "openai/gpt-5");
  assert.deepEqual([preview.quick?.id, preview.standard?.id, preview.deep?.id], ["openai/gpt-5-mini", "openai/gpt-5", "openai/gpt-5-pro"]);
  assert.equal(describeModelChoice("quick", preview.quick), "Quick reply on GPT-5 mini");
  assert.equal(describeModelChoice("deep", preview.deep), "Thinking deeply on GPT-5 pro");
  assert.equal(describeModelChoice("standard", preview.standard), "Replying");
  assert.equal(describeModelChoice("quick", preview.quick, { tense: "done" }), "Answered quickly on GPT-5 mini");
  assert.equal(describeModelChoice("deep", null), "Thinking deeply");
  // The live row's suffix and the rail's object; nothing for the standard lane, which needs no explaining.
  assert.equal(describeModelChoice("quick", preview.quick, { tense: "via" }), "quick reply on GPT-5 mini");
  assert.equal(describeModelChoice("deep", preview.deep, { tense: "detail" }), "a deep think on GPT-5 pro");
  assert.equal(describeModelChoice("standard", preview.standard, { tense: "via" }), "");
  assert.equal(describeModelChoice("standard", preview.standard, { tense: "detail" }), "");
});

test("the person's thinking effort stays across a model change only when the new model offers it", () => {
  const withHigh = { variants: ["low", "medium", "high"] };
  assert.equal(carryVariant("high", withHigh), "high", "kept when offered");
  assert.equal(carryVariant(" high ", withHigh), "high", "whitespace never makes it a different effort");
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

test("the app's own pick is explained in one plain line that says where the model came from and what follows", () => {
  assert.equal(describeModelPick({ tier: "cloud" }), "Chosen for you, from your OpenWork account. It stays until you pick one; if it can't answer, the next best takes over once.");
  assert.equal(describeModelPick({ tier: "key" }), "Chosen for you, from a subscription or key on this Mac. It stays until you pick one; if it can't answer, the next best takes over once.");
  assert.equal(describeModelPick({ tier: "local-server" }), "Chosen for you, from a model server on this Mac. It stays until you pick one; if it can't answer, the next best takes over once.");
  assert.equal(describeModelPick({ tier: "free" }), "Chosen for you, the free model, nothing to set up. It stays until you pick one; if it can't answer, the next best takes over once.");
  for (const tier of ["cloud", "key", "local-server", "free"] as const) {
    assert.equal(bannedWordIn(describeModelPick({ tier })), null, "plain words only");
  }
});

test("the model chosen on the local mode screen goes to the first coworker once", () => {
  setStartingModel("  ollama/llama3  ");
  assert.equal(peekStartingModel(), "ollama/llama3", "peeking keeps it");
  assert.equal(takeStartingModel(), "ollama/llama3");
  assert.equal(takeStartingModel(), "", "taken once");
  assert.equal(peekStartingModel(), "");
});
