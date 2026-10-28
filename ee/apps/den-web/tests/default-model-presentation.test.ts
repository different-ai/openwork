import { expect, test } from "bun:test";
import { savedDefaultModelState } from "../app/(den)/dashboard/_components/default-model-presentation";

const choice = { providerId: "ipr_saved", modelId: "catalog-model" };
const option = { ...choice, modelName: "Saved model name", providerName: "Provider name", source: "gateway" as const, logoProviderId: "openai" };

test("failed, missing and partial inventories cannot establish removal or discard the saved name", () => {
  for (const input of [
    { options: undefined, failed: false },
    { options: { options: [], unavailableSources: [] }, failed: true },
    { options: { options: [], unavailableSources: ["gateway" as const] }, failed: false },
  ]) {
    expect(savedDefaultModelState({ ...input, choice, lastKnown: option })).toEqual({
      option, availability: "unknown", label: "Saved model name",
    });
  }
});

test("only a complete successful inventory identifies a missing saved choice", () => {
  expect(savedDefaultModelState({ choice, options: { options: [], unavailableSources: [] }, failed: false, lastKnown: option }))
    .toEqual({ option, availability: "not-listed", label: "Saved model name" });
  expect(savedDefaultModelState({ choice, options: { options: [option], unavailableSources: [] }, failed: false }))
    .toEqual({ option, availability: "listed", label: "Saved model name" });
});

test("unrelated saved metadata never names a different choice, and opaque IDs are not display names", () => {
  expect(savedDefaultModelState({ choice: { ...choice, providerId: "ipr_other" }, options: undefined, failed: true, lastKnown: option }))
    .toEqual({ option: null, availability: "unknown", label: "Saved model" });
});
