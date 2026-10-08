import { z } from "zod";

export const INFERENCE_USAGE_CONVERSION_FACTOR = 100_000_000;

// Den's web app loads this module from source, where a runtime relative import cannot resolve, so it keeps
// its own copy of managed-models-policy's metadata reader instead of importing it.
function readOrganizationMetadata(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Organization metadata must be a JSON object.");
  return Object.fromEntries(Object.entries(value));
}

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
  // The model behind free Auto, on the organization's own usage and counted at half its cost.
  "openai/gpt-6-luna": {
    upstreamModel: "openai/gpt-6-luna",
    displayName: "OpenWork: GPT-6 Luna",
    enabled: true,
    usageFactor: 0.5,
  },
} as const;

export type InferenceModelAlias = keyof typeof INFERENCE_MODEL_ALIASES;

export type InferenceOrganizationMetadata = {
  enabled: true;
  tier: InferenceTier;
};

export const INFERENCE_FREE_MODEL_ID = "openai/gpt-6-luna";
export const INFERENCE_FREE_ENV = {
  enabled: "INFERENCE_FREE_ENABLED",
  weeklyBudgetUsd: "INFERENCE_FREE_WEEKLY_BUDGET_USD",
  modelID: "INFERENCE_FREE_MODEL_ID",
} as const;

export type FreeInferenceConfig = {
  enabled: boolean;
  weeklyBudgetUsd: number;
  weeklyLimitAmount: number;
  modelID: typeof INFERENCE_FREE_MODEL_ID;
};

export function readFreeInferenceConfig(environment: Record<string, string | undefined>): FreeInferenceConfig {
  const enabled = environment[INFERENCE_FREE_ENV.enabled] ?? "false";
  if (!["true", "false", "1", "0"].includes(enabled)) throw new Error("Invalid INFERENCE_FREE_ENABLED");
  const budget = environment[INFERENCE_FREE_ENV.weeklyBudgetUsd] ?? "5";
  const weeklyBudgetUsd = Number(budget);
  const weeklyLimitAmount = Math.floor(weeklyBudgetUsd * INFERENCE_USAGE_CONVERSION_FACTOR);
  if (!budget.trim() || !Number.isFinite(weeklyBudgetUsd) || weeklyBudgetUsd < 0 || weeklyBudgetUsd > 100
    || !Number.isSafeInteger(weeklyLimitAmount)) throw new Error("Invalid INFERENCE_FREE_WEEKLY_BUDGET_USD");
  const modelID = environment[INFERENCE_FREE_ENV.modelID] ?? INFERENCE_FREE_MODEL_ID;
  if (modelID !== INFERENCE_FREE_MODEL_ID) throw new Error("Unapproved free model");
  return { enabled: enabled === "true" || enabled === "1", weeklyBudgetUsd: weeklyLimitAmount / INFERENCE_USAGE_CONVERSION_FACTOR, weeklyLimitAmount, modelID: INFERENCE_FREE_MODEL_ID };
}

export function freeInferenceWindow(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return { start, end: new Date(start.getTime() + INFERENCE_WINDOW_DURATIONS_MS.weekly) };
}

export const INFERENCE_ACCESS_REASONS = [
  "admin_disabled", "not_eligible", "free_disabled", "accounting_unavailable",
  "free_allowance_exhausted", "upstream_unavailable",
] as const;
export type InferenceAccessReason = (typeof INFERENCE_ACCESS_REASONS)[number];
export type ManagedModelRecommendation = {
  modelID: string; displayName: string; providerName: string; summary: string;
  recommended: boolean; rank: number; capabilities: string[];
};
export type InferenceAccess = {
  kind: "paid" | "free" | "exhausted" | "unavailable";
  modelID: string | null;
  weeklyLimitUsd: number | null;
  usedUsd: number | null;
  remainingUsd: number | null;
  resetsAt: string | null;
  reason: InferenceAccessReason | null;
  canUpgrade?: boolean;
  catalog?: ManagedModelRecommendation[];
  defaultPinned?: boolean;
};

