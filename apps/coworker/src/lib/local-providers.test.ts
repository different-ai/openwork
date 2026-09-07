import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LocalProviderFinding } from "./bridge";
import {
  BANNED_WORDS,
  IDLE,
  LOCAL_MODE_COPY,
  bannedWordIn,
  busyProviderIds,
  connectReducer,
  pickFreeModel,
  planLocalMode,
  type ConnectState,
} from "./local-providers.ts";
import { connectedModelCatalog } from "./threads.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function finding(partial: Partial<LocalProviderFinding> & Pick<LocalProviderFinding, "id" | "kind" | "providerId" | "how">): LocalProviderFinding {
  return { label: partial.id, detail: "", reason: "", ...partial };
}

const model = (name: string, extra: { release_date?: string; capabilities?: { toolcall?: boolean; reasoning?: boolean } } = {}) => ({
  name,
  capabilities: { toolcall: true, reasoning: false, ...extra.capabilities },
  status: "active" as const,
  release_date: extra.release_date ?? "2026-01-01",
});

test("every line of local mode copy reads plainly", () => {
  const lines: string[] = [
    LOCAL_MODE_COPY.freeDetail("Big Pickle"),
    LOCAL_MODE_COPY.freeDetail(""),
    LOCAL_MODE_COPY.waitingCode("ABCD-1234"),
    LOCAL_MODE_COPY.connectedLine(1),
    LOCAL_MODE_COPY.keyHint("OPENAI_API_KEY"),
    LOCAL_MODE_COPY.keyHint(""),
    LOCAL_MODE_COPY.customListed(2),
  ];
  for (const entry of Object.values(LOCAL_MODE_COPY)) if (typeof entry === "string") lines.push(entry);
  assert.ok(lines.length > 40, "the whole copy table is covered");
  for (const line of lines) assert.equal(bannedWordIn(line), null, `"${line}" uses a word that belongs under Technical details`);
  assert.equal(bannedWordIn("The engine is ready"), "engine");
  assert.equal(bannedWordIn("Set the base URL first"), "base URL");
  assert.equal(bannedWordIn("Sign in with OAuth"), "OAuth");
  assert.equal(bannedWordIn("Uses the compatible SDK"), "SDK");
  assert.equal(bannedWordIn("Provider ID: openai"), "provider id");
  assert.equal(bannedWordIn("engineering a plan"), null, "only whole words count");
  assert.equal(BANNED_WORDS.length, 6);
});

