import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalProviderFinding } from "./bridge";
import {
  IDLE,
  connectReducer,
  pickFreeModel,
  planLocalMode,
  type ConnectState,
} from "./local-providers.ts";
import { connectedModelCatalog } from "./threads.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";

function finding(partial: Partial<LocalProviderFinding> & Pick<LocalProviderFinding, "id" | "kind" | "providerId" | "how">): LocalProviderFinding {
  return { label: partial.id, detail: "", reason: "", ...partial };
}

const model = (name: string, extra: { release_date?: string; capabilities?: { toolcall?: boolean; reasoning?: boolean } } = {}) => ({
  name,
  capabilities: { toolcall: true, reasoning: false, ...extra.capabilities },
  status: "active" as const,
  release_date: extra.release_date ?? "2026-01-01",
});

test("planLocalMode keeps findings out of Found once their provider is connected, lists connected local providers, and names the free model", () => {
  const catalog = connectedModelCatalog(fixtureCatalog({
    connected: ["opencode", "openai", "google", "ollama"],
    default: { opencode: "big-pickle" },
    all: [
      fixtureProvider({ id: "opencode", name: "OpenCode Zen", source: "custom", env: [], options: {}, models: { "big-pickle": model("Big Pickle"), newer: model("Newer", { release_date: "2026-09-01" }) } }),
      fixtureProvider({ id: "openai", name: "OpenAI", source: "custom", env: ["OPENAI_API_KEY"], options: {}, models: { "gpt-5": model("GPT-5"), "gpt-5-mini": model("GPT-5 mini") } }),
      fixtureProvider({ id: "google", name: "Google", source: "env", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], options: {}, models: { gemini: model("Gemini") } }),
      fixtureProvider({ id: "ollama", name: "Ollama", source: "config", env: [], options: { baseURL: "http://127.0.0.1:11434/v1" }, models: { llama: model("llama") } }),
      fixtureProvider({ id: "anthropic", name: "Anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], options: {}, models: { claude: model("Claude") } }),
      fixtureProvider({ id: "github-copilot", name: "GitHub Copilot", source: "custom", env: ["GITHUB_TOKEN"], options: {}, models: { gpt: model("GPT") } }),
    ],
  }));
  const providers = [
    { id: "opencode", name: "OpenCode Zen", env: [], source: "custom", connected: true, modelCount: 2 },
    { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], source: "custom", connected: true, modelCount: 2 },
    { id: "google", name: "Google", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], source: "env", connected: true, modelCount: 1 },
    { id: "ollama", name: "Ollama", env: [], source: "config", connected: true, modelCount: 1 },
    { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], source: "custom", connected: false, modelCount: 1 },
    { id: "github-copilot", name: "GitHub Copilot", env: ["GITHUB_TOKEN"], source: "custom", connected: false, modelCount: 1 },
  ];
  const findings = [
    finding({ id: "codex", kind: "codex", providerId: "openai", how: "import", label: "ChatGPT (signed in with Codex)" }),
    finding({ id: "claude-code", kind: "claude-code", providerId: "anthropic", how: "unavailable", reason: "These credentials cannot be imported into Open Coworker. Add an Anthropic API key instead." }),
    finding({ id: "copilot", kind: "copilot", providerId: "github-copilot", how: "import" }),
    finding({ id: "env:GEMINI_API_KEY", kind: "env", providerId: "google", how: "in-use", envName: "GEMINI_API_KEY" }),
  ];
  const plan = planLocalMode({ findings, readiness: { providers, signIns: { openai: [{ index: 0, label: "ChatGPT" }], "github-copilot": [{ index: 0, label: "Copilot" }] } }, catalog });
  assert.deepEqual(plan.found.map((entry) => entry.id), ["claude-code", "copilot"], "the Codex and key findings moved under Connected");
  assert.deepEqual(plan.connected.map(({ providerId, canDisconnect }) => [providerId, canDisconnect]), [["google", false], ["ollama", true], ["openai", true]]);
  assert.deepEqual(plan.free, { available: true, modelLabel: "Big Pickle" }, "the free provider's default is the free model");
  assert.deepEqual(plan.addable.map((entry) => [entry.id, entry.envName, entry.canSignIn, entry.acceptsKey, entry.connected]), [
    ["openai", "OPENAI_API_KEY", true, true, true],
    ["anthropic", "ANTHROPIC_API_KEY", false, true, false],
    ["google", "GOOGLE_API_KEY", false, true, true],
    ["github-copilot", "GITHUB_TOKEN", true, false, false],
  ], "only well-known providers the AI service lists are offered");
  const keyPlan = planLocalMode({ findings, readiness: { providers: providers.map((provider) => provider.id === "openai" ? { ...provider, source: "api" } : provider), signIns: {} }, catalog });
  assert.equal(keyPlan.connected.find((provider) => provider.providerId === "openai")?.detail, "An API key saved on this Mac; shared with OpenWork Desktop.", "a saved key is not described as a ChatGPT subscription just because Codex was detected");
  const noCopilotSignIn = planLocalMode({ findings, readiness: { providers, signIns: {} }, catalog });
  assert.deepEqual(noCopilotSignIn.addable.map((entry) => entry.id), ["openai", "anthropic", "google"], "a subscription-only provider without a sign-in is not offered");
  assert.equal(pickFreeModel({ models: [] }), null);
  const withoutFree = planLocalMode({ findings: [], readiness: { providers: [], signIns: {} }, catalog: { models: [] } });
  assert.deepEqual(withoutFree, { found: [], connected: [], free: { available: false, modelLabel: "" }, addable: [] });
});

test("the connect state machine: one-step connect, a failure that offers sign-in, and a sign-in that waits on the AI service", () => {
  let state: ConnectState = IDLE;
  state = connectReducer(state, { type: "connect" });
  assert.deepEqual(state, { phase: "connecting" });
  state = connectReducer(state, { type: "result", result: { status: "connected", providerId: "openai", label: "ChatGPT", modelCount: 6 } });
  assert.equal(state.phase, "connected");

  state = connectReducer(IDLE, { type: "result", result: { status: "failed", providerId: "openai", label: "ChatGPT", error: "Codex's sign-in has expired — sign in again in Codex, then Connect.", fallback: "sign-in" } });
  assert.deepEqual(state, { phase: "failed", error: "Codex's sign-in has expired — sign in again in Codex, then Connect.", canSignIn: true });

  state = connectReducer(state, { type: "sign-in-started", start: { attemptId: "sia_1", providerId: "github-copilot", url: "https://github.com/login/device", code: "ABCD-1234", instructions: "Enter code: ABCD-1234", label: "Copilot" } });
  assert.equal(state.phase, "waiting");
  assert.equal(state.phase === "waiting" && state.attemptId, "sia_1");
  assert.deepEqual(connectReducer(state, { type: "sign-in-status", status: { state: "waiting", error: "", modelCount: 0 } }), state, "still waiting");
  assert.equal(connectReducer(state, { type: "sign-in-status", status: { state: "connected", error: "", modelCount: 1 } }).phase, "connected");
  assert.deepEqual(connectReducer(state, { type: "sign-in-status", status: { state: "failed", error: "The sign-in took too long. Try again.", modelCount: 0 } }), { phase: "failed", error: "The sign-in took too long. Try again.", canSignIn: true });
  assert.deepEqual(connectReducer(state, { type: "cancel" }), IDLE);
  assert.deepEqual(connectReducer(IDLE, { type: "sign-in-status", status: { state: "connected", error: "", modelCount: 3 } }), IDLE, "a late status never resurrects a row");
});
