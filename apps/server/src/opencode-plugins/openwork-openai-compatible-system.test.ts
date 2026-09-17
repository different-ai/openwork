import { describe, expect, test } from "bun:test";

import { OpenWorkOpenAICompatibleSystem } from "./openwork-openai-compatible-system.js";

function model(npm: string): unknown {
  return { model: { api: { npm } } };
}

describe("OpenAI-compatible system message normalization", () => {
  async function transform(input: unknown, output: { system: string[] }): Promise<void> {
    const plugin = await OpenWorkOpenAICompatibleSystem();
    await plugin["experimental.chat.system.transform"](input, output);
  }

  test("normalizes @ai-sdk/openai-compatible", async () => {
    const output = { system: ["engine", "plugin"] };
    await transform(model("@ai-sdk/openai-compatible"), output);
    expect(output.system).toEqual(["engine\n\nplugin"]);
  });

  test("keeps all system contributions in order in one entry", async () => {
    const output = { system: ["engine and project instructions", "runtime plugin one", "runtime plugin two"] };
    await transform(model("@ai-sdk/openai-compatible"), output);
    expect(output.system).toEqual([
      "engine and project instructions\n\nruntime plugin one\n\nruntime plugin two",
    ]);
  });

  test.each(["@ai-sdk/openai", "@ai-sdk/anthropic", "unknown"])(
    "does not rewrite %s system boundaries",
    async (npm) => {
      const output = { system: ["engine", "plugin"] };
      await transform(model(npm), output);
      expect(output.system).toEqual(["engine", "plugin"]);
    },
  );

  test("does not add or rewrite a single system entry", async () => {
    const output = { system: ["engine"] };
    await transform(model("@ai-sdk/openai-compatible"), output);
    expect(output.system).toEqual(["engine"]);
  });
});
