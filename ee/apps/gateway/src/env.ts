import "./load-env.js";
import type { DenDbMode, PlanetScaleCredentials } from "@openwork-ee/den-db";
import { gatewayInteger, gatewayOrigin, parseGatewayDeploymentEnv } from "@openwork-ee/utils/gateway-env";
import { z } from "zod";

const EnvSchema = z
  .object({
    PORT: z.number().int().min(1).max(65535),
    CORS_ORIGINS: z.string().optional(),
    DATABASE_URL: z.string().min(1).optional(),
    DB_MODE: z.enum(["mysql", "planetscale"]).optional(),
    DATABASE_HOST: z.string().min(1).optional(),
    DATABASE_USERNAME: z.string().min(1).optional(),
    DATABASE_PASSWORD: z.string().optional(),
    DEN_DB_ENCRYPTION_KEY: z.string().trim().min(32),
    GATEWAY_PROXY_BASE_URL: z.string().optional(),
    OPENROUTER_UPSTREAM_URL: z.string().optional(),
    GATEWAY_STREAM_IDLE_MS: z.number().int().min(1000).max(900000),
    OPENAI_REALTIME_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    GATEWAY_ADMIN_TOKEN: z.string().optional(),
    GATEWAY_UPSTREAM_TIMEOUT_MS: z.number().int().min(1000).max(24 * 60 * 60_000),
    GATEWAY_WEBHOOK_SECRET: z.string().optional(),
    GATEWAY_CREDITS_PER_DOLLAR: z.string().optional(),
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

export const isDevMode = process.env.OPENWORK_DEV_MODE === "1" && process.env.NODE_ENV !== "production";

const input = {
  ...process.env,
  // Deprecated INFERENCE_* aliases: an explicitly set GATEWAY_* value wins,
  // including empty values (disable), and invalid values fail validation.
  PORT: gatewayInteger(process.env.GATEWAY_PORT ?? process.env.PORT ?? process.env.INFERENCE_PORT, "GATEWAY_PORT (or PORT/INFERENCE_PORT when absent)", 8791, 1, 65535),
  GATEWAY_PROXY_BASE_URL: process.env.GATEWAY_PROXY_BASE_URL ?? process.env.INFERENCE_PROXY_BASE_URL,
  GATEWAY_ADMIN_TOKEN: process.env.GATEWAY_ADMIN_TOKEN ?? process.env.INFERENCE_ADMIN_TOKEN,
  GATEWAY_UPSTREAM_TIMEOUT_MS: gatewayInteger(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? process.env.INFERENCE_UPSTREAM_TIMEOUT_MS, "GATEWAY_UPSTREAM_TIMEOUT_MS", 30 * 60_000, 1000, 24 * 60 * 60_000),
  GATEWAY_STREAM_IDLE_MS: gatewayInteger(process.env.GATEWAY_STREAM_IDLE_MS ?? process.env.INFERENCE_STREAM_IDLE_MS, "GATEWAY_STREAM_IDLE_MS", 120000, 1000, 900000),
  GATEWAY_CREDITS_PER_DOLLAR: process.env.GATEWAY_CREDITS_PER_DOLLAR ?? process.env.INFERENCE_CREDITS_PER_DOLLAR,
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
  GATEWAY_WEBHOOK_SECRET:
    process.env.GATEWAY_WEBHOOK_SECRET ?? process.env.INFERENCE_WEBHOOK_SECRET ??
    (isDevMode ? "local-dev-webhook-secret" : undefined),
};
const gatewayDeployment = parseGatewayDeploymentEnv({ ...process.env,
  DATABASE_URL: input.DATABASE_URL,
  DB_MODE: input.DB_MODE,
  DEN_DB_ENCRYPTION_KEY: input.DEN_DB_ENCRYPTION_KEY,
});
const parsed = EnvSchema.parse(input);
const openRouterUpstreamUrl = normalizeUrl(parsed.OPENROUTER_UPSTREAM_URL ?? "https://openrouter.ai/api/v1");
if (gatewayDeployment.enabled) {
  try {
    const url = new URL(openRouterUpstreamUrl);
    if (url.username || url.password || url.search || url.hash || openRouterUpstreamUrl !== openRouterUpstreamUrl.trim()) throw new Error();
    gatewayOrigin(url.origin, "OPENROUTER_UPSTREAM_URL", !isDevMode, true);
  } catch {
    throw new Error("OPENROUTER_UPSTREAM_URL must be an HTTP(S) URL without credentials, query, or fragment; production requires non-local HTTPS");
  }
}

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

function parseCreditsPerDollar(value: string | undefined) {
  const credits = Number(value ?? "1000000");
  if ((value !== undefined && !/^\d+(?:\.\d+)?$/.test(value)) || !Number.isFinite(credits) || credits <= 0) {
    throw new Error("GATEWAY_CREDITS_PER_DOLLAR must be a positive number");
  }
  return credits;
}

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
  gatewayEnabled: gatewayDeployment.enabled,
  upstreamTimeoutMs: parsed.GATEWAY_UPSTREAM_TIMEOUT_MS,
  port: parsed.PORT,
  managedUpstreamTimeoutMs: process.env.GATEWAY_UPSTREAM_TIMEOUT_MS !== undefined || process.env.INFERENCE_UPSTREAM_TIMEOUT_MS !== undefined
    ? parsed.GATEWAY_UPSTREAM_TIMEOUT_MS : 120000,
  streamIdleMs: parsed.GATEWAY_STREAM_IDLE_MS,
  corsOrigins: splitCsv(parsed.CORS_ORIGINS).map((origin) => gatewayDeployment.enabled ? gatewayOrigin(origin, "CORS_ORIGINS", !isDevMode, true) : origin),
  databaseUrl: parsed.DATABASE_URL,
  dbMode: (parsed.DB_MODE ??
    (parsed.DATABASE_URL ? "mysql" : "planetscale")) as DenDbMode,
  planetscale,
  dbEncryptionKey: parsed.DEN_DB_ENCRYPTION_KEY,
  proxyBaseUrl: optionalString(parsed.GATEWAY_PROXY_BASE_URL),
  openRouterUpstreamUrl,
  openAiRealtimeApiKey: optionalString(parsed.OPENAI_REALTIME_API_KEY) ?? optionalString(parsed.OPENAI_API_KEY),
  adminToken: optionalString(parsed.GATEWAY_ADMIN_TOKEN),
  webhookSecret: optionalString(parsed.GATEWAY_WEBHOOK_SECRET),
  creditsPerDollar: parseCreditsPerDollar(parsed.GATEWAY_CREDITS_PER_DOLLAR),
};