export type FreeInferenceProviderSummary = {
  state: "available" | "disabled" | "unavailable";
  reason: InferenceAccessReason | null;
  defaultPinned: boolean;
  modelGroup: { id: "free"; name: "Free" };
  catalog: ManagedModelRecommendation[];
  allowance: {
    usageScope: "organization";
    allowanceScope: "person";
    windowStartAt: string;
    resetsAt: string;
    weeklyLimitUsd: number;
    joinedMembers: number;
    eligibleMembers: number;
    exhaustedMembers: number | null;
    usedUsd: number | null;
    requestCount: number | null;
  };
};

export const freeInferenceProviderSummarySchema = z.object({
  state: z.enum(["available", "disabled", "unavailable"]), reason: z.union([z.enum(INFERENCE_ACCESS_REASONS), z.null()]),
  defaultPinned: z.boolean(), modelGroup: z.object({ id: z.literal("free"), name: z.literal("Free") }),
  catalog: z.array(z.object({ modelID: z.string(), displayName: z.string(), providerName: z.string(), summary: z.string(), recommended: z.boolean(), rank: z.number(), capabilities: z.array(z.string()) })),
  allowance: z.object({
    usageScope: z.literal("organization"), allowanceScope: z.literal("person"),
    windowStartAt: z.string().datetime(), resetsAt: z.string().datetime(), weeklyLimitUsd: z.number().finite().nonnegative(),
    joinedMembers: z.number().int().nonnegative(), eligibleMembers: z.number().int().nonnegative(), exhaustedMembers: z.number().int().nonnegative().nullable().describe("Current eligible members whose recorded weekly usage has reached their person-wide limit; not a probe of Gateway request headroom. Null when accounting cannot be verified."),
    usedUsd: z.number().finite().nonnegative().nullable(), requestCount: z.number().int().nonnegative().nullable(),
  }),
});

/** Auto is unpinned unless an organization admin pins it for everyone. */
export function freeInferenceDefaultPinned(metadata: unknown): boolean {
  const free = readOrganizationMetadata(metadata).inferenceFree;
  return typeof free === "object" && free !== null && "defaultPinned" in free && free.defaultPinned === true;
}

export function withFreeInferenceDefaultPinned(metadata: Record<string, unknown>, defaultPinned: boolean): Record<string, unknown> {
  const free = metadata.inferenceFree;
  return { ...metadata, inferenceFree: { ...(typeof free === "object" && free !== null && !Array.isArray(free) ? free : {}), defaultPinned } };
}

export function managedModelCatalog(): ManagedModelRecommendation[] {
  return [{ modelID: INFERENCE_FREE_MODEL_ID, displayName: "Auto", providerName: "OpenWork",
    summary: "Free automatic model", recommended: true, rank: 1, capabilities: ["tools"] }];
}

/**
 * Stripe states in which an organization is still paying, or still being collected, for OpenWork Models
 * (a trial counts). Reporting only, for the free Auto usage report's "subscribed" column: free Auto serves
 * these organizations too, from each member's free allowance, and never bills them.
 */
export const INFERENCE_LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "incomplete"] as const;
export function inferenceSubscriptionLive(status: string | null | undefined): boolean {
  return (INFERENCE_LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? "");
}

/** Subscribed organizations use paid OpenWork Models; free Auto is only for unsubscribed members. */
export function inferenceSubscribed(metadata: unknown): boolean {
  const inference = readOrganizationMetadata(metadata).inference;
  return typeof inference === "object" && inference !== null && "enabled" in inference && inference.enabled === true;
}

export function freeInferenceOrganizationAllowed(metadata: unknown): boolean {
  const parsed = readOrganizationMetadata(metadata);
  const inference = parsed.inference;
  const free = parsed.inferenceFree;
  if (typeof inference === "object" && inference !== null && "enabled" in inference && inference.enabled === false) return false;
  if (typeof free === "object" && free !== null && "offerAllowed" in free && free.offerAllowed === false) return false;
  return true;
}

