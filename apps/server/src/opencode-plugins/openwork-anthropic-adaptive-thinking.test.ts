import { describe, expect, test } from "bun:test";
import { OpenWorkAnthropicAdaptiveThinking } from "./openwork-anthropic-adaptive-thinking.js";

async function runHook(apiId: string, options: Record<string, unknown>) {
  const hooks = await OpenWorkAnthropicAdaptiveThinking();
  const output: { options: Record<string, unknown> } = { options };
  await hooks["chat.params"]({ model: { id: apiId, api: { id: apiId } } }, output);
  return output.options;
}

describe("OpenWorkAnthropicAdaptiveThinking chat.params", () => {
  test("rewrites legacy enabled thinking to adaptive for Claude 5-family ids", async () => {
    expect(await runHook("claude-fable-5", { thinking: { type: "enabled", budgetTokens: 16000 } })).toEqual({
      thinking: { type: "adaptive" },
      effort: "high",
    });
    expect(await runHook("claude-fable-5-20260601", { thinking: { type: "enabled", budgetTokens: 31999 } })).toEqual({
      thinking: { type: "adaptive" },
      effort: "max",
    });
    expect(await runHook("claude-opus-5", { thinking: { type: "enabled", budgetTokens: 16000 } })).toEqual({
      thinking: { type: "adaptive" },
      effort: "high",
    });
  });

  test("keeps an existing effort", async () => {
    expect(
      await runHook("claude-fable-5", { thinking: { type: "enabled", budgetTokens: 16000 }, effort: "low" }),
    ).toEqual({ thinking: { type: "adaptive" }, effort: "low" });
  });

  test("leaves adaptive payloads untouched", async () => {
    expect(await runHook("claude-fable-5", { thinking: { type: "adaptive" }, effort: "high" })).toEqual({
      thinking: { type: "adaptive" },
      effort: "high",
    });
  });

  test("leaves 4.x and older models untouched", async () => {
    const legacy = { thinking: { type: "enabled", budgetTokens: 16000 } };
    expect(await runHook("claude-sonnet-4-5", structuredClone(legacy))).toEqual(legacy);
    expect(await runHook("claude-opus-4-1-20250805", structuredClone(legacy))).toEqual(legacy);
    expect(await runHook("claude-3-5-sonnet-20241022", structuredClone(legacy))).toEqual(legacy);
  });

  test("no-ops when options carry no thinking config", async () => {
    expect(await runHook("claude-fable-5", { temperature: 0.2 })).toEqual({ temperature: 0.2 });
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./openwork-anthropic-adaptive-thinking.js");
    expect(Object.keys(mod)).toEqual(["OpenWorkAnthropicAdaptiveThinking"]);
  });
});
