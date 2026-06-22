import { describe, expect, test } from "bun:test";
import { OpenWorkCapabilitiesKnowledge } from "./openwork-capabilities-knowledge.js";
import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";
import { mergeSystemPromptsInPlace, OpenWorkSystemPromptNormalizer } from "./openwork-system-prompt-normalizer.js";

describe("OpenWork system prompt normalizer", () => {
  test("merges multiple system prompts in place", () => {
    const system = [" base prompt ", "", " plugin prompt "];
    const original = system;

    mergeSystemPromptsInPlace(system);

    expect(system).toBe(original);
    expect(system).toEqual(["base prompt\n\nplugin prompt"]);
  });

  test("runs after OpenWork plugin transforms to produce one provider-safe system prompt", async () => {
    const capabilities = await OpenWorkCapabilitiesKnowledge();
    const extensions = await OpenWorkExtensionsPreview();
    const normalizer = await OpenWorkSystemPromptNormalizer();
    const output = {
      system: ["You are OpenWork.", ""],
    };

    await capabilities["experimental.chat.system.transform"]({}, output);
    await extensions["experimental.chat.system.transform"]({}, output);
    expect(output.system.length).toBeGreaterThan(1);

    await normalizer["experimental.chat.system.transform"]({}, output);

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain("You are OpenWork.");
    expect(output.system[0]).toContain("You are running inside OpenWork");
    expect(output.system[0]).toContain("check OpenWork extensions");
    expect(output.system[0]).toContain("openwork_ui_execute_action");
  });
});
