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

/**
 * Resolve which concrete variant the provider would use when no override
 * is sent. OpenCode's variants dict doesn't mark one entry as "default",
 * so this encodes the provider-side convention:
 *   - OpenAI reasoning models default to `medium`
 *   - Google reasoning budget defaults to `medium`
 *   - Anthropic extended thinking defaults to `none` (off)
 *   - Everyone else: prefer `medium` > `low` > first variant in the
 *     well-known order
 * Returns null when we can't confidently pick a default (e.g. no
 * variants exposed).
 */
const resolveProviderDefaultVariant = (providerID: string, variantKeys: string[]) => {
  if (!variantKeys.length) return null;
  const has = (key: string) => variantKeys.includes(key);
  if (providerID === "anthropic") return has("none") ? "none" : variantKeys[0] ?? null;
  if (providerID === "openai" || providerID === "opencode" || providerID === "google") {
    if (has("medium")) return "medium";
    if (has("low")) return "low";
    return variantKeys[0] ?? null;
  }
  if (has("medium")) return "medium";
  if (has("low")) return "low";
  if (has("minimal")) return "minimal";
  return variantKeys[0] ?? null;
};

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

// Group a provider id into a "family" so we can apply each vendor's own
// marketing terminology for thinking/reasoning modes. The OpenCode public
// provider is bucketed as OpenAI-family because its default catalog is
// GPT-5 and it advertises reasoning_effort semantics; override if/when
// OpenCode exposes non-OpenAI defaults.
type ProviderFamily = "openai" | "anthropic" | "google" | "xai" | "generic";

function resolveProviderFamily(providerID: string): ProviderFamily {
  const id = providerID.trim().toLowerCase();
  if (!id) return "generic";
  if (id === "openai" || id === "openai-compatible" || id === "azure" || id === "opencode") {
    return "openai";
  }
  if (id === "anthropic") return "anthropic";
  if (id === "google" || id === "google-genai" || id === "gemini") return "google";
  if (id === "xai" || id === "grok") return "xai";
  return "generic";
}

const getBehaviorTitle = (providerID: string, model: ProviderModel, variantKeys: string[]) => {
  const family = resolveProviderFamily(providerID);
  if (variantKeys.length > 0) {
    // Use each vendor's public terminology. These are product/marketing
    // names (e.g. Anthropic's "Extended thinking", OpenAI's "reasoning
    // effort"), so we intentionally don't translate them.
    if (family === "anthropic") return "Extended thinking";
    if (family === "google") return "Thinking budget";
    if (family === "xai") return "Think mode";
    if (family === "openai") return "Reasoning effort";
    return t("app.model_behavior_title");
  }
  if (model.reasoning) return t("model_behavior.title_builtin_reasoning");
  return t("model_behavior.title_standard_generation");
};

const getVariantLabel = (providerID: string, key: string) => {
  const family = resolveProviderFamily(providerID);

  if (family === "openai") {
    // ChatGPT UI nomenclature for GPT-5.x / o-series reasoning effort.
    if (key === "none" || key === "minimal") return "Instant";
    if (key === "low") return "Light thinking";
    if (key === "medium") return "Thinking";
    if (key === "high") return "Thinking longer";
    if (key === "xhigh" || key === "max") return "Maximum thinking";
  }

  if (family === "anthropic") {
    // Anthropic calls the feature "Extended thinking". Budgets in the API
    // don't have canonical display names, so we tier them verbally.
    if (key === "none") return "No extended thinking";
    if (key === "low") return "Brief extended thinking";
    if (key === "medium") return "Extended thinking";
    if (key === "high") return "Deep extended thinking";
    if (key === "xhigh" || key === "max") return "Maximum extended thinking";
  }

  if (family === "google") {
    // Gemini exposes a "thinking budget". Google UI uses "thinking", not
    // "reasoning", so mirror that.
    if (key === "none") return "Instant";
    if (key === "low") return "Brief thinking";
    if (key === "medium") return "Thinking";
    if (key === "high") return "Deep thinking";
    if (key === "xhigh" || key === "max") return "Maximum thinking";
  }

  if (family === "xai") {
    // Grok's public UI uses "Think" as the mode name.
    if (key === "none") return "Fast";
    if (key === "low") return "Think";
    if (key === "medium") return "Think";
    if (key === "high") return "Think harder";
    if (key === "xhigh" || key === "max") return "Think hardest";
  }

  // Generic fallback for providers we don't have a canonical mapping for.
  if (key === "none") return t("model_behavior.label_fast");
  if (key === "minimal") return t("model_behavior.label_quick");
  if (key === "low") return t("model_behavior.label_light");
  if (key === "medium") return t("model_behavior.label_balanced");
  if (key === "high") return t("model_behavior.label_deep");
  if (key === "xhigh" || key === "max") return t("model_behavior.label_maximum");
  return humanize(key);
};

