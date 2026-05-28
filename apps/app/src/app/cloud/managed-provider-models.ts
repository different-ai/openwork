import type { CloudImportedProvider } from "./import-state";
import type { ModelOption, ProviderListItem } from "../types";

export function buildCloudManagedModelIdsByProvider(
  importedCloudProviders: Record<string, CloudImportedProvider> | null | undefined,
): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  for (const imported of Object.values(importedCloudProviders ?? {})) {
    const providerId = imported.providerId.trim();
    if (!providerId) continue;
    const modelIds = imported.modelIds.map((id) => id.trim()).filter(Boolean);
    if (!modelIds.length) continue;
    const merged = next.get(providerId) ?? new Set<string>();
    for (const modelId of modelIds) merged.add(modelId);
    next.set(providerId, merged);
  }
  return next;
}

export function isCloudManagedModelAllowed(
  cloudManagedModelIdsByProvider: Map<string, Set<string>>,
  providerId: string,
  modelId: string,
) {
  const allowedModelIds = cloudManagedModelIdsByProvider.get(providerId);
  return !allowedModelIds || allowedModelIds.has(modelId);
}

export function hasCloudManagedModelAllowlist(
  cloudManagedModelIdsByProvider: Map<string, Set<string>>,
  providerId: string,
) {
  return cloudManagedModelIdsByProvider.has(providerId);
}

export function buildCloudManagedModelOptions(input: {
  providers: ProviderListItem[];
  cloudManagedModelIdsByProvider: Map<string, Set<string>>;
  isRecommendedProvider?: (providerId: string) => boolean;
}): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of input.providers) {
    const isCloudManaged = hasCloudManagedModelAllowlist(input.cloudManagedModelIdsByProvider, provider.id);
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isCloudManagedModelAllowed(input.cloudManagedModelIdsByProvider, provider.id, modelId)) continue;
      options.push({
        providerID: provider.id,
        modelID: modelId,
        title: model.name || modelId,
        description: provider.name,
        behaviorTitle: "Reasoning",
        behaviorLabel: "Default",
        behaviorDescription: "",
        behaviorValue: null,
        isFree: false,
        isConnected: true,
        isRecommended: input.isRecommendedProvider?.(provider.id),
        source: isCloudManaged || /^lpr_/i.test(provider.id) ? "cloud" : undefined,
      });
    }
  }
  return options;
}
