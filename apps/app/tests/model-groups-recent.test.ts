import { expect, test } from "bun:test";

import type { ModelOption } from "../src/app/types";
import { modelGroups } from "../src/react-app/domains/models/model-catalog";

function option(providerID: string, modelID: string, description: string): ModelOption {
  return { providerID, modelID, title: modelID, description, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false };
}

const options = [option("anthropic", "opus", "Anthropic"), option("anthropic", "sonnet", "Anthropic"), option("openai", "gpt", "OpenAI")];
const names = (groups: ReturnType<typeof modelGroups>) => Object.fromEntries(groups.map((group) => [group.value, group.items.map((item) => item.modelID)]));

test("a recent model still shows under its provider", () => {
  expect(names(modelGroups(options, [], [{ providerID: "anthropic", modelID: "opus" }]))).toEqual({
    Recent: ["opus"],
    Anthropic: ["opus", "sonnet"],
    OpenAI: ["gpt"],
  });
});

test("a pinned model is listed once, in Pinned, and not repeated in Recent", () => {
  const pinned = { providerID: "anthropic", modelID: "opus" };
  expect(names(modelGroups(options, [pinned], [pinned]))).toEqual({
    Pinned: ["opus"],
    Anthropic: ["sonnet"],
    OpenAI: ["gpt"],
  });
});
