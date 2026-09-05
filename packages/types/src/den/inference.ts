import capabilitySnapshot from "./inference-capabilities.json" with { type: "json" };

export const INFERENCE_USAGE_CONVERSION_FACTOR = 100_000_000;

export const INFERENCE_WINDOW_TYPES = [
  "five_hour",
  "weekly",
  "monthly",
] as const;
export type InferenceWindowType = (typeof INFERENCE_WINDOW_TYPES)[number];

export const INFERENCE_TIERS = ["tier1", "tier2"] as const;
export type InferenceTier = (typeof INFERENCE_TIERS)[number];

export const INFERENCE_TIER_LIMITS: Record<
  InferenceTier,
  Record<InferenceWindowType, number>
> = {
  tier1: {
    five_hour: 100_000_000,
    weekly: 500_000_000,
    monthly: 1_000_000_000,
  },
  tier2: {
    five_hour: 150_000_000,
    weekly: 750_000_000,
    monthly: 1_500_000_000,
  },
} as const;

export const INFERENCE_RESET_STRATEGIES = [
  "anchored",
  "activity_based",
] as const;
export type InferenceResetStrategy =
  (typeof INFERENCE_RESET_STRATEGIES)[number];

export const INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE: Record<
  InferenceWindowType,
  InferenceResetStrategy
> = {
  five_hour: "activity_based",
  weekly: "anchored",
  monthly: "anchored",
} as const;

export const INFERENCE_WINDOW_DURATIONS_MS: Record<
  InferenceWindowType,
  number
> = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
} as const;

// Upstream identifiers and capabilities are verified against OpenRouter's model API.

export const INFERENCE_MODEL_ALIASES = {
  "z-ai/glm-5.2": {
    upstreamModel: "z-ai/glm-5.2",
    displayName: "OpenWork: GLM-5.2",
    enabled: true,
    usageFactor: 1,
  },
  "moonshotai/kimi-k2.7-code": {
    upstreamModel: "moonshotai/kimi-k2.7-code",
    displayName: "OpenWork: Kimi K2.7 Code",
    enabled: true,
    usageFactor: 1,
  },
  "tencent/hy3-preview": {
    upstreamModel: "tencent/hy3-preview",
    displayName: "OpenWork: Hy3 preview",
    enabled: true,
    usageFactor: 1,
  },
  "moonshotai/kimi-k2.6": {
    upstreamModel: "moonshotai/kimi-k2.6",
    displayName: "OpenWork: Kimi K2.6",
    enabled: true,
    usageFactor: 1,
  },
  "deepseek/deepseek-v4-flash": {
    upstreamModel: "deepseek/deepseek-v4-flash",
    displayName: "OpenWork: DeepSeek V4 Flash",
    enabled: true,
    usageFactor: 1,
  },
  "minimax/minimax-m2.7": {
    upstreamModel: "minimax/minimax-m2.7",
    displayName: "OpenWork: MiniMax M2.7",
    enabled: true,
    usageFactor: 1,
  },
  "minimax/minimax-m3": {
    upstreamModel: "minimax/minimax-m3",
    displayName: "OpenWork: MiniMax-M3",
    enabled: true,
    usageFactor: 1,
  },
  "z-ai/glm-5.1": {
    upstreamModel: "z-ai/glm-5.1",
    displayName: "OpenWork: GLM-5.1",
    enabled: true,
    usageFactor: 1,
  },
  "moonshotai/kimi-k3": {
    upstreamModel: "moonshotai/kimi-k3",
    displayName: "OpenWork: Kimi K3",
    enabled: true,
    usageFactor: 1,
  },
} as const;

export type InferenceModelAlias = keyof typeof INFERENCE_MODEL_ALIASES;

/** Policy (aliases/allowances) and provider facts are deliberately separate. */
export const INFERENCE_CATALOG_VERIFIED_AT = capabilitySnapshot.verifiedAt;
export const INFERENCE_CATALOG_SOURCE = capabilitySnapshot.source;

export type InferenceModelCapabilities = {
  contextTokens: number;
  outputTokens: number;
  inputModalities: ("text" | "image")[];
  outputModalities: "text"[];
  supportedParameters: string[];
  interleaved: boolean | { field: string };
  reasoning: {
    mandatory: boolean;
    defaultEnabled: boolean | null;
    supportedEfforts: string[] | null;
    defaultEffort: string | null;
    supportsTokenBudget: boolean;
  };
};

export function inferenceModelCapabilities(alias: string): InferenceModelCapabilities | null {
  const value = Object.entries(capabilitySnapshot.models).find(([id]) => id === alias)?.[1];
  if (!value) return null;
  return {
    ...value,
    inputModalities: value.inputModalities.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image"),
    outputModalities: value.outputModalities.filter((modality): modality is "text" => modality === "text"),
  };
}

/** Saved selections must fail explicitly instead of becoming engine defaults. */
export function inferenceModelSelectionIssue(modelId: string, variant?: string | null): string | null {
  const policy = Object.entries(INFERENCE_MODEL_ALIASES).find(([id]) => id === modelId)?.[1];
  const capabilities = inferenceModelCapabilities(modelId);
  if (!policy?.enabled || !capabilities) return "The selected OpenWork model is unavailable. Choose another model explicitly to continue.";
  if (!variant) return null;
  const efforts = capabilities.reasoning.supportedEfforts;
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(variant) || (efforts !== null && !efforts.includes(variant)) || (variant === "none" && capabilities.reasoning.mandatory)) return "The saved reasoning setting is unavailable for this model. Choose Default or a supported reasoning setting to continue.";
  return null;
}

/** Public OpenCode configuration and the managed API consume the same facts. */
export function openWorkModelConfigurations() {
  return Object.fromEntries(Object.entries(INFERENCE_MODEL_ALIASES).flatMap(([alias, model]) => {
    const capabilities = inferenceModelCapabilities(alias);
    if (!model.enabled || !capabilities) return [];
    return [[alias, {
      id: alias,
      name: model.displayName.replace(/^OpenWork:\s*/, ""),
      attachment: capabilities.inputModalities.includes("image"),
      reasoning: capabilities.supportedParameters.includes("reasoning"),
      tool_call: capabilities.supportedParameters.includes("tools"),
      temperature: capabilities.supportedParameters.includes("temperature"),
      structured_output: capabilities.supportedParameters.includes("structured_outputs"),
      interleaved: capabilities.interleaved,
      variants: Object.fromEntries(["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((effort) => [effort,
        (capabilities.reasoning.supportedEfforts === null || capabilities.reasoning.supportedEfforts.includes(effort)) && !(effort === "none" && capabilities.reasoning.mandatory)
          ? { reasoning: { effort } }
          : { disabled: true },
      ])),
      modalities: { input: capabilities.inputModalities, output: capabilities.outputModalities },
      limit: { context: capabilities.contextTokens, output: capabilities.outputTokens },
    }]];
  }));
}

export type InferenceOrganizationMetadata = {
  enabled: true;
  tier: InferenceTier;
};
