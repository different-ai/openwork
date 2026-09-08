import "./load-env.js";
import type { DenDbMode, PlanetScaleCredentials } from "@openwork-ee/den-db";
import { z } from "zod";
import { INFERENCE_FREE_ENV, readFreeInferenceConfig } from "@openwork/types/den/inference";
import { DESKTOP_FREE_RELEASE_URL } from "./desktop-free-version.js";

const EnvSchema = z
  .object({
    PORT: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    DATABASE_URL: z.string().min(1).optional(),
    DB_MODE: z.enum(["mysql", "planetscale"]).optional(),
    DATABASE_HOST: z.string().min(1).optional(),
    DATABASE_USERNAME: z.string().min(1).optional(),
    DATABASE_PASSWORD: z.string().optional(),
    DEN_DB_ENCRYPTION_KEY: z.string().trim().min(32),
    INFERENCE_PROXY_BASE_URL: z.string().optional(),
    OPENROUTER_UPSTREAM_URL: z.string().optional(),
    OPENAI_REALTIME_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    INFERENCE_ADMIN_TOKEN: z.string().optional(),
    INFERENCE_WEBHOOK_SECRET: z.string().optional(),
    INFERENCE_CREDITS_PER_DOLLAR: z.string().optional(),
    DESKTOP_FREE_APP_VERSION_URL: z.string().url().optional(),
    ANONYMOUS_INFERENCE_ENABLED: z.string().optional(),
    ANONYMOUS_OPENROUTER_API_KEY: z.string().optional(),
    ANONYMOUS_TOKEN_SECRET: z.string().optional(),
    ANONYMOUS_ACCOUNTING_IDENTITY_KEY: z.string().optional(),
    ANONYMOUS_OPENROUTER_PROVIDER: z.string().optional(),
    ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED: z.string().optional(),
    ANONYMOUS_TOKEN_TTL_SECONDS: z.string().optional(),
    ANONYMOUS_INSTALL_WEEKLY_MICRO_USD: z.string().optional(),
    ANONYMOUS_IP_DAILY_MICRO_USD: z.string().optional(),
    ANONYMOUS_GLOBAL_DAILY_MICRO_USD: z.string().optional(),
    ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD: z.string().optional(),
    ANONYMOUS_GLOBAL_INFLIGHT: z.string().optional(),
    ANONYMOUS_SESSION_INSTALL_HOURLY: z.string().optional(),
    ANONYMOUS_SESSION_IP_HOURLY: z.string().optional(),
    ANONYMOUS_SESSION_GLOBAL_HOURLY: z.string().optional(),
    ANONYMOUS_REQUEST_INSTALL_HOURLY: z.string().optional(),
    ANONYMOUS_REQUEST_IP_HOURLY: z.string().optional(),
    ANONYMOUS_REQUEST_GLOBAL_HOURLY: z.string().optional(),
    ANONYMOUS_MAX_BODY_BYTES: z.string().optional(),
    ANONYMOUS_MAX_INPUT_TOKENS: z.string().optional(),
    ANONYMOUS_CHAT_WRAPPING_TOKEN_ALLOWANCE: z.string().optional(),
    ANONYMOUS_MAX_COMPLETION_TOKENS: z.string().optional(),
    ANONYMOUS_MAX_INPUT_PRICE_MICRO_USD_PER_MILLION: z.string().optional(),
    ANONYMOUS_MAX_COMPLETION_PRICE_MICRO_USD_PER_MILLION: z.string().optional(),
    ANONYMOUS_REQUEST_TIMEOUT_MS: z.string().optional(),
    ANONYMOUS_MAX_RESPONSE_BYTES: z.string().optional(),
    ANONYMOUS_TRUST_PROXY_HOPS: z.string().optional(),
    ANONYMOUS_TRUSTED_PROXY_IPS: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const mode =
      value.DB_MODE ?? (value.DATABASE_URL ? "mysql" : "planetscale");
    if (mode === "mysql" && !value.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required in mysql mode",
      });
    }
    if (mode === "planetscale") {
      for (const key of [
        "DATABASE_HOST",
        "DATABASE_USERNAME",
        "DATABASE_PASSWORD",
      ] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required in planetscale mode`,
          });
        }
      }
    }
  });

export const isDevMode = process.env.OPENWORK_DEV_MODE === "1";

const parsed = EnvSchema.parse({
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    (isDevMode
      ? "mysql://root:password@127.0.0.1:3306/openwork_den"
      : undefined),
  DB_MODE: process.env.DB_MODE ?? (isDevMode ? "mysql" : undefined),
  DEN_DB_ENCRYPTION_KEY:
    process.env.DEN_DB_ENCRYPTION_KEY ??
    (isDevMode
      ? "local-dev-db-encryption-key-please-change-1234567890"
      : undefined),
  INFERENCE_WEBHOOK_SECRET:
    process.env.INFERENCE_WEBHOOK_SECRET ??
    (isDevMode ? "local-dev-webhook-secret" : undefined),
});

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function parsePort(value: string | undefined) {
  const port = Number(value ?? "8791");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseCreditsPerDollar(value: string | undefined) {
  const credits = Number(value ?? "1000000");
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error("INFERENCE_CREDITS_PER_DOLLAR must be a positive number");
  }
  return credits;
}

// Anonymous configuration reused from #4621 (401267fc); installation spend is
// weekly, and the independent IP cap allows a whole weekly allowance in a day.
function parseBoolean(name: string, value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseInteger(name: string, value: string | undefined, fallback: number, min: number, max: number) {
  const parsedValue = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < min || parsedValue > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsedValue;
}

const anonymousRequestedEnabled = parseBoolean("ANONYMOUS_INFERENCE_ENABLED", parsed.ANONYMOUS_INFERENCE_ENABLED, false);
const anonymousByokOnlyVerified = parseBoolean("ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED", parsed.ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED, false);
const anonymousApiKey = optionalString(parsed.ANONYMOUS_OPENROUTER_API_KEY);
const anonymousTokenSecret = optionalString(parsed.ANONYMOUS_TOKEN_SECRET);
const anonymousAccountingIdentityKey = optionalString(parsed.ANONYMOUS_ACCOUNTING_IDENTITY_KEY);
const anonymousProvider = optionalString(parsed.ANONYMOUS_OPENROUTER_PROVIDER);
const anonymousConfigurationReady = Boolean(
  anonymousApiKey && anonymousTokenSecret && anonymousTokenSecret.length >= 32
  && anonymousAccountingIdentityKey && anonymousAccountingIdentityKey.length >= 32
  && anonymousAccountingIdentityKey !== anonymousTokenSecret && anonymousProvider
  && anonymousByokOnlyVerified
  && (isDevMode || normalizeUrl(parsed.OPENROUTER_UPSTREAM_URL ?? "https://openrouter.ai/api/v1").startsWith("https://")),
);

const planetscale: PlanetScaleCredentials | null =
  parsed.DATABASE_HOST &&
  parsed.DATABASE_USERNAME &&
  parsed.DATABASE_PASSWORD !== undefined
    ? {
        host: parsed.DATABASE_HOST,
        username: parsed.DATABASE_USERNAME,
        password: parsed.DATABASE_PASSWORD,
      }
    : null;

export const env = {
  desktopFreeAppVersionUrl: parsed.DESKTOP_FREE_APP_VERSION_URL ?? DESKTOP_FREE_RELEASE_URL,
  freeInference: readFreeInferenceConfig(process.env),
  freeUpstreamApiKey: optionalString(process.env[INFERENCE_FREE_ENV.upstreamApiKey]),
  port: parsePort(parsed.PORT),
  corsOrigins: splitCsv(parsed.CORS_ORIGINS),
  databaseUrl: parsed.DATABASE_URL,
  dbMode: (parsed.DB_MODE ??
    (parsed.DATABASE_URL ? "mysql" : "planetscale")) as DenDbMode,
  planetscale,
  dbEncryptionKey: parsed.DEN_DB_ENCRYPTION_KEY,
  proxyBaseUrl: optionalString(parsed.INFERENCE_PROXY_BASE_URL),
  openRouterUpstreamUrl: normalizeUrl(
    parsed.OPENROUTER_UPSTREAM_URL ?? "https://openrouter.ai/api/v1",
  ),
  openAiRealtimeApiKey: optionalString(parsed.OPENAI_REALTIME_API_KEY) ?? optionalString(parsed.OPENAI_API_KEY),
  adminToken: optionalString(parsed.INFERENCE_ADMIN_TOKEN),
  webhookSecret: optionalString(parsed.INFERENCE_WEBHOOK_SECRET),
  creditsPerDollar: parseCreditsPerDollar(parsed.INFERENCE_CREDITS_PER_DOLLAR),
  anonymous: {
    requestedEnabled: anonymousRequestedEnabled,
    enabled: anonymousRequestedEnabled && anonymousConfigurationReady,
    configurationReady: anonymousConfigurationReady,
    apiKey: anonymousApiKey,
    tokenSecret: anonymousTokenSecret,
    accountingIdentityKey: anonymousAccountingIdentityKey,
    provider: anonymousProvider,
    byokOnlyVerified: anonymousByokOnlyVerified,
    tokenTtlSeconds: parseInteger("ANONYMOUS_TOKEN_TTL_SECONDS", parsed.ANONYMOUS_TOKEN_TTL_SECONDS, 3600, 1, 86_400),
    installWeeklyMicroUsd: parseInteger("ANONYMOUS_INSTALL_WEEKLY_MICRO_USD", parsed.ANONYMOUS_INSTALL_WEEKLY_MICRO_USD, 1_000_000, 1, 100_000_000),
    ipDailyMicroUsd: parseInteger("ANONYMOUS_IP_DAILY_MICRO_USD", parsed.ANONYMOUS_IP_DAILY_MICRO_USD, 5_000_000, 1, 100_000_000),
    globalDailyMicroUsd: parseInteger("ANONYMOUS_GLOBAL_DAILY_MICRO_USD", parsed.ANONYMOUS_GLOBAL_DAILY_MICRO_USD, 100_000_000, 1, 1_000_000_000),
    globalMonthlyMicroUsd: parseInteger("ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD", parsed.ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD, 3_000_000_000, 1, 10_000_000_000),
    globalInflight: parseInteger("ANONYMOUS_GLOBAL_INFLIGHT", parsed.ANONYMOUS_GLOBAL_INFLIGHT, 20, 1, 1_000),
    sessionInstallHourly: parseInteger("ANONYMOUS_SESSION_INSTALL_HOURLY", parsed.ANONYMOUS_SESSION_INSTALL_HOURLY, 12, 1, 10_000),
    sessionIpHourly: parseInteger("ANONYMOUS_SESSION_IP_HOURLY", parsed.ANONYMOUS_SESSION_IP_HOURLY, 60, 1, 100_000),
    sessionGlobalHourly: parseInteger("ANONYMOUS_SESSION_GLOBAL_HOURLY", parsed.ANONYMOUS_SESSION_GLOBAL_HOURLY, 10_000, 1, 1_000_000),
    requestInstallHourly: parseInteger("ANONYMOUS_REQUEST_INSTALL_HOURLY", parsed.ANONYMOUS_REQUEST_INSTALL_HOURLY, 60, 1, 100_000),
    requestIpHourly: parseInteger("ANONYMOUS_REQUEST_IP_HOURLY", parsed.ANONYMOUS_REQUEST_IP_HOURLY, 300, 1, 1_000_000),
    requestGlobalHourly: parseInteger("ANONYMOUS_REQUEST_GLOBAL_HOURLY", parsed.ANONYMOUS_REQUEST_GLOBAL_HOURLY, 10_000, 1, 10_000_000),
    maxBodyBytes: parseInteger("ANONYMOUS_MAX_BODY_BYTES", parsed.ANONYMOUS_MAX_BODY_BYTES, 262_144, 1_024, 1_048_576),
    maxInputTokens: parseInteger("ANONYMOUS_MAX_INPUT_TOKENS", parsed.ANONYMOUS_MAX_INPUT_TOKENS, 131_072, 256, 131_072),
    chatWrappingTokenAllowance: parseInteger("ANONYMOUS_CHAT_WRAPPING_TOKEN_ALLOWANCE", parsed.ANONYMOUS_CHAT_WRAPPING_TOKEN_ALLOWANCE, 2_048, 2_048, 32_768),
    maxCompletionTokens: parseInteger("ANONYMOUS_MAX_COMPLETION_TOKENS", parsed.ANONYMOUS_MAX_COMPLETION_TOKENS, 4_096, 1, 16_384),
    maxInputPriceMicroUsdPerMillion: parseInteger("ANONYMOUS_MAX_INPUT_PRICE_MICRO_USD_PER_MILLION", parsed.ANONYMOUS_MAX_INPUT_PRICE_MICRO_USD_PER_MILLION, 250_000, 1, 100_000_000),
    maxCompletionPriceMicroUsdPerMillion: parseInteger("ANONYMOUS_MAX_COMPLETION_PRICE_MICRO_USD_PER_MILLION", parsed.ANONYMOUS_MAX_COMPLETION_PRICE_MICRO_USD_PER_MILLION, 1_200_000, 1, 100_000_000),
    requestTimeoutMs: parseInteger("ANONYMOUS_REQUEST_TIMEOUT_MS", parsed.ANONYMOUS_REQUEST_TIMEOUT_MS, 60_000, 1_000, 300_000),
    maxResponseBytes: parseInteger("ANONYMOUS_MAX_RESPONSE_BYTES", parsed.ANONYMOUS_MAX_RESPONSE_BYTES, 2_097_152, 16_384, 16_777_216),
    trustProxyHops: parseInteger("ANONYMOUS_TRUST_PROXY_HOPS", parsed.ANONYMOUS_TRUST_PROXY_HOPS, 0, 0, 8),
    trustedProxyIps: splitCsv(parsed.ANONYMOUS_TRUSTED_PROXY_IPS),
  },
};
