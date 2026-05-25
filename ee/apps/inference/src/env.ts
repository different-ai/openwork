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
    INFERENCE_PROXY_BASE_URL: z.string().optional(),
    OPENROUTER_UPSTREAM_URL: z.string().optional(),
    INFERENCE_ADMIN_TOKEN: z.string().optional(),
    INFERENCE_WEBHOOK_SECRET: z.string().optional(),
    INFERENCE_CREDITS_PER_DOLLAR: z.string().optional(),
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
  adminToken: optionalString(parsed.INFERENCE_ADMIN_TOKEN),
  webhookSecret: optionalString(parsed.INFERENCE_WEBHOOK_SECRET),
  creditsPerDollar: parseCreditsPerDollar(parsed.INFERENCE_CREDITS_PER_DOLLAR),
};
