import { expect, test } from "bun:test";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, FREE_MODEL_ENGINE_TITLE, fixedModelTitle, modelSubtitle, modelTitle } from "../src/react-app/domains/models/model-catalog";
import type { ModelOption } from "../src/app/types";

const free: ModelOption = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, title: "GPT-6 Luna", description: "OpenWork Free", isFree: true };
const other: ModelOption = { providerID: "anthropic", modelID: "claude-sonnet", title: "Claude Sonnet", description: "Anthropic" };


test("the free model is named and described like any other model", () => {
  expect(modelTitle(free)).toBe("GPT-6 Luna");
  expect(modelSubtitle(free)).toBe("OpenWork Free");
  expect(modelSubtitle(other)).toBe(modelSubtitle(other));
  // A bare reference (no engine title) still reads as the model's own name, never an id.
  expect(fixedModelTitle({ providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID })).toBe(FREE_MODEL_ENGINE_TITLE);
  expect(modelTitle({ providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, title: AUTO_MODEL_ID })).toBe(FREE_MODEL_ENGINE_TITLE);
});
