import { describe, expect, test } from "bun:test";

import {
  buildCloudManagedModelOptions,
  buildCloudManagedModelIdsByProvider,
  hasCloudManagedModelAllowlist,
  isCloudManagedModelAllowed,
} from "../src/app/cloud/managed-provider-models";
import { createClient } from "../src/app/lib/opencode";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import type { ProviderListItem } from "../src/app/types";
import {
  fetchProviderList,
  getConnectedProviderItems,
  isModelAvailableInConnectedProviders,
  normalizeProviderListResponse,
} from "../src/react-app/infra/provider-list-query";

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
    "gpt-5.4-mini",
    "gpt-5.4-fast",
    "o4-mini",
  ];
  const generated = Array.from({ length: 45 }, (_, index) => `stale-openai-catalog-${index + 1}`);
  return [...explicit, ...generated];
}

describe("managed cloud provider model allowlists", () => {
  test("session modal and compact select option builder filters stale OpenAI models to selected IDs", () => {
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

    expect(rawOpenAiProviderListIds).toHaveLength(55);
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

  test("prefers worker-filtered providers over stale all catalog when both are present", () => {
    const filteredOpenAi = provider("openai", "openAI", ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
    const response = {
      all: [provider("openai", "openAI", staleOpenAiModelIds())],
      providers: [filteredOpenAi],
      connected: ["openai"],
      default: {},
    };

    expect(
      buildCloudManagedModelOptions({
        providers: getConnectedProviderItems(normalizeProviderListResponse(response)),
        cloudManagedModelIdsByProvider: new Map(),
      }).map((option) => option.modelID),
    ).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
  });

  test("fetches configured providers instead of the full available catalog", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (url.pathname === "/config/providers") {
          return Response.json({
            providers: [provider("openai", "openAI_2", ["gpt-5.4", "gpt-5.5"])],
            connected: ["openai"],
            default: {},
          });
        }
        if (url.pathname === "/provider") {
          return Response.json({
            all: [provider("openai", "openAI_2", staleOpenAiModelIds())],
            connected: ["openai", "opencode"],
            default: {},
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const response = await fetchProviderList({ client: createClient(server.url.toString()) });

      expect(requests).toEqual(["/config/providers"]);
      expect(getConnectedProviderItems(response).flatMap((item) => Object.keys(item.models))).toEqual(["gpt-5.4", "gpt-5.5"]);
    } finally {
      server.stop(true);
    }
  });

  test("does not mark configured providers connected when the worker omits connected ids", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/workspace/ws_test/opencode/config/providers") {
          return Response.json({
            providers: [provider("openai", "OpenAI", ["gpt-5.5"])],
            default: {},
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const response = await fetchProviderList({
        client: createClient(server.url.toString()),
        baseUrl: `${server.url}/workspace/ws_test/opencode`,
        openworkToken: "worker-client-token",
      });

      expect(getConnectedProviderItems(response)).toEqual([]);
      expect(isModelAvailableInConnectedProviders(response, { providerID: "openai", modelID: "gpt-5.5" })).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("does not fallback to the full available catalog when configured providers are unavailable", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (url.pathname === "/provider") {
          return Response.json({
            all: [provider("openai", "openAI_2", staleOpenAiModelIds())],
            connected: ["openai", "opencode"],
            default: {},
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      await expect(fetchProviderList({ client: createClient(server.url.toString()) })).rejects.toThrow();
      expect(requests).toEqual(["/config/providers"]);
    } finally {
      server.stop(true);
    }
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