export function freeInferenceAccess(input: {
  config: FreeInferenceConfig;
  reason?: InferenceAccessReason | null;
  bucket?: { used_amount: number } | null;
  now?: Date;
}): InferenceAccess {
  // Like paid Models: the current limit applies, and the allowance is used up once usage reaches it.
  const limit = input.config.weeklyLimitAmount;
  const used = input.bucket?.used_amount ?? 0;
  const valid = [limit, used].every((amount) => Number.isSafeInteger(amount) && amount >= 0);
  const remaining = Math.max(0, limit - used);
  const reason = input.reason ?? (!input.config.enabled ? "free_disabled" : !valid
    ? "accounting_unavailable" : remaining === 0 ? "free_allowance_exhausted" : null);
  return { kind: reason === null ? "free" : reason === "free_allowance_exhausted" ? "exhausted" : "unavailable",
    modelID: input.config.modelID, weeklyLimitUsd: valid ? limit / INFERENCE_USAGE_CONVERSION_FACTOR : null,
    usedUsd: valid ? used / INFERENCE_USAGE_CONVERSION_FACTOR : null,
    remainingUsd: valid ? remaining / INFERENCE_USAGE_CONVERSION_FACTOR : null, resetsAt: freeInferenceWindow(input.now).end.toISOString(),
    reason, canUpgrade: false, catalog: managedModelCatalog() };
}

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
  "aws_sso",
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

// openwork_free: signed-in members' free Auto, served from the dedicated OpenAI key.
export const INFERENCE_REQUEST_ROUTES = ["openwork_openrouter", "org_provider", "openwork_free"] as const;
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

const authorizationRevisionSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A Microsoft Entra ID directory (tenant) ID. Only the GUID form: the token issuer names it. */
export const microsoftTenantIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const inferenceOauthTokenSecretSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.string().min(1).optional(),
  googleIdentity: z.object({
    subject: z.string().min(1).max(255),
    email: z.email(),
    emailVerified: z.literal(true),
    clientId: z.string().min(1),
    authorizationRevision: authorizationRevisionSchema.optional(),
  }).optional(),
  /** Member Entra ID sign-in (Microsoft Foundry). The tenant and client the refresh token belongs to. */
  microsoftIdentity: z.object({
    tenantId: microsoftTenantIdSchema,
    objectId: z.string().min(1).max(255),
    /** preferred_username or email from the ID token; display only, never an authorization input. */
    userName: z.string().min(1).max(320).nullable(),
    clientId: z.string().min(1),
    authorizationRevision: authorizationRevisionSchema,
  }).optional(),
});
export type InferenceOauthTokenSecret = z.infer<typeof inferenceOauthTokenSecretSchema>;

/** AWS account IDs are 12 digits. */
export const awsAccountIdSchema = z.string().regex(/^\d{12}$/);
/** IAM Identity Center permission-set names: 1-32 characters from [\w+=,.@-]. */
export const awsPermissionSetNameSchema = z.string().regex(/^[\w+=,.@-]{1,32}$/);
/**
 * The AWS access portal URL, e.g. https://d-xxxxxxxxxx.awsapps.com/start, a custom
 * awsapps.com subdomain, or an account instance's https://ssoins-….portal.<region>.app.aws.
 * It is only ever sent to IAM Identity Center, never fetched.
 */
export const awsSsoStartUrlSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port
      && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:awsapps\.com|app\.aws)$/i.test(url.hostname);
  } catch { return false; }
}, { message: "Use the AWS access portal URL, for example https://d-xxxxxxxxxx.awsapps.com/start." });
const awsRegionSchema = z.string().max(32).regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/);

/**
 * Non-secret IAM Identity Center settings of a member credential set: everyone
 * who signs in through the set gets credentials for this account and permission set.
 */
export const gatewayAwsSsoSettingsSchema = z.object({
  startUrl: awsSsoStartUrlSchema,
  /** IAM Identity Center home region, which can differ from the Bedrock region. */
  region: awsRegionSchema,
  accountId: awsAccountIdSchema,
  roleName: awsPermissionSetNameSchema,
}).strict();
export type GatewayAwsSsoSettings = z.infer<typeof gatewayAwsSsoSettingsSchema>;

