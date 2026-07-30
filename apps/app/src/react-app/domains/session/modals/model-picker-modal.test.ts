declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { resolveModelPickerEmptyState } from "./model-picker-modal";

describe("resolveModelPickerEmptyState", () => {
  test("shows organization recovery and hides provider connect under managed model restriction", () => {
    const state = resolveModelPickerEmptyState({
      providerGroupCount: 0,
      query: "",
      organizationModelsEmpty: true,
      restrictToCloud: true,
      organizationModelsSettingsUrl: "https://app.openworklabs.com/dashboard/custom-llm-providers",
    });

    expect(state?.messageKey).toBe("models.organization_models_empty");
    expect(state?.showConnectProvider).toBe(false);
    expect(state?.showRefreshOrganizationModels).toBe(true);
    expect(state?.showOrganizationModelsSettings).toBe(true);
  });
});
