import { describe, expect, test } from "bun:test";

import {
  buildCloudManagedModelOptions,
  buildCloudManagedModelIdsByProvider,
  hasCloudManagedModelAllowlist,
  isCloudManagedModelAllowed,
} from "../src/app/cloud/managed-provider-models";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import type { ProviderListItem } from "../src/app/types";

function importedProvider(input: Pick<CloudImportedProvider, "cloudProviderId" | "providerId" | "sourceProviderId" | "name" | "modelIds">): CloudImportedProvider {
  return {
    ...input,
    source: "models_dev",
    updatedAt: null,
    importedAt: 1,
  };
}

function visibleModelIds(providerId: string, modelIds: string[], allowlist: Map<string, Set<string>>) {
  return modelIds.filter((modelId) => isCloudManagedModelAllowed(allowlist, providerId, modelId));
}

function provider(id: string, name: string, modelIds: string[]): ProviderListItem {
  return {
    id,
    name,
    source: "config",
    models: Object.fromEntries(modelIds.map((modelId) => [modelId, { id: modelId, name: modelId }])),
  };
}

function staleOpenAiModelIds(): string[] {
  const explicit = [
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.5-fast",
    "text-embedding-3-large",
    "gpt-4o",
    "gpt-image-1-mini",
    "gpt-5.4-fast",
    "o4-mini",
  ];
  const generated = Array.from({ length: 45 }, (_, index) => `stale-openai-catalog-${index + 1}`);
  return [...explicit, ...generated];
}

describe("managed cloud provider model allowlists", () => {
  test("session modal and compact select option builder filters 54 stale OpenAI models to selected IDs", () => {
    const allowlist = buildCloudManagedModelIdsByProvider({
      lpr_openai: importedProvider({
        cloudProviderId: "lpr_openai",
        providerId: "openai",
        sourceProviderId: "openai",
        name: "openAI_server",
        modelIds: ["gpt-5.4", "gpt-5.5"],
      }),
    });

    const rawOpenAiProviderListIds = staleOpenAiModelIds();

    expect(rawOpenAiProviderListIds).toHaveLength(54);
    expect(hasCloudManagedModelAllowlist(allowlist, "openai")).toBe(true);
    expect(visibleModelIds("openai", rawOpenAiProviderListIds, allowlist)).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(buildCloudManagedModelOptions({
      providers: [provider("openai", "openAI_server", rawOpenAiProviderListIds)],
      cloudManagedModelIdsByProvider: allowlist,
      isRecommendedProvider: (providerId) => providerId === "openai",
    }).map((option) => ({
      providerID: option.providerID,
      modelID: option.modelID,
      source: option.source,
      isRecommended: option.isRecommended,
    }))).toEqual([
      { providerID: "openai", modelID: "gpt-5.4", source: "cloud", isRecommended: true },
      { providerID: "openai", modelID: "gpt-5.5", source: "cloud", isRecommended: true },
    ]);
  });

  test("keeps API-key NVIDIA managed provider selected IDs intact", () => {
    const allowlist = buildCloudManagedModelIdsByProvider({
      lpr_nvidia: importedProvider({
        cloudProviderId: "lpr_nvidia",
        providerId: "lpr_nvidia",
        sourceProviderId: "nvidia",
        name: "nvidia",
        modelIds: ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"],
      }),
    });

    expect(visibleModelIds("lpr_nvidia", ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"], allowlist)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "google/gemma-4-31b-it",
    ]);
    expect(buildCloudManagedModelOptions({
      providers: [provider("lpr_nvidia", "nvidia", ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"])],
      cloudManagedModelIdsByProvider: allowlist,
    }).map((option) => option.modelID)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "google/gemma-4-31b-it",
    ]);
  });

  test("does not filter non-managed providers without imported model IDs", () => {
    const allowlist = buildCloudManagedModelIdsByProvider({});

    expect(visibleModelIds("anthropic", ["claude-sonnet", "claude-opus"], allowlist)).toEqual([
      "claude-sonnet",
      "claude-opus",
    ]);
  });

  test("merges duplicate imported provider model allowlists by provider ID", () => {
    const allowlist = buildCloudManagedModelIdsByProvider({
      llmProvider_openai_one: importedProvider({
        cloudProviderId: "llmProvider_openai_one",
        providerId: "openai",
        sourceProviderId: "openai",
        name: "OpenAI one",
        modelIds: ["gpt-5.4"],
      }),
      llmProvider_openai_two: importedProvider({
        cloudProviderId: "llmProvider_openai_two",
        providerId: "openai",
        sourceProviderId: "openai",
        name: "OpenAI two",
        modelIds: ["gpt-5.5"],
      }),
    });

    expect(visibleModelIds("openai", ["gpt-5.4", "gpt-5.5", "gpt-4o"], allowlist)).toEqual(["gpt-5.4", "gpt-5.5"]);
  });

  test("model picker options for OAuth-managed providers keep runtime provider IDs for defaults", () => {
    const allowlist = buildCloudManagedModelIdsByProvider({
      lpr_den_openai: importedProvider({
        cloudProviderId: "lpr_den_openai",
        providerId: "openai",
        sourceProviderId: "openai",
        name: "OpenAI from Den",
        modelIds: ["gpt-5.5"],
      }),
    });

    expect(buildCloudManagedModelOptions({
      providers: [provider("openai", "OpenAI", ["gpt-5.5"])],
      cloudManagedModelIdsByProvider: allowlist,
    }).map((option) => ({ providerID: option.providerID, modelID: option.modelID }))).toEqual([
      { providerID: "openai", modelID: "gpt-5.5" },
    ]);
  });
});
