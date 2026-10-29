import assert from "node:assert/strict";
import { test } from "node:test";
import {
  promptShowReasoning,
  registerVisibleReasoning,
  visibleReasoningOptions,
  type VisibleReasoningContext,
} from "../src/opencode-plugins/openwork-visible-reasoning-v2.js";

const adaptive = { thinking: { type: "adaptive", display: "summarized" }, effort: "high" };
const claude = {
  id: "gwm_claude", providerID: "ipr_gateway", package: "@opencode/ai/providers/anthropic",
  variants: [{ id: "none", settings: { thinking: { type: "disabled" } } }, { id: "high", settings: adaptive }],
};

test("reads the choice from prompt metadata", () => {
  assert.equal(promptShowReasoning({ openwork: { showReasoning: true } }), true);
  assert.equal(promptShowReasoning({ openwork: { showReasoning: false } }), false);
  assert.equal(promptShowReasoning({ openwork: {} }), undefined);
  assert.equal(promptShowReasoning(undefined), undefined);
});

test("asks a default Claude variant for summarized adaptive thinking", () => {
  assert.deepEqual(visibleReasoningOptions(claude, "default"), { thinking: { type: "adaptive", display: "summarized" } });
  assert.deepEqual(visibleReasoningOptions(claude, undefined), { thinking: { type: "adaptive", display: "summarized" } });
});

test("never switches thinking on for a variant that turned it off", () => {
  assert.equal(visibleReasoningOptions(claude, "none"), null);
});

test("leaves a variant that already shows reasoning unchanged", () => {
  assert.equal(visibleReasoningOptions(claude, "high"), null);
  const omitted = { ...claude, variants: [{ id: "high", settings: { thinking: { type: "adaptive", display: "omitted" } } }] };
  assert.deepEqual(visibleReasoningOptions(omitted, "high"), { thinking: { display: "summarized" } });
});

test("leaves Claude models without adaptive thinking alone", () => {
  assert.equal(visibleReasoningOptions({ ...claude, variants: [] }, "default"), null);
  const manual = { ...claude, variants: [{ id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } }] };
  assert.equal(visibleReasoningOptions(manual, "high"), null);
});

test("asks OpenAI reasoning models for a summary unless reasoning is off", () => {
  const gpt = {
    id: "gpt", providerID: "openai", package: "@opencode/ai/providers/openai",
    variants: [{ id: "none", settings: { reasoningEffort: "none" } }, { id: "medium", settings: { reasoningEffort: "medium" } }],
  };
  assert.deepEqual(visibleReasoningOptions(gpt, "default"), { reasoningSummary: "auto" });
  assert.deepEqual(visibleReasoningOptions(gpt, "medium"), { reasoningSummary: "auto" });
  assert.equal(visibleReasoningOptions(gpt, "none"), null);
  assert.equal(visibleReasoningOptions({ ...gpt, variants: [] }, "default"), null, "non-reasoning models are untouched");
  const compatible = { ...gpt, package: "@opencode/ai/providers/openai-compatible" };
  assert.equal(visibleReasoningOptions(compatible, "medium"), null, "chat-compatible APIs may reject a summary option");
});

test("asks Gemini thinking models to include thoughts", () => {
  const gemini = {
    id: "gemini", providerID: "google", package: "@opencode/ai/providers/google",
    variants: [{ id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } }],
  };
  assert.deepEqual(visibleReasoningOptions(gemini, "default"), { thinkingConfig: { includeThoughts: true } });
  assert.equal(visibleReasoningOptions(gemini, "high"), null);
});

function harness(models = [claude], sessions: Record<string, { parentID?: string }> = {}) {
  const hooks: { prompt?: (event: { sessionID: string; metadata?: Record<string, unknown> }) => unknown; context?: (event: {
    sessionID: string; model: { id: string; providerID: string; variant?: string }; options: Record<string, unknown>;
  }) => unknown } = {};
  let disposed = 0;
  const register = async (name: "prompt" | "context", callback: never) => {
    hooks[name] = callback;
    return { dispose: async () => { disposed += 1; } };
  };
  const context: VisibleReasoningContext = {
    session: {
      get: async ({ sessionID }) => sessions[sessionID] ?? {},
      hook: register,
    },
    model: { list: async () => ({ data: models }) },
  };
  const turn = async (sessionID: string, variant?: string) => {
    const event = { sessionID, model: { id: claude.id, providerID: claude.providerID, ...(variant ? { variant } : {}) }, options: { maxTokens: 32_000 } };
    await hooks.context?.(event);
    return event.options;
  };
  return { context, hooks, turn, disposed: () => disposed };
}

test("applies the latest prompt's choice to the agent request", async () => {
  const { context, hooks, turn, disposed } = harness();
  const dispose = await registerVisibleReasoning(context);

  assert.deepEqual(await turn("ses_a"), { maxTokens: 32_000 }, "unknown choice keeps the model defaults");

  await hooks.prompt?.({ sessionID: "ses_a", metadata: { openwork: { showReasoning: true } } });
  assert.deepEqual(await turn("ses_a"), { maxTokens: 32_000, thinking: { type: "adaptive", display: "summarized" } });

  await hooks.prompt?.({ sessionID: "ses_a", metadata: { openwork: { showReasoning: false } } });
  assert.deepEqual(await turn("ses_a"), { maxTokens: 32_000 }, "turning the setting off restores the defaults");

  await dispose();
  assert.equal(disposed(), 2);
});

test("background agents follow the conversation that started them", async () => {
  const { context, hooks, turn } = harness([claude], { ses_child: { parentID: "ses_parent" } });
  await registerVisibleReasoning(context);
  await hooks.prompt?.({ sessionID: "ses_parent", metadata: { openwork: { showReasoning: true } } });
  assert.deepEqual((await turn("ses_child")).thinking, { type: "adaptive", display: "summarized" });
});

test("a failing model lookup never fails the turn", async () => {
  const { context, hooks } = harness();
  const broken: VisibleReasoningContext = { ...context, model: { list: async () => { throw new Error("catalog unavailable"); } } };
  await registerVisibleReasoning(broken);
  await hooks.prompt?.({ sessionID: "ses_a", metadata: { openwork: { showReasoning: true } } });
  const event = { sessionID: "ses_a", model: { id: claude.id, providerID: claude.providerID }, options: {} };
  await hooks.context?.(event);
  assert.deepEqual(event.options, {});
});
