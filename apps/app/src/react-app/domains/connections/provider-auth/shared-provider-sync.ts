import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import type { DenOrgUsableGatewayProvider } from "@/app/lib/den";

export type SharedDeviceProviderArrival =
  | { status: "arrived"; organizationProviderId: string; name: string }
  | { status: "pending" };

/** Join live inventory propagation without treating the legacy provider list as Gateway evidence. */
export async function confirmSharedGatewayProvider(input: {
  providerId: string;
  inferenceProviderId: string;
  isCurrent: () => boolean;
  isListed: () => boolean;
  readGatewayProviders: () => Promise<DenOrgUsableGatewayProvider[]>;
  readEngineProviders: () => Promise<ProviderListResponse | null>;
  wait: () => Promise<void>;
  attempts?: number;
}): Promise<SharedDeviceProviderArrival> {
  const attempts = input.attempts ?? 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!input.isCurrent()) return { status: "pending" };
    const providers = await input.readGatewayProviders();
    if (!input.isCurrent()) return { status: "pending" };
    const shared = providers.find((provider) => provider.id === input.inferenceProviderId && provider.providerId === input.providerId);
    const catalog = await input.readEngineProviders();
    if (!input.isCurrent()) return { status: "pending" };
    const engineProvider = catalog?.all.find((provider) => provider.id === input.inferenceProviderId);
    if (shared?.credentialStatus === "ready" && shared.models.length > 0
      && input.isListed() && catalog?.connected.includes(shared.id)
      && shared.models.some((model) => Boolean(engineProvider?.models[model.id]))) {
      return { status: "arrived", organizationProviderId: shared.id, name: shared.name };
    }
    if (attempt + 1 < attempts) await input.wait();
  }
  return { status: "pending" };
}
