import "./load-env.js";
import type { DenDbMode, PlanetScaleCredentials } from "@openwork-ee/den-db";
import { z } from "zod";

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
    GATEWAY_PROXY_BASE_URL: z.string().optional(),
    OPENROUTER_UPSTREAM_URL: z.string().optional(),
    INFERENCE_STREAM_IDLE_MS: z.coerce.number().int().min(1000).max(900000).default(120000),
    OPENAI_REALTIME_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    GATEWAY_ADMIN_TOKEN: z.string().optional(),
    GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(24 * 60 * 60_000).default(30 * 60_000),
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

export const isDevMode = process.env.OPENWORK_DEV_MODE === "1";

const parsed = EnvSchema.parse({
  ...process.env,
  // Deprecated INFERENCE_* aliases: an explicitly set GATEWAY_* value wins,
  // including empty values (disable), and invalid values fail validation.
  PORT: process.env.GATEWAY_PORT ?? process.env.PORT ?? process.env.INFERENCE_PORT,
  GATEWAY_PROXY_BASE_URL: process.env.GATEWAY_PROXY_BASE_URL ?? process.env.INFERENCE_PROXY_BASE_URL,
  GATEWAY_ADMIN_TOKEN: process.env.GATEWAY_ADMIN_TOKEN ?? process.env.INFERENCE_ADMIN_TOKEN,
  GATEWAY_UPSTREAM_TIMEOUT_MS: process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? process.env.INFERENCE_UPSTREAM_TIMEOUT_MS,
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
  upstreamTimeoutMs: parsed.GATEWAY_UPSTREAM_TIMEOUT_MS,
  port: parsePort(parsed.PORT),
  managedUpstreamTimeoutMs: process.env.GATEWAY_UPSTREAM_TIMEOUT_MS !== undefined || process.env.INFERENCE_UPSTREAM_TIMEOUT_MS !== undefined
    ? parsed.GATEWAY_UPSTREAM_TIMEOUT_MS : 120000,
  streamIdleMs: parsed.INFERENCE_STREAM_IDLE_MS,
  corsOrigins: splitCsv(parsed.CORS_ORIGINS),
  databaseUrl: parsed.DATABASE_URL,
  dbMode: (parsed.DB_MODE ??
    (parsed.DATABASE_URL ? "mysql" : "planetscale")) as DenDbMode,
  planetscale,
  dbEncryptionKey: parsed.DEN_DB_ENCRYPTION_KEY,
  proxyBaseUrl: optionalString(parsed.GATEWAY_PROXY_BASE_URL),
  openRouterUpstreamUrl: normalizeUrl(
    parsed.OPENROUTER_UPSTREAM_URL ?? "https://openrouter.ai/api/v1",
  ),
  openAiRealtimeApiKey: optionalString(parsed.OPENAI_REALTIME_API_KEY) ?? optionalString(parsed.OPENAI_API_KEY),
  adminToken: optionalString(parsed.GATEWAY_ADMIN_TOKEN),
  webhookSecret: optionalString(parsed.GATEWAY_WEBHOOK_SECRET),
  creditsPerDollar: parseCreditsPerDollar(parsed.GATEWAY_CREDITS_PER_DOLLAR),
};
