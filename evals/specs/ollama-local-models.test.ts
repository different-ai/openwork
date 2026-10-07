import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { OLLAMA_MODELS, ollamaLocalModels } from "../worlds/ollama-local-models.ts";

const test = spec.world(ollamaLocalModels, {
  resources: { surfaces: [], services: [] },
  needs: { commands: ["bun"] },
  timeout: 300_000,
});

const ADDED = ["gpt-oss:120b", "deepseek-v4-pro", "gemma4", "qwen2.5-coder:7b"];

test("a person adds several Ollama models and chooses how much each one thinks", { timeout: 300_000 }, async ({ world, step, evidence }) => {
  await step("given Ollama reports its own thinking levels for each pulled model", async () => {
    const reported = Object.fromEntries(ADDED.map((id) => [id, OLLAMA_MODELS[id]?.thinking?.values ?? []]));
    evidence.recordAssertionEvidence("Ollama /api/show thinking.values", JSON.stringify(reported), true);
  });

  await step("when the person adds four models, one after another, from Settings > Ollama", async () => {
    for (const id of ADDED) await world.addModel(id);
    expect(world.shown).toEqual(ADDED);
    evidence.recordAssertionEvidence("Each add reads the model from Ollama once", world.shown.join(", "), true);
  });

  await step("after: every added model is still in the model picker, not just the last one", async () => {
    const models = Object.keys(await world.pickerModels()).sort();
    evidence.recordAssertionEvidence("Ollama models in the picker", models.join(", "), models.length === ADDED.length);
    expect(models).toEqual([...ADDED].sort());
  });

  await step("after: each model offers exactly the thinking levels Ollama reported", async () => {
    const levels = await world.pickerModels();
    evidence.recordAssertionEvidence("Thinking levels per model", JSON.stringify(levels), true);
    expect(levels).toEqual({
      "gpt-oss:120b": ["high", "low", "medium"],
      "deepseek-v4-pro": ["high", "low", "max", "none"],
      "gemma4": ["high", "none"],
      "qwen2.5-coder:7b": [],
    });
  });

  await step("the chosen level reaches Ollama as reasoning_effort, and Default sends none", async () => {
    const sent = [
      { model: "deepseek-v4-pro", variant: "max" },
      { model: "gemma4", variant: "none" },
      { model: "gpt-oss:120b", variant: null },
    ];
    const observed = [];
    for (const { model, variant } of sent) observed.push({ model, chose: variant ?? "Default", reasoning_effort: (await world.send(model, variant)).effort });
    evidence.recordAssertionEvidence("Requests Ollama received", JSON.stringify(observed), true);
    expect(observed.map((row) => row.reasoning_effort)).toEqual(["max", "none", null]);
  });

  await step("adding a model again refreshes it and keeps the others", async () => {
    await world.addModel("gpt-oss:120b");
    const levels = await world.pickerModels();
    evidence.recordAssertionEvidence("Models after re-adding gpt-oss:120b", Object.keys(levels).sort().join(", "), Object.keys(levels).length === ADDED.length);
    expect(Object.keys(levels).sort()).toEqual([...ADDED].sort());
    expect(levels["gpt-oss:120b"]).toEqual(["high", "low", "medium"]);
  });
});
