import type { ProviderListItem } from "../types";
import type { ModelBehaviorOption } from "../types";
import { t, td } from "../../i18n";

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
    label: td("settings.provider_default_label", "Provider default"),
    description: td("settings.provider_default_desc", "Use the model's built-in default reasoning behavior."),
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

const getBehaviorTitle = (providerID: string, model: ProviderModel, variantKeys: string[]) => {
  if (variantKeys.length > 0) {
    if (providerID === "anthropic") return td("model_behavior.title_extended_thinking", "Extended thinking");
    if (providerID === "google") return td("model_behavior.title_reasoning_budget", "Reasoning budget");
    if (
      providerID === "openai" ||
      providerID === "opencode" ||
      variantKeys.some((key) => ["none", "minimal", "low", "medium", "high", "xhigh"].includes(key))
    ) {
      return td("model_behavior.title_reasoning_effort", "Reasoning effort");
    }
    return td("app.model_behavior_title", "Model behavior");
  }
  if (model.reasoning) return td("model_behavior.title_builtin_reasoning", "Built-in reasoning");
  return td("model_behavior.title_standard_generation", "Standard generation");
};

const getVariantLabel = (providerID: string, key: string) => {
  if (key === "none") return td("model_behavior.label_fast", "Fast");
  if (key === "minimal") return td("model_behavior.label_quick", "Quick");
  if (key === "low") return td("model_behavior.label_light", "Light");
  if (key === "medium") return td("model_behavior.label_balanced", "Balanced");
  if (key === "high") return providerID === "anthropic" ? td("model_behavior.label_extended", "Extended") : td("model_behavior.label_deep", "Deep");
  if (key === "xhigh" || key === "max") return td("model_behavior.label_maximum", "Maximum");
  return humanize(key);
};

export const formatGenericBehaviorLabel = (value: string | null) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return defaultBehaviorOption().label;
  return getVariantLabel("generic", normalized);
};

const getVariantDescription = (providerID: string, key: string, label: string) => {
  if (key === "none") return td("model_behavior.desc_none", "Favor speed with the lightest reasoning path.");
  if (key === "minimal") return td("model_behavior.desc_minimal", "Use a very small amount of reasoning.");
  if (key === "low") return providerID === "google"
    ? td("model_behavior.desc_low_google", "Use a lighter reasoning budget for quicker responses.")
    : td("model_behavior.desc_low", "Use a lighter reasoning pass before answering.");
  if (key === "medium") return td("model_behavior.desc_medium", "Balance speed and reasoning depth.");
  if (key === "high") return providerID === "anthropic"
    ? td("model_behavior.desc_high_anthropic", "Use the standard extended-thinking budget.")
    : td("model_behavior.desc_high", "Spend more time reasoning before answering.");
  if (key === "xhigh" || key === "max") return providerID === "anthropic"
    ? td("model_behavior.desc_max_anthropic", "Use the largest extended-thinking budget available.")
    : td("model_behavior.desc_max", "Use the provider's deepest reasoning profile.");
  return td("model_behavior.desc_generic", "Use the {label} profile.", { label: label.toLowerCase() });
};

export const getModelBehaviorOptions = (
  providerID: string,
  model: ProviderModel,
): ModelBehaviorOption[] => {
  const variantKeys = sortVariantKeys(getVariantKeys(model));
  if (!variantKeys.length) return [];
  return [
    defaultBehaviorOption(),
    ...variantKeys.map((key) => {
      const label = getVariantLabel(providerID, key);
      return {
        value: key,
        label,
        description: getVariantDescription(providerID, key, label),
      };
    }),
  ];
};

export const sanitizeModelBehaviorValue = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return null;
  return getModelBehaviorOptions(providerID, model).some((option) => option.value === normalized)
    ? normalized
    : null;
};

export const getModelBehaviorSummary = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
) => {
  const options = getModelBehaviorOptions(providerID, model);
  const sanitized = sanitizeModelBehaviorValue(providerID, model, value);
  const selected = options.find((option) => option.value === sanitized) ?? options[0] ?? null;
  const title = getBehaviorTitle(providerID, model, getVariantKeys(model));

  if (options.length > 0) {
    return {
      title,
      label: selected?.label ?? defaultBehaviorOption().label,
      description: selected?.description ?? defaultBehaviorOption().description,
      options,
    };
  }

  if (model.reasoning) {
    return {
      title,
      label: td("model_behavior.label_builtin", "Built in"),
      description: td("model_behavior.desc_builtin", "This model decides its own reasoning path and does not expose profiles here."),
      options,
    };
  }

  return {
    title,
    label: td("model_behavior.label_standard", "Standard"),
    description: td("model_behavior.desc_standard", "This model does not expose extra reasoning controls."),
    options,
  };
};
