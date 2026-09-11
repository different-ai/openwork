import { z } from "zod";

export const CLOUD_MODEL_CONFIG_VERSION = 2;
export const CATALOG_FAST_VARIANT = "__openwork_catalog_fast_v1";
export const FAST_VARIANT_PREFIX = "__openwork_fast_v1/";
export const FAST_DEFAULT_VARIANT = `${FAST_VARIANT_PREFIX}default`;

const fastMode = z.object({
  provider: z.object({ body: z.object({ service_tier: z.literal("priority") }).strict() }).strict(),
  cost: z.record(z.string(), z.unknown()).optional(),
}).strict();
const reasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const effortOption = z.object({ type: z.literal("effort"), values: z.array(reasoningEffort) }).strict();
const fastMetadata = z.object({
  disabled: z.literal(true), openworkNativeFast: z.literal(1), reasoningEfforts: z.array(reasoningEffort).optional(),
}).strict();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function fastVariantId(effort: string | null): string {
  return effort === null ? FAST_DEFAULT_VARIANT : `${FAST_VARIANT_PREFIX}variant/${encodeURIComponent(effort)}`;
}

/** Keep stored/imported metadata disabled. Only verified engine materializers
 * expand it; older servers cannot accidentally advertise a broken Fast option. */
export function catalogFastVariants(config: Record<string, unknown>, providerNpm: unknown): Record<string, unknown> | undefined {
  const variants = isRecord(config.variants) ? config.variants : {};
  const experimental = isRecord(config.experimental) ? config.experimental : {};
  const modes = isRecord(experimental.modes) ? experimental.modes : {};
  const modelProvider = isRecord(config.provider) ? config.provider : {};
  if (providerNpm !== "@ai-sdk/openai"
    || (modelProvider.npm !== undefined && modelProvider.npm !== providerNpm)
    || !fastMode.safeParse(modes.fast).success
    || Object.keys(variants).some((id) => id === CATALOG_FAST_VARIANT || id.startsWith(FAST_VARIANT_PREFIX))) return undefined;
  const reasoningEfforts = [...new Set((Array.isArray(config.reasoning_options) ? config.reasoning_options : []).flatMap((option) => {
    const parsed = effortOption.safeParse(option);
    return parsed.success ? parsed.data.values : [];
  }))];
  return { ...variants, [CATALOG_FAST_VARIANT]: {
    disabled: true, openworkNativeFast: 1,
    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
  } };
}

export function nativeModelVariants(raw: unknown, providerPackage: string | undefined) {
  const variants = isRecord(raw) ? raw : {};
  const enabled = Object.entries(variants).flatMap(([id, value]) => {
    if (!isRecord(value) || value.disabled === true) return [];
    const { disabled, ...options } = value;
    return [{ id, settings: { providerOptions: options } }];
  });
  const metadata = fastMetadata.safeParse(variants[CATALOG_FAST_VARIANT]);
  if (providerPackage !== "@opencode-ai/ai/providers/openai"
    || !metadata.success
    || Object.keys(variants).some((id) => id.startsWith(FAST_VARIANT_PREFIX))) return enabled;
  // Catalog efforts are not OpenCode variants. Expand only here, and never
  // resurrect an explicitly disabled variant or overwrite custom settings.
  for (const effort of metadata.data.reasoningEfforts ?? []) {
    if (!Object.hasOwn(variants, effort)) enabled.push({ id: effort, settings: { providerOptions: { reasoningEffort: effort } } });
  }
  return [
    ...enabled,
    { id: FAST_DEFAULT_VARIANT, settings: { providerOptions: { serviceTier: "priority" } } },
    ...enabled.map((variant) => ({
      id: fastVariantId(variant.id),
      settings: { providerOptions: { ...variant.settings.providerOptions, serviceTier: "priority" } },
    })),
  ];
}

/** Emit v1 provider config for the pinned managed engine (1.18.30 or newer).
 * Do not use this for arbitrary external engines or mutate the stored config. */
export function materializeLegacyFastProviders(providers: Record<string, Record<string, unknown>>) {
  const result = { ...providers };
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.npm !== "@ai-sdk/openai" || !isRecord(provider.models)) continue;
    const models = { ...provider.models };
    for (const [modelId, model] of Object.entries(models)) {
      if (!isRecord(model) || !isRecord(model.variants)
        || !fastMetadata.safeParse(model.variants[CATALOG_FAST_VARIANT]).success
        || (isRecord(model.provider) && model.provider.npm !== undefined && model.provider.npm !== provider.npm)
        || Object.keys(model.variants).some((key) => key.startsWith(FAST_VARIANT_PREFIX))) continue;
      const { [CATALOG_FAST_VARIANT]: _metadata, ...variants } = model.variants;
      for (const variant of nativeModelVariants(model.variants, "@opencode-ai/ai/providers/openai")) {
        if (!Object.hasOwn(variants, variant.id)) variants[variant.id] = variant.settings.providerOptions;
      }
      models[modelId] = { ...model, variants };
    }
    result[id] = { ...provider, models };
  }
  return result;
}
