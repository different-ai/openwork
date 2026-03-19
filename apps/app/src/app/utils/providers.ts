import type { Provider as ConfigProvider, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

type ProviderListItem = ProviderListResponse["all"][number];
type ProviderListModel = ProviderListItem["models"][string];

const PINNED_PROVIDER_ORDER = ["opencode", "openai", "anthropic"] as const;

export const providerPriorityRank = (id: string) => {
  const normalized = id.trim().toLowerCase();
  const index = PINNED_PROVIDER_ORDER.indexOf(
    normalized as (typeof PINNED_PROVIDER_ORDER)[number],
  );
  return index === -1 ? PINNED_PROVIDER_ORDER.length : index;
};

export const compareProviders = (
  a: { id: string; name?: string },
  b: { id: string; name?: string },
) => {
  const rankDiff = providerPriorityRank(a.id) - providerPriorityRank(b.id);
  if (rankDiff !== 0) return rankDiff;

  const aName = (a.name ?? a.id).trim();
  const bName = (b.name ?? b.id).trim();
  return aName.localeCompare(bName);
};

const buildModalities = (caps?: ConfigProvider["models"][string]["capabilities"]) => {
  if (!caps) return undefined;

  const input = Object.entries(caps.input)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key as "text" | "audio" | "image" | "video" | "pdf");
  const output = Object.entries(caps.output)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key as "text" | "audio" | "image" | "video" | "pdf");

  if (!input.length && !output.length) return undefined;
  return { input, output };
};

const mapModel = (model: ConfigProvider["models"][string]): ProviderListModel => {
  const interleaved = model.capabilities?.interleaved;
  const modalities = buildModalities(model.capabilities);
  const status = model.status === "alpha" || model.status === "beta" || model.status === "deprecated"
    ? model.status
    : undefined;

  return {
    id: model.id,
    name: model.name ?? model.id,
    family: model.family,
    release_date: model.release_date ?? "",
    attachment: model.capabilities?.attachment ?? false,
    reasoning: model.capabilities?.reasoning ?? false,
    temperature: model.capabilities?.temperature ?? false,
    tool_call: model.capabilities?.toolcall ?? false,
    interleaved: interleaved === false ? undefined : interleaved,
    cost: model.cost
      ? {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cache.read,
          cache_write: model.cost.cache.write,
          context_over_200k: model.cost.experimentalOver200K
            ? {
                input: model.cost.experimentalOver200K.input,
                output: model.cost.experimentalOver200K.output,
                cache_read: model.cost.experimentalOver200K.cache.read,
                cache_write: model.cost.experimentalOver200K.cache.write,
              }
            : undefined,
        }
      : undefined,
    limit: model.limit,
    modalities,
    experimental: status === "alpha" ? true : undefined,
    status,
    options: model.options ?? {},
    headers: model.headers ?? undefined,
    provider: model.api?.npm ? { npm: model.api.npm } : undefined,
    variants: model.variants,
  };
};

export const mapConfigProvidersToList = (providers: ConfigProvider[]): ProviderListResponse["all"] =>
  providers.map((provider) => {
    const models = Object.fromEntries(
      Object.entries(provider.models ?? {}).map(([key, model]) => [key, mapModel(model)]),
    );

    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      env: provider.env ?? [],
      models,
    };
  });
