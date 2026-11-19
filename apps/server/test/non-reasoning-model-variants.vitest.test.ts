import { expect, test } from "vitest";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.ts";

function modelConfig(config: Record<string, unknown>) {
  return renderOpencodeV2Config({
    skills: [],
    providers: [{
      id: "reasoning-witness", name: "Reasoning witness", apiKey: "synthetic-key",
      package: "@opencode/ai/providers/openai-compatible",
      models: [{ id: "model", name: "Model", config }],
    }],
  });
}

test("a model declared non-reasoning suppresses inferred effort variants", () => {
  expect(modelConfig({ reasoning: false })).toMatchObject({
    providers: { "reasoning-witness": { models: { model: {
      capabilities: { output: ["text"] }, variants: [],
    } } } },
  });
});

test("explicit provider variants are preserved even on a non-reasoning model", () => {
  expect(modelConfig({ reasoning: false, variants: { brief: { maxTokens: 100 }, hidden: { disabled: true } } })).toMatchObject({
    providers: { "reasoning-witness": { models: { model: {
      variants: [{ id: "brief", settings: { maxTokens: 100 } }],
    } } } },
  });
});

test("an unspecified capability keeps the engine's ordinary variant inference", () => {
  const rendered = JSON.stringify(modelConfig({}));
  expect(rendered).not.toContain('"variants"');
});