/**
 * Member IAM Identity Center sign-in (Amazon Bedrock). The token, the OIDC client
 * it was issued to, and the account and permission set it was approved for.
 */
export const inferenceAwsSsoSecretSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384),
  clientId: z.string().min(1).max(4096),
  clientSecret: z.string().min(1).max(16_384),
  /** Epoch seconds after which the registered OIDC client, and its refresh token, stop working. */
  clientSecretExpiresAt: z.number().int().positive(),
  sso: gatewayAwsSsoSettingsSchema,
  identity: z.object({
    /** The assumed-role ARN from STS GetCallerIdentity at sign-in. */
    arn: z.string().min(1).max(2048),
    /** The role session name, normally the person's Identity Center user name. Display only. */
    userName: z.string().min(1).max(320).nullable(),
    authorizationRevision: authorizationRevisionSchema,
  }),
});
export type InferenceAwsSsoSecret = z.infer<typeof inferenceAwsSsoSecretSchema>;

/** Synthetic catalog provider for Claude on Microsoft Foundry (the Anthropic API on `<resource>.services.ai.azure.com`). */
export const MICROSOFT_FOUNDRY_PROVIDER_ID = "microsoft-foundry";

/** How a person signs in to a Gateway provider in a member credential set. */
export const GATEWAY_MEMBER_SIGN_IN_METHODS = ["google", "aws_sso", "microsoft"] as const;
export type GatewayMemberSignInMethod = (typeof GATEWAY_MEMBER_SIGN_IN_METHODS)[number];

/** The member credential kind each sign-in method stores. */
export const GATEWAY_MEMBER_SIGN_IN_CREDENTIAL_KINDS = {
  google: "oauth_google",
  aws_sso: "aws_sso",
  microsoft: "oauth_azure",
} as const satisfies Record<GatewayMemberSignInMethod, InferenceProviderCredentialKind>;

/**
 * The sign-in a provider supports for member credential sets, or null when
 * members cannot sign in (LiteLLM has its own per-person keys).
 */
export function gatewayMemberSignInMethod(providerId: string): GatewayMemberSignInMethod | null {
  if (providerId === "google-vertex" || providerId === "google-vertex-anthropic") return "google";
  if (providerId === "amazon-bedrock" || providerId === "amazon-bedrock-mantle") return "aws_sso";
  if (providerId === MICROSOFT_FOUNDRY_PROVIDER_ID) return "microsoft";
  return null;
}

export const gatewayMemberConnectionsResponseSchema = z.object({
  connections: z.array(z.object({
    providerId: z.string(),
    /** Older Den responses omit it; they only offered Google sign-in. */
    signInMethod: z.enum(GATEWAY_MEMBER_SIGN_IN_METHODS).default("google"),
    credentialSetId: z.string(),
    providerName: z.string(),
    name: z.string(),
    ready: z.boolean(),
    hasAccess: z.boolean(),
    hasCredential: z.boolean(),
    configurationRequired: z.boolean().default(false),
    authorizationRevision: z.string().nullable(),
    accountEmail: z.string().nullable(),
  })),
});
export type GatewayMemberConnectionsResponse = z.infer<typeof gatewayMemberConnectionsResponseSchema>;

export type InferenceProviderSecret =
  | { kind: "api_key"; apiKey: string }
  | { kind: "api_key_map"; apiKeys: InferenceApiKeyMapSecret }
  | { kind: "aws_keys"; awsKeys: InferenceAwsKeysSecret }
  | { kind: "gcp_service_account"; serviceAccount: InferenceGcpServiceAccountSecret }
  | { kind: "oauth_google"; token: InferenceOauthTokenSecret }
  | { kind: "oauth_azure"; token: InferenceOauthTokenSecret }
  | { kind: "aws_sso"; awsSso: InferenceAwsSsoSecret };

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
    case "aws_sso":
      return { kind, awsSso: inferenceAwsSsoSecretSchema.parse(parseJsonSecret(raw)) };
  }
}
