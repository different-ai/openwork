import { z } from "zod";

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

// For upstreamModel values, please get from models.dev/api.json provider = openrouter.models.id

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

export type InferenceOrganizationMetadata = {
  enabled: true;
  tier: InferenceTier;
};

// --- Inference gateway (per-org provider destinations) ---

export const INFERENCE_PROVIDER_CREDENTIAL_MODES = ["org", "member"] as const;
export type InferenceProviderCredentialMode =
  (typeof INFERENCE_PROVIDER_CREDENTIAL_MODES)[number];

export const INFERENCE_PROVIDER_STATUSES = ["active", "disabled"] as const;
export type InferenceProviderStatus = (typeof INFERENCE_PROVIDER_STATUSES)[number];

export const INFERENCE_PROVIDER_CREDENTIAL_KINDS = [
  "api_key",
  "api_key_map",
  "aws_keys",
  "gcp_service_account",
  "oauth_google",
  "oauth_azure",
] as const;
export type InferenceProviderCredentialKind =
  (typeof INFERENCE_PROVIDER_CREDENTIAL_KINDS)[number];

export const INFERENCE_PROVIDER_CREDENTIAL_STATUSES = [
  "active",
  "revoked",
  "refresh_failed",
] as const;
export type InferenceProviderCredentialStatus =
  (typeof INFERENCE_PROVIDER_CREDENTIAL_STATUSES)[number];

export const INFERENCE_REQUEST_ROUTES = ["openwork_openrouter", "org_provider"] as const;
export type InferenceRequestRoute = (typeof INFERENCE_REQUEST_ROUTES)[number];

export const INFERENCE_REQUEST_PROTOCOLS = [
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
  "google_generate_content",
  "bedrock_converse",
  "passthrough",
] as const;
export type InferenceRequestProtocol = (typeof INFERENCE_REQUEST_PROTOCOLS)[number];

export const INFERENCE_REQUEST_OUTCOMES = [
  "ok",
  "upstream_error",
  "upstream_unreachable",
  "client_aborted",
  "rejected",
] as const;
export type InferenceRequestOutcome = (typeof INFERENCE_REQUEST_OUTCOMES)[number];

export const INFERENCE_USAGE_SOURCES = ["stream", "json", "missing"] as const;
export type InferenceUsageSource = (typeof INFERENCE_USAGE_SOURCES)[number];

export const INFERENCE_ROLLUP_GRANULARITIES = ["hour", "day"] as const;
export type InferenceRollupGranularity = (typeof INFERENCE_ROLLUP_GRANULARITIES)[number];

// Decrypted `secret` payloads for the structured credential kinds. `api_key`
// is a plain string and has no schema.

export const inferenceApiKeyMapSecretSchema = z
  .record(z.string(), z.string())
  .refine((value) => Object.keys(value).length > 0, {
    message: "api_key_map must contain at least one entry",
  });
export type InferenceApiKeyMapSecret = z.infer<typeof inferenceApiKeyMapSecretSchema>;

export const inferenceAwsKeysSecretSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});
export type InferenceAwsKeysSecret = z.infer<typeof inferenceAwsKeysSecretSchema>;

export const inferenceGcpServiceAccountSecretSchema = z.looseObject({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().min(1),
});
export type InferenceGcpServiceAccountSecret = z.infer<
  typeof inferenceGcpServiceAccountSecretSchema
>;

export const inferenceOauthTokenSecretSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.string().min(1).optional(),
});
export type InferenceOauthTokenSecret = z.infer<typeof inferenceOauthTokenSecretSchema>;

export type InferenceProviderSecret =
  | { kind: "api_key"; apiKey: string }
  | { kind: "api_key_map"; apiKeys: InferenceApiKeyMapSecret }
  | { kind: "aws_keys"; awsKeys: InferenceAwsKeysSecret }
  | { kind: "gcp_service_account"; serviceAccount: InferenceGcpServiceAccountSecret }
  | { kind: "oauth_google"; token: InferenceOauthTokenSecret }
  | { kind: "oauth_azure"; token: InferenceOauthTokenSecret };

function parseJsonSecret(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Inference provider secret is not valid JSON");
  }
}

/**
 * Parse a decrypted `inference_provider_credentials.secret` value by kind.
 * Throws on malformed input; never logs the raw value.
 */
export function parseInferenceProviderSecret(
  kind: InferenceProviderCredentialKind,
  raw: string,
): InferenceProviderSecret {
  switch (kind) {
    case "api_key":
      return { kind, apiKey: raw.trim() };
    case "api_key_map":
      return { kind, apiKeys: inferenceApiKeyMapSecretSchema.parse(parseJsonSecret(raw)) };
    case "aws_keys":
      return { kind, awsKeys: inferenceAwsKeysSecretSchema.parse(parseJsonSecret(raw)) };
    case "gcp_service_account":
      return {
        kind,
        serviceAccount: inferenceGcpServiceAccountSecretSchema.parse(parseJsonSecret(raw)),
      };
    case "oauth_google":
    case "oauth_azure":
      return { kind, token: inferenceOauthTokenSecretSchema.parse(parseJsonSecret(raw)) };
  }
}
