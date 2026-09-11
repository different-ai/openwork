import { describe, expect, test } from "vitest";

import type { DesktopAppRestrictionChecker } from "../src/app/cloud/desktop-app-restrictions";
import { resolveOrgDefaultModelReplacement } from "../src/react-app/domains/connections/provider-auth/provider-policy";

const allowEverything: DesktopAppRestrictionChecker = () => true;
const managedModelsPolicy: DesktopAppRestrictionChecker = (input) =>
  input.restriction === "allowZenModel";

// The organization's assigned cloud model, already known from Den.
const assignedOptions = [{ providerID: "lpr_acme", modelID: "big-pickle" }];
// A workspace provider the person just configured in opencode.json.
const configuredDefault = { providerID: "skill-lifecycle", modelID: "skill-lifecycle-model" };

describe("resolveOrgDefaultModelReplacement", () => {
  test("does not replace a configured non-cloud default while the workspace catalog is still loading", () => {
    // Right after an engine reload the engine catalog has not answered yet,
    // while the organization-assigned models have. That window used to read
    // as "the configured provider is missing" and swapped in the org model.
    expect(resolveOrgDefaultModelReplacement({
      runtimeOptions: [],
      runtimeCatalogPending: true,
      assignedOptions,
      currentDefault: configuredDefault,
      restrictToCloud: false,
      checkRestriction: allowEverything,
    })).toBe(null);
  });

  test("keeps the configured default once the loaded workspace catalog contains it", () => {
    expect(resolveOrgDefaultModelReplacement({
      runtimeOptions: [configuredDefault, ...assignedOptions],
      runtimeCatalogPending: false,
      assignedOptions,
      currentDefault: configuredDefault,
      restrictToCloud: false,
      checkRestriction: allowEverything,
    })).toBe(null);
  });

  test("falls back to organization-assigned models when no workspace engine catalog exists", () => {
    // Before workspace creation there is no engine to ask; assigned models
    // stand in so the composer is not left without a selection.
    expect(resolveOrgDefaultModelReplacement({
      runtimeOptions: [],
      runtimeCatalogPending: false,
      assignedOptions,
      currentDefault: configuredDefault,
      restrictToCloud: false,
      checkRestriction: allowEverything,
    })).toEqual({ providerID: "lpr_acme", modelID: "big-pickle" });
  });

  test("replaces a policy-blocked default from the loaded workspace catalog", () => {
    expect(resolveOrgDefaultModelReplacement({
      runtimeOptions: [
        { providerID: "opencode", modelID: "big-pickle" },
        { providerID: "lpr_acme", modelID: "gpt-5.4" },
      ],
      runtimeCatalogPending: false,
      assignedOptions: [],
      currentDefault: { providerID: "opencode", modelID: "big-pickle" },
      restrictToCloud: true,
      checkRestriction: managedModelsPolicy,
    })).toEqual({ providerID: "lpr_acme", modelID: "gpt-5.4" });
  });
});