export const formatGenericBehaviorLabel = (value: string | null) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return defaultBehaviorOption().label;
  return getVariantLabel("generic", normalized);
};

const getVariantDescription = (providerID: string, key: string, label: string) => {
  const family = resolveProviderFamily(providerID);

  // Vendor-aligned blurbs — short enough to fit as menu subtext.
  if (family === "openai") {
    if (key === "none" || key === "minimal") return "Answer without extra reasoning.";
    if (key === "low") return "A little extra thinking for fast follow-ups.";
    if (key === "medium") return "Default reasoning; good all-round balance.";
    if (key === "high") return "Reason for longer; higher quality on hard tasks.";
    if (key === "xhigh" || key === "max") return "Spend the most time reasoning.";
  }
  if (family === "anthropic") {
    if (key === "none") return "Normal Claude response; skip extended thinking.";
    if (key === "low") return "A short Extended thinking budget.";
    if (key === "medium") return "Default Extended thinking budget.";
    if (key === "high") return "Extra-long Extended thinking budget.";
    if (key === "xhigh" || key === "max") return "Maximum Extended thinking budget.";
  }
  if (family === "google") {
    if (key === "none") return "Answer immediately, no thinking budget.";
    if (key === "low") return "A small thinking budget for quick clarifications.";
    if (key === "medium") return "Default thinking budget.";
    if (key === "high") return "Large thinking budget; better on complex tasks.";
    if (key === "xhigh" || key === "max") return "Maximum thinking budget.";
  }
  if (family === "xai") {
    if (key === "none") return "Answer right away.";
    if (key === "low" || key === "medium") return "Use Grok's Think mode.";
    if (key === "high") return "Think harder before answering.";
    if (key === "xhigh" || key === "max") return "Think the hardest before answering.";
  }

  // Generic fallback.
  if (key === "none") return t("model_behavior.desc_none");
  if (key === "minimal") return t("model_behavior.desc_minimal");
  if (key === "low") return t("model_behavior.desc_low");
  if (key === "medium") return t("model_behavior.desc_medium");
  if (key === "high") return t("model_behavior.desc_high");
  if (key === "xhigh" || key === "max") return t("model_behavior.desc_max");
  return t("model_behavior.desc_generic", undefined, { label: label.toLowerCase() });
};

export const getModelBehaviorOptions = (
  providerID: string,
  model: ProviderModel,
): ModelBehaviorOption[] => {
  const variantKeys = sortVariantKeys(getVariantKeys(model));
  if (!variantKeys.length) return [];
  // Only concrete variants — no "Provider default" catch-all. The composer
  // resolves the null preference into the actual default variant at display
  // time via `getModelBehaviorSummary` below.
  return variantKeys.map((key) => {
    const label = getVariantLabel(providerID, key);
    return {
      value: key,
      label,
      description: getVariantDescription(providerID, key, label),
    };
  });
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
  const variantKeys = sortVariantKeys(getVariantKeys(model));
  const sanitized = sanitizeModelBehaviorValue(providerID, model, value);
  // When no explicit variant is picked, show the provider's actual default
  // (e.g. OpenAI → medium → "Balanced"), not a generic "Provider default"
  // row. That makes the composer pill honest about what will actually run.
  const resolvedKey = sanitized ?? resolveProviderDefaultVariant(providerID, variantKeys);
  const selected = options.find((option) => option.value === resolvedKey) ?? options[0] ?? null;
  const title = getBehaviorTitle(providerID, model, variantKeys);

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
