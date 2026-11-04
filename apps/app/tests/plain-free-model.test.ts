import { expect, test } from "bun:test";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, FREE_MODEL_ENGINE_TITLE, FREE_MODEL_NAME, fixedModelTitle, modelSubtitle, modelTitle } from "../src/react-app/domains/models/model-catalog";
import type { ModelOption } from "../src/app/types";

const free: ModelOption = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, title: "GPT-6 Luna", description: "OpenWork Free", isFree: true };
const other: ModelOption = { providerID: "anthropic", modelID: "claude-sonnet", title: "Claude Sonnet", description: "Anthropic" };

test("without plainFreeModel the free model keeps its fixed name and limit subtitle", () => {
  expect(modelTitle(free)).toBe(FREE_MODEL_NAME);
  expect(modelSubtitle(free)).toBe("Free with a usage limit");
  expect(modelSubtitle(free, true)).toBe("Limit used up");
});

test("with plainFreeModel the free model is named and described like any other model", () => {
  const display = { plainFreeModel: true };
  expect(modelTitle(free, display)).toBe("GPT-6 Luna");
  expect(modelSubtitle(free, true, display)).toBe("OpenWork Free");
  expect(modelSubtitle(other, false, display)).toBe(modelSubtitle(other));
  // A bare reference (no engine title) still reads as the model's own name, never an id.
  expect(fixedModelTitle({ providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID }, display)).toBe(FREE_MODEL_ENGINE_TITLE);
  expect(modelTitle({ providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, title: AUTO_MODEL_ID }, display)).toBe(FREE_MODEL_ENGINE_TITLE);
});
