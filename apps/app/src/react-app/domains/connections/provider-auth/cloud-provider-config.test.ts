declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => { toBe: (expected: unknown) => void };

import type {
  DenOrgLlmProvider,
  DenOrgLlmProviderModel,
} from "../../../../app/lib/den";
import type { CloudImportedProvider } from "../../../../app/cloud/import-state";
import {
  getCloudManagedProviderId,
  getProviderModelIds,
  isCloudProviderOutOfSync,
} from "./cloud-provider-config";

const UPDATED_AT = "2024-02-01T00:00:00.000Z";

const makeModel = (id: string): DenOrgLlmProviderModel => ({
  id,
  name: id,
  config: {},
  createdAt: null,
});

const makeProvider = (
  models: DenOrgLlmProviderModel[],
  updatedAt = UPDATED_AT,
): DenOrgLlmProvider => ({
  id: "lpr_openrouter",
  source: "custom",
  providerId: "openrouter",
  name: "OpenRouter",
  providerConfig: {},
  hasApiKey: true,
  models,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt,
});

const importedFrom = (provider: DenOrgLlmProvider): CloudImportedProvider => ({
  cloudProviderId: provider.id,
  providerId: getCloudManagedProviderId(provider),
  sourceProviderId: provider.providerId,
  name: provider.name,
  source: provider.source,
  updatedAt: provider.updatedAt,
  modelIds: getProviderModelIds(provider),
  importedAt: 1,
});

describe("isCloudProviderOutOfSync", () => {
  test("returns false for an in-sync provider", () => {
    const provider = makeProvider([makeModel("model-a"), makeModel("model-b")]);
    expect(isCloudProviderOutOfSync(provider, importedFrom(provider))).toBe(false);
  });

  test("ignores whitespace and empty live model ids", () => {
    const baselineProvider = makeProvider([makeModel("model-a")]);
    const liveProvider = makeProvider([
      makeModel("model-a "),
      makeModel("   "),
    ]);

    expect(isCloudProviderOutOfSync(liveProvider, importedFrom(baselineProvider))).toBe(false);
  });

  test("returns true for a changed model list", () => {
    const baselineProvider = makeProvider([makeModel("model-a")]);
    const liveProvider = makeProvider([makeModel("model-a"), makeModel("model-b")]);

    expect(isCloudProviderOutOfSync(liveProvider, importedFrom(baselineProvider))).toBe(true);
  });

  test("returns true for a changed updatedAt", () => {
    const baselineProvider = makeProvider([makeModel("model-a")]);
    const liveProvider = makeProvider(
      [makeModel("model-a")],
      "2024-03-01T00:00:00.000Z",
    );

    expect(isCloudProviderOutOfSync(liveProvider, importedFrom(baselineProvider))).toBe(true);
  });
});
