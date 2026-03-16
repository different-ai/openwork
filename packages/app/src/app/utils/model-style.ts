import type { ModelRef, ProviderListItem } from "../types";

export type ModelStyleOption = {
  id: "auto" | "quick" | "balanced" | "deep" | "maximum";
  rawValue: string | null;
  label: string;
  description: string;
};

const VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "thinking", "xhigh", "max"] as const;

const STYLE_COPY: Record<ModelStyleOption["id"], Pick<ModelStyleOption, "label" | "description">> = {
  auto: {
    label: "Recommended",
    description: "Let this assistant use its usual balance.",
  },
  quick: {
    label: "Quick",
    description: "Faster replies for easier tasks.",
  },
  balanced: {
    label: "Balanced",
    description: "A good default for most questions.",
  },
  deep: {
    label: "Deep",
    description: "More time for harder questions.",
  },
  maximum: {
    label: "Maximum",
    description: "The most thorough mode this assistant supports.",
  },
};

const VARIANT_LABELS: Record<(typeof VARIANT_ORDER)[number], string> = {
  none: "Fastest",
  minimal: "Quick",
  low: "Light",
  medium: "Balanced",
  high: "Deep",
  thinking: "Thoughtful",
  xhigh: "Maximum",
  max: "Maximum",
};

const VARIANT_DESCRIPTIONS: Record<(typeof VARIANT_ORDER)[number], string> = {
  none: "Use the least extra thinking.",
  minimal: "Keep replies fast and lightweight.",
  low: "Add a little more thinking time.",
  medium: "Use a balanced amount of thinking.",
  high: "Spend more time working through harder tasks.",
  thinking: "Use the assistant's extended thinking mode.",
  xhigh: "Use the assistant's highest effort mode.",
  max: "Use the assistant's highest effort mode.",
};

const titleCase = (value: string) =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const variantToStyle = (value: string | null): ModelStyleOption["id"] => {
  if (!value) return "auto";
  if (value === "medium") return "balanced";
  if (value === "high" || value === "thinking") return "deep";
  if (value === "xhigh" || value === "max") return "maximum";
  return "quick";
};

const pickVariant = (available: string[], choices: string[]) =>
  choices.find((value) => available.includes(value)) ?? null;

export const normalizeModelVariant = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (["auto", "default", "recommended"].includes(trimmed)) return null;
  if (trimmed === "balance" || trimmed === "balanced") return "medium";
  return VARIANT_ORDER.includes(trimmed as (typeof VARIANT_ORDER)[number]) ? trimmed : null;
};

export const findProviderModelByRef = (modelRef: ModelRef, providers: ProviderListItem[]) => {
  const provider = providers.find((item) => item.id === modelRef.providerID);
  const model = provider?.models?.[modelRef.modelID];
  if (!provider || !model) return null;
  return { provider, model };
};

export const getAvailableModelVariants = (modelRef: ModelRef, providers: ProviderListItem[]) => {
  const match = findProviderModelByRef(modelRef, providers);
  const keys = Object.keys(match?.model?.variants ?? {})
    .map((value) => normalizeModelVariant(value))
    .filter((value): value is string => Boolean(value));

  return [...new Set(keys)].sort((a, b) => {
    const left = VARIANT_ORDER.indexOf(a as (typeof VARIANT_ORDER)[number]);
    const right = VARIANT_ORDER.indexOf(b as (typeof VARIANT_ORDER)[number]);
    return left - right;
  });
};

export const getModelStyleOptions = (modelRef: ModelRef, providers: ProviderListItem[]) => {
  const available = getAvailableModelVariants(modelRef, providers);
  if (!available.length) return [] as ModelStyleOption[];

  const options: ModelStyleOption[] = [
    {
      id: "auto",
      rawValue: null,
      ...STYLE_COPY.auto,
    },
  ];

  const variants: Array<ModelStyleOption | null> = [
    pickVariant(available, ["minimal", "low", "none"]),
    pickVariant(available, ["medium", "low", "minimal", "none"]),
    pickVariant(available, ["high", "thinking"]),
    pickVariant(available, ["xhigh", "max"]),
  ].map((rawValue, index) => {
    if (!rawValue) return null;
    const id = (["quick", "balanced", "deep", "maximum"] as const)[index];
    return {
      id,
      rawValue,
      ...STYLE_COPY[id],
    };
  });

  for (const option of variants) {
    if (!option) continue;
    const duplicate = options.some(
      (existing) => existing.id === option.id || existing.rawValue === option.rawValue,
    );
    if (!duplicate) {
      options.push(option);
    }
  }

  return options;
};

export const getModelStyleSummary = (
  modelRef: ModelRef,
  providers: ProviderListItem[],
  value: string | null | undefined,
) => {
  const options = getModelStyleOptions(modelRef, providers);
  if (!options.length) {
    return {
      id: "auto" as const,
      label: "Built in",
      description: "This assistant uses its own built-in answer style.",
      rawValue: null,
    };
  }

  const normalized = normalizeModelVariant(value);
  if (!normalized) {
    return {
      id: "auto" as const,
      ...STYLE_COPY.auto,
      rawValue: null,
    };
  }

  const exact = options.find((option) => option.rawValue === normalized);
  if (exact) return exact;

  const byStyle = options.find((option) => option.id === variantToStyle(normalized));
  if (byStyle) {
    return {
      ...byStyle,
      rawValue: normalized,
    };
  }

  return {
    id: variantToStyle(normalized),
    label: formatModelVariantLabel(normalized),
    description: VARIANT_DESCRIPTIONS[normalized as (typeof VARIANT_ORDER)[number]] ?? "Use this assistant-specific mode.",
    rawValue: normalized,
  };
};

export const coerceModelVariantForModel = (
  modelRef: ModelRef,
  providers: ProviderListItem[],
  value: string | null | undefined,
) => {
  const normalized = normalizeModelVariant(value);
  if (!normalized) return null;
  const available = getAvailableModelVariants(modelRef, providers);
  if (!available.length || available.includes(normalized)) return normalized;
  const options = getModelStyleOptions(modelRef, providers);
  return options.find((option) => option.id === variantToStyle(normalized))?.rawValue ?? null;
};

export const formatModelVariantLabel = (value: string | null | undefined) => {
  const normalized = normalizeModelVariant(value);
  if (!normalized) return "Recommended";
  return VARIANT_LABELS[normalized as (typeof VARIANT_ORDER)[number]] ?? titleCase(normalized);
};

export const formatModelVariantDescription = (value: string | null | undefined) => {
  const normalized = normalizeModelVariant(value);
  if (!normalized) return STYLE_COPY.auto.description;
  return VARIANT_DESCRIPTIONS[normalized as (typeof VARIANT_ORDER)[number]] ?? "Use this assistant-specific mode.";
};
