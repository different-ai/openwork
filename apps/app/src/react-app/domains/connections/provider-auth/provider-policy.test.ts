declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import { resolveEntitledOrgDefaultModel } from "./provider-policy";

const managedModelsPolicy: DesktopAppRestrictionChecker = (input) =>
  input.restriction === "allowZenModel";

const options = [
  { providerID: "openai", modelID: "gpt-5.5" },
  { providerID: "opencode", modelID: "big-pickle" },
  { providerID: "lpr_acme", modelID: "gpt-5.4" },
  { providerID: "lpr_acme", modelID: "gpt-5.5" },
];

describe("resolveEntitledOrgDefaultModel", () => {
  test("selects the first entitled organization model when the current default is blocked", () => {
    expect(resolveEntitledOrgDefaultModel(options, {
      currentDefault: { providerID: "opencode", modelID: "big-pickle" },
      restrictToCloud: true,
      checkRestriction: managedModelsPolicy,
    })).toEqual({ providerID: "lpr_acme", modelID: "gpt-5.4" });
  });

  test("keeps an existing entitled organization default", () => {
    expect(resolveEntitledOrgDefaultModel(options, {
      currentDefault: { providerID: "lpr_acme", modelID: "gpt-5.5" },
      restrictToCloud: true,
      checkRestriction: managedModelsPolicy,
    })).toBe(null);
  });

  test("returns null when no organization model is entitled", () => {
    expect(resolveEntitledOrgDefaultModel([
      { providerID: "openai", modelID: "gpt-5.5" },
    ], {
      currentDefault: null,
      restrictToCloud: true,
      checkRestriction: managedModelsPolicy,
    })).toBe(null);
  });
});
