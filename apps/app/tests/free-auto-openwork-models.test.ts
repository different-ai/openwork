import { expect, test } from "bun:test";
import { buildModelCatalog, resolveRetainedSelection } from "../src/react-app/domains/models/catalog";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, openWorkModelsAutoReplacement, preferredAutoModel, shouldSelectInitialAuto } from "../src/react-app/domains/models/model-catalog";
import type { ModelOption } from "../src/app/types";

const auto: ModelOption = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, title: "Auto", isFree: true };
const openWorkModel: ModelOption = { providerID: "openwork", modelID: "anthropic/claude-sonnet", title: "Claude Sonnet" };
const other: ModelOption = { providerID: "anthropic", modelID: "claude-sonnet", title: "Claude Sonnet" };

function catalog(runtime: ModelOption[]) {
  return buildModelCatalog({ runtime, signedIn: true, restrictToCloud: false, checkRestriction: () => false,
    autoStatus: { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, code: null } });
}

test("free Auto is not listed when the organization has OpenWork Models", () => {
  expect(catalog([auto, other]).options.map((option) => option.providerID)).toContain(AUTO_PROVIDER_ID);
  const covered = catalog([auto, openWorkModel, other]);
  expect(covered.options.map((option) => option.providerID)).toEqual(["openwork", "anthropic"]);
  expect(covered.known.map((option) => option.providerID)).toContain(AUTO_PROVIDER_ID);
});

test("a conversation already on free Auto keeps working when it is hidden behind OpenWork Models", () => {
  expect(resolveRetainedSelection({ current: auto, catalog: catalog([auto, openWorkModel]), signedIn: true,
    restrictToCloud: false, checkRestriction: () => false, catalogState: "ready", sessionScoped: true })).toBeUndefined();
});

test("new members with OpenWork Models do not start on free Auto", () => {
  const input = { current: null, empty: true, explicit: false };
  expect(shouldSelectInitialAuto({ ...input, available: [auto, other] })).toBe(true);
  expect(shouldSelectInitialAuto({ ...input, available: [auto, openWorkModel] })).toBe(false);
});

const openWorkAuto: ModelOption = { providerID: "openwork", modelID: AUTO_MODEL_ID, title: "Auto" };

test("members start on Auto from their OpenWork Models once it is listed", () => {
  const input = { current: null, empty: true, explicit: false };
  expect(shouldSelectInitialAuto({ ...input, available: [auto, openWorkModel, openWorkAuto] })).toBe(true);
  expect(preferredAutoModel([auto, openWorkModel, openWorkAuto])).toBe(openWorkAuto);
  expect(preferredAutoModel([auto, other])).toBe(auto);
});

test("a saved free Auto choice moves to OpenWork Models Auto", () => {
  expect(openWorkModelsAutoReplacement(auto, [auto, openWorkModel, openWorkAuto])).toBe(openWorkAuto);
  expect(openWorkModelsAutoReplacement(auto, [auto, openWorkModel])).toBeUndefined();
  expect(openWorkModelsAutoReplacement(other, [auto, openWorkAuto])).toBeUndefined();
});
