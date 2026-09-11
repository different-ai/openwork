import type { ProviderListItem } from "../types";
import type { ModelBehaviorOption } from "../types";
import { t } from "../../i18n";

type ProviderModel = ProviderListItem["models"][string];

const WELL_KNOWN_VARIANT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function defaultBehaviorOption(): ModelBehaviorOption {
  return {
    value: null,
    label: t("settings.default_label"),
    description: t("settings.provider_default_desc"),
  };
}

export const normalizeModelBehaviorValue = (value: string | null) => {
  // Variant IDs are opaque catalog keys. Changing case or treating a named
  // variant as an alias can make a supported selection fail native resolution.
  return value?.trim() ? value : null;
};

const getVariantKeys = (model: ProviderModel | undefined) => Object.keys(model?.variants ?? {});

const sortVariantKeys = (keys: string[]) =>
  keys.slice().sort((a, b) => {
    const aIndex = WELL_KNOWN_VARIANT_ORDER.indexOf(a as (typeof WELL_KNOWN_VARIANT_ORDER)[number]);
    const bIndex = WELL_KNOWN_VARIANT_ORDER.indexOf(b as (typeof WELL_KNOWN_VARIANT_ORDER)[number]);
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    return a.localeCompare(b);
  });

const providerFamily = (providerID: string, providerName?: string | null) => {
  const normalizedId = providerID.trim().toLowerCase();
  if (["anthropic", "openai", "google", "opencode"].includes(normalizedId)) {
    return normalizedId;
  }

  const normalizedName = providerName?.trim().toLowerCase() ?? "";
  if (normalizedName.includes("anthropic")) return "anthropic";
  if (normalizedName.includes("openai")) return "openai";
  if (normalizedName.includes("google")) return "google";
  if (normalizedName.includes("opencode")) return "opencode";
  return normalizedId;
};

const getBehaviorTitle = (
  providerID: string,
  model: ProviderModel | undefined,
  variantKeys: string[],
  providerName?: string | null,
) => {
  const family = providerFamily(providerID, providerName);
  if (variantKeys.length > 0) {
    if (family === "anthropic") return t("model_behavior.title_extended_thinking");
    if (family === "google") return t("model_behavior.title_reasoning_budget");
    if (
      family === "openai" ||
      family === "opencode" ||
      variantKeys.some((key) => ["none", "minimal", "low", "medium", "high", "xhigh"].includes(key))
    ) {
      return t("model_behavior.title_reasoning_effort");
    }
    return t("app.model_behavior_title");
  }
  if (model?.capabilities?.reasoning) return t("model_behavior.title_builtin_reasoning");
  return t("model_behavior.title_standard_generation");
};

const getVariantLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

export const formatGenericBehaviorLabel = (value: string | null) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return defaultBehaviorOption().label;
  return getVariantLabel(normalized);
};

/** Cycle supplied choices, including the provider's Default (null). */
export const nextModelBehaviorValue = (
  options: readonly Pick<ModelBehaviorOption, "value">[],
  current: string | null,
) => {
  const values = options.map((option) => option.value);
  if (values.length < 2) return null;
  const currentIndex = values.indexOf(current);
  return values[(currentIndex + 1) % values.length] ?? null;
};

/** Cycle supplied choices backward, including Default. */
export const previousModelBehaviorValue = (
  options: readonly Pick<ModelBehaviorOption, "value">[],
  current: string | null,
) => {
  const values = options.map((option) => option.value);
  if (values.length < 2) return null;
  const currentIndex = values.indexOf(current);
  if (currentIndex === -1) return values[values.length - 1] ?? null;
  return values[(currentIndex - 1 + values.length) % values.length] ?? null;
};

const getVariantDescription = (
  providerID: string,
  key: string,
  label: string,
  providerName?: string | null,
) => {
  const family = providerFamily(providerID, providerName);
  if (key === "none") return t("model_behavior.desc_none");
  if (key === "minimal") return t("model_behavior.desc_minimal");
  if (key === "low") return family === "google"
    ? t("model_behavior.desc_low_google")
    : t("model_behavior.desc_low");
  if (key === "medium") return t("model_behavior.desc_medium");
  if (key === "high") return family === "anthropic"
    ? t("model_behavior.desc_high_anthropic")
    : t("model_behavior.desc_high");
  if (key === "xhigh" || key === "max") return family === "anthropic"
    ? t("model_behavior.desc_max_anthropic")
    : t("model_behavior.desc_max");
  return t("model_behavior.desc_generic", { label: label.toLowerCase() });
};

export const getModelBehaviorOptions = (
  providerID: string,
  model: ProviderModel | undefined,
  providerName?: string | null,
): ModelBehaviorOption[] => {
  const variantKeys = sortVariantKeys(getVariantKeys(model));
  return [defaultBehaviorOption(), ...variantKeys.map((key) => {
    const label = getVariantLabel(key);
    return {
      value: key,
      label,
      description: getVariantDescription(providerID, key, label, providerName),
    };
  })];
};

/** For an explicit model switch only; never sanitize a saved same-model choice. */
export const sanitizeModelBehaviorValue = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  return getModelBehaviorOptions(providerID, model, providerName).some((option) => option.value === value)
    ? value
    : null;
};

/** Describe a saved choice without changing it or treating missing metadata as rejection. */
export const getModelBehaviorSelection = (
  suppliedOptions: readonly { value: string | null; label: string; description?: string }[],
  value: string | null,
) => {
  const options = [defaultBehaviorOption(), ...suppliedOptions.filter((option) => option.value !== null)
    .map((option) => ({ ...option, description: option.description ?? "" }))];
  const selected = options.find((option) => option.value === value);
  return {
    value,
    label: selected?.label ?? `${JSON.stringify(value)} (not in current catalog)`,
    description: selected?.description ?? "This saved setting is not listed in the current model configuration. It is kept unchanged; choose Default or a listed setting to replace it.",
    options,
  };
};

export const getModelBehaviorSummary = (
  providerID: string,
  model: ProviderModel | undefined,
  value: string | null,
  providerName?: string | null,
) => {
  const options = getModelBehaviorOptions(providerID, model, providerName);
  const title = getBehaviorTitle(providerID, model, getVariantKeys(model), providerName);
  return { title, ...getModelBehaviorSelection(options, value) };
};