test("the local mode screens' visible sentences avoid the banned words (source scan)", async () => {
  // Strip attributes that never render, then look at JSX text and sentence-like string literals.
  const files = ["../ui/local-providers.tsx", "../ui/openwork-settings.tsx"];
  for (const file of files) {
    const source = (await readFile(path.join(here, file), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/(className|data-testid|aria-label|key|href|id|title)=\{?["'`][^"'`]*["'`]\}?/g, "");
    const looksLikeCode = (text: string) => /[={}()<>;]|=>|\$\{/.test(text);
    const sentences = [
      ...[...source.matchAll(/>([^<>{}]*[a-z][^<>{}]*)</g)].map((match) => match[1] ?? ""),
      ...[...source.matchAll(/"([^"\n]*)"/g)].map((match) => match[1] ?? ""),
      ...[...source.matchAll(/'([^'\n]*)'/g)].map((match) => match[1] ?? ""),
      ...[...source.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? ""),
    ].map((text) => text.trim()).filter((text) => text.includes(" ") && !looksLikeCode(text));
    assert.ok(sentences.length > 12, `${file}: the scan found only ${sentences.length} sentences, so it is not looking at the right thing`);
    for (const sentence of sentences) {
      assert.equal(bannedWordIn(sentence), null, `${file}: "${sentence}"`);
    }
  }
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
    finding({ id: "claude-code", kind: "claude-code", providerId: "anthropic", how: "unavailable", reason: "Claude subscriptions only work inside Claude Code. Add an Anthropic key instead." }),
    finding({ id: "copilot", kind: "copilot", providerId: "github-copilot", how: "import" }),
    finding({ id: "env:GEMINI_API_KEY", kind: "env", providerId: "google", how: "in-use", envName: "GEMINI_API_KEY" }),
  ];
  const plan = planLocalMode({ findings, readiness: { providers, signIns: { openai: [{ index: 0, label: "ChatGPT" }], "github-copilot": [{ index: 0, label: "Copilot" }] } }, catalog });
  assert.deepEqual(plan.found.map((entry) => entry.id), ["claude-code", "copilot"], "the Codex and key findings moved under Connected");
  assert.deepEqual(plan.connected, [
    { providerId: "google", label: "Google", modelCount: 1, detail: "From GEMINI_API_KEY in your environment.", canDisconnect: false },
    { providerId: "ollama", label: "Ollama", modelCount: 1, detail: "A server you added here.", canDisconnect: true },
    { providerId: "openai", label: "OpenAI", modelCount: 2, detail: "Your ChatGPT subscription, signed in with Codex.", canDisconnect: true },
  ]);
  assert.deepEqual(plan.free, { available: true, modelLabel: "Big Pickle" }, "the free provider's default is the free model");
  assert.deepEqual(plan.addable.map((entry) => [entry.id, entry.envName, entry.canSignIn, entry.acceptsKey, entry.connected]), [
    ["openai", "OPENAI_API_KEY", true, true, true],
    ["anthropic", "ANTHROPIC_API_KEY", false, true, false],
    ["google", "GOOGLE_API_KEY", false, true, true],
    ["github-copilot", "GITHUB_TOKEN", true, false, false],
  ], "only well-known providers the AI service lists are offered");
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
  assert.deepEqual(state, { phase: "connected", line: "Connected. 6 models available." });

  state = connectReducer(IDLE, { type: "result", result: { status: "failed", providerId: "openai", label: "ChatGPT", error: "Codex's sign-in has expired — sign in again in Codex, then Connect.", fallback: "sign-in" } });
  assert.deepEqual(state, { phase: "failed", error: "Codex's sign-in has expired — sign in again in Codex, then Connect.", canSignIn: true });

  state = connectReducer(state, { type: "sign-in-started", start: { attemptId: "sia_1", providerId: "github-copilot", url: "https://github.com/login/device", code: "ABCD-1234", instructions: "Enter code: ABCD-1234", label: "Copilot" } });
  assert.deepEqual(state, { phase: "waiting", attemptId: "sia_1", url: "https://github.com/login/device", code: "ABCD-1234", line: "Enter the code ABCD-1234 in your browser; this line updates by itself." });
  assert.deepEqual(connectReducer(state, { type: "sign-in-status", status: { state: "waiting", error: "", modelCount: 0 } }), state, "still waiting");
  assert.deepEqual(connectReducer(state, { type: "sign-in-status", status: { state: "connected", error: "", modelCount: 1 } }), { phase: "connected", line: "Connected. 1 model available." });
  assert.deepEqual(connectReducer(state, { type: "sign-in-status", status: { state: "failed", error: "The sign-in took too long. Try again.", modelCount: 0 } }), { phase: "failed", error: "The sign-in took too long. Try again.", canSignIn: true });
  assert.deepEqual(connectReducer(state, { type: "cancel" }), IDLE);
  assert.deepEqual(connectReducer(IDLE, { type: "sign-in-status", status: { state: "connected", error: "", modelCount: 3 } }), IDLE, "a late status never resurrects a row");

  const browser = connectReducer(IDLE, { type: "sign-in-started", start: { attemptId: "sia_2", providerId: "openai", url: "https://auth.example/authorize", code: "", instructions: "Complete authorization in your browser.", label: "ChatGPT" } });
  assert.equal(browser.phase === "waiting" && browser.line, "Finish signing in in your browser; this line updates by itself.");
  assert.deepEqual(busyProviderIds({ a: IDLE, b: { phase: "connecting" }, c: browser, d: { phase: "connected", line: "" } }), ["b", "c"]);
});
