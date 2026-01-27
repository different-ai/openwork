import type { Provider as ConfigProvider, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

type ProviderListItem = ProviderListResponse["all"][number];
type ProviderListModel = ProviderListItem["models"][string];

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
