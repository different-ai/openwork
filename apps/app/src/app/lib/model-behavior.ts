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
    label: t("settings.provider_default_label"),
    description: t("settings.provider_default_desc"),
  };
}

const humanize = (value: string) => {
  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return value;
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/\d/.test(word) || word.length <= 3) return word.toUpperCase();
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
};

export const normalizeModelBehaviorValue = (value: string | null) => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "balance" ||
    normalized === "balanced" ||
    normalized === "default" ||
    normalized === "provider-default"
  ) {
    return null;
  }
  return normalized;
};

const getVariantKeys = (model: ProviderModel) => {
  const keys = Object.keys(model.variants ?? {})
    .map((key) => normalizeModelBehaviorValue(key))
    .filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
};

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
  model: ProviderModel,
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
  if (model.capabilities?.reasoning) return t("model_behavior.title_builtin_reasoning");
  return t("model_behavior.title_standard_generation");
};

const getVariantLabel = (providerID: string, key: string, providerName?: string | null) => {
  const family = providerFamily(providerID, providerName);
  if (key === "none") return t("model_behavior.label_fast");
  if (key === "minimal") return t("model_behavior.label_quick");
  if (key === "low") return t("model_behavior.label_light");
  if (key === "medium") return t("model_behavior.label_balanced");
  if (key === "high") return family === "anthropic" ? t("model_behavior.label_extended") : t("model_behavior.label_deep");
  if (key === "xhigh" || key === "max") return t("model_behavior.label_maximum");
  return humanize(key);
};

export const formatGenericBehaviorLabel = (value: string | null) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return defaultBehaviorOption().label;
  return getVariantLabel("generic", normalized);
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
  return t("model_behavior.desc_generic", undefined, { label: label.toLowerCase() });
};

export const getModelBehaviorOptions = (
  providerID: string,
  model: ProviderModel,
  providerName?: string | null,
): ModelBehaviorOption[] => {
  const variantKeys = sortVariantKeys(getVariantKeys(model));
  if (!variantKeys.length) return [];
  return [
    defaultBehaviorOption(),
    ...variantKeys.map((key) => {
      const label = getVariantLabel(providerID, key, providerName);
      return {
        value: key,
        label,
        description: getVariantDescription(providerID, key, label, providerName),
      };
    }),
  ];
};

export const sanitizeModelBehaviorValue = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return null;
  return getModelBehaviorOptions(providerID, model, providerName).some((option) => option.value === normalized)
    ? normalized
    : null;
};

export const getModelBehaviorSummary = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  const options = getModelBehaviorOptions(providerID, model, providerName);
  const sanitized = sanitizeModelBehaviorValue(providerID, model, value, providerName);
  const selected = options.find((option) => option.value === sanitized) ?? options[0] ?? null;
  const title = getBehaviorTitle(providerID, model, getVariantKeys(model), providerName);

  if (options.length > 0) {
    return {
      title,
      label: selected?.label ?? defaultBehaviorOption().label,
      description: selected?.description ?? defaultBehaviorOption().description,
      options,
    };
  }

  if (model.capabilities?.reasoning) {
    return {
      title,
      label: t("model_behavior.label_builtin"),
      description: t("model_behavior.desc_builtin"),
      options,
    };
  }

  return {
    title,
    label: t("model_behavior.label_standard"),
    description: t("model_behavior.desc_standard"),
    options,
  };
};
