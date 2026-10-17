import type { ComputerProviderConfig } from "@openwork-ee/headless-computer"
import { dirname, join } from "node:path"
import { z } from "zod"
import { parseDsn, type ErrorReportingConfig } from "./error-reporting.js"

/** Allow https anywhere, and plain http only for loopback development hosts. */
function isSafeUrl(value: string) {
  const url = new URL(value)
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
}
const safeUrl = z
  .url()
  .refine(isSafeUrl, "must be https (http is allowed only for loopback hosts)")
  .transform((value) => value.replace(/\/+$/, ""))

const csv = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []))

/** Empty means unset, as an env file's `NAME=` line usually intends. */
const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)

const configSchema = z.object({
  HEADLESS_API_TOKEN: z.string().min(32, "HEADLESS_API_TOKEN must be at least 32 characters"),
  HEADLESS_PORT: z.coerce.number().int().min(1).max(65_535).default(8795),
  HEADLESS_DB_PATH: z.string().min(1).default("./data/headless.sqlite"),
  HEADLESS_MODEL_PROTOCOL: z.enum(["anthropic", "openai"]),
  HEADLESS_MODEL_BASE_URL: safeUrl,
  HEADLESS_MODEL: z.string().min(1),
  HEADLESS_MODEL_API_KEY: z.string().min(1).optional(),
  HEADLESS_MCP_URL: safeUrl.optional(),
  HEADLESS_MCP_TOOL_ALLOWLIST: csv,
  HEADLESS_MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(1_000).default(32),
  /** Model calls per turn; 0 means no limit, so a long task is bounded by the turn timeout and Stop instead. */
  HEADLESS_MAX_STEPS: z.coerce.number().int().min(0).default(0),
  HEADLESS_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(128_000).default(8192),
  /** 0 means no limit: every model and tool call has its own timeout, so a turn cannot hang. */
  HEADLESS_TURN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .refine((value) => value === 0 || value >= 10_000, "must be 0 (no limit) or at least 10000"),
  /**
   * A running turn pauses itself between steps this often so the caller can resume it with fresh credentials.
   * Den's run-scoped MCP tokens live at most 60 minutes.
   */
  HEADLESS_CREDENTIAL_REFRESH_MS: z.coerce.number().int().min(60_000).default(50 * 60_000),
  HEADLESS_CONTEXT_CHAR_BUDGET: z.coerce.number().int().min(10_000).default(400_000),
  HEADLESS_SYSTEM_PROMPT: z.string().optional(),
  /**
   * Saved files (uploads and files the agent hands back): off, a folder on disk, or any S3-compatible bucket. Only
   * conversations created with `files: true` use them.
   */
  HEADLESS_FILES: z.enum(["off", "disk", "s3"]).default("off"),
  /** For `disk`. Defaults to a `files` folder next to the database, so both live on the same persistent volume. */
  HEADLESS_FILES_DIR: z.string().min(1).optional(),
  /** The largest single file a conversation may keep (uploads, saved files, computer outputs). */
  HEADLESS_FILES_MAX_BYTES: z.coerce.number().int().min(1024).default(100 * 1024 * 1024),
  /** How much one conversation may keep in total. */
  HEADLESS_FILES_MAX_SESSION_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024 * 1024),
  HEADLESS_S3_ENDPOINT: safeUrl.optional(),
  HEADLESS_S3_REGION: z.string().min(1).default("auto"),
  HEADLESS_S3_BUCKET: z.string().min(1).optional(),
  HEADLESS_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  HEADLESS_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  HEADLESS_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  /** A Linux computer per conversation (bash and look tools): off, or a Freestyle VM. */
  HEADLESS_COMPUTER: z.enum(["off", "freestyle", "daytona"]).default("off"),
  DAYTONA_API_KEY: z.string().min(1).optional(),
  DAYTONA_API_URL: safeUrl.default("https://app.daytona.io/api"),
  DAYTONA_TARGET: z.string().min(1).optional(),
  HEADLESS_COMPUTER_CLASS: z.enum(["container", "linux-vm"]).default("container"),
  HEADLESS_COMPUTER_DESKTOP: z.enum(["true", "false"]).default("false"),
  HEADLESS_COMPUTER_SCOPE: z.string().min(1).optional(),
  FREESTYLE_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  /** Snapshot id or slug to boot from; defaults to the one built from @openwork-ee/headless-computer's image. */
  HEADLESS_COMPUTER_SNAPSHOT: z.string().min(1).optional(),
  HEADLESS_COMPUTER_PAUSE_SECONDS: z.coerce.number().int().min(10).default(300),
  HEADLESS_COMPUTER_KEEP_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /**
   * Optional error reports to Sentry (see error-reporting.ts). Unset, nothing is sent anywhere: self-hosted runners
   * ship without one. The release defaults to `headless-runner@<HEADLESS_RUNNER_VERSION>`.
   */
  HEADLESS_SENTRY_DSN: optionalText.refine((value) => value === undefined || parseDsn(value) !== null, "must be a Sentry DSN (https://<key>@<host>/<project>)"),
  HEADLESS_SENTRY_ENVIRONMENT: optionalText,
  HEADLESS_SENTRY_RELEASE: optionalText,
  /** Set by the runner image at build time; tagged on error reports. */
  HEADLESS_RUNNER_VERSION: optionalText,
})

export type Config = {
  apiToken: string
  port: number
  dbPath: string
  model: {
    protocol: "anthropic" | "openai"
    baseUrl: string
    model: string
    defaultApiKey?: string
    maxOutputTokens: number
  }
  mcp?: { url: string; toolAllowlist: string[] }
  limits: {
    maxConcurrentTurns: number
    maxSteps: number
    turnTimeoutMs: number
    credentialRefreshMs: number
    contextCharBudget: number
  }
  systemPrompt?: string
  files:
    | { kind: "off" }
    | { kind: "disk"; directory: string }
    | { kind: "s3"; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }
  fileLimits: { maxFileBytes: number; maxSessionBytes: number }
  computer?: ComputerProviderConfig & { scope?: string; idlePauseMs: number; keepDays: number }
  /** Where error reports go; unset (no DSN) sends none. */
  errorReporting?: ErrorReportingConfig
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    throw new Error(`Invalid headless-runner configuration:\n${issues.join("\n")}`)
  }
  const value = parsed.data
  return {
    apiToken: value.HEADLESS_API_TOKEN,
    port: value.HEADLESS_PORT,
    dbPath: value.HEADLESS_DB_PATH,
    model: {
      protocol: value.HEADLESS_MODEL_PROTOCOL,
      baseUrl: value.HEADLESS_MODEL_BASE_URL,
      model: value.HEADLESS_MODEL,
      defaultApiKey: value.HEADLESS_MODEL_API_KEY,
      maxOutputTokens: value.HEADLESS_MAX_OUTPUT_TOKENS,
    },
    mcp: value.HEADLESS_MCP_URL
      ? { url: value.HEADLESS_MCP_URL, toolAllowlist: value.HEADLESS_MCP_TOOL_ALLOWLIST }
      : undefined,
    limits: {
      maxConcurrentTurns: value.HEADLESS_MAX_CONCURRENT_TURNS,
      maxSteps: value.HEADLESS_MAX_STEPS === 0 ? Number.POSITIVE_INFINITY : value.HEADLESS_MAX_STEPS,
      turnTimeoutMs: value.HEADLESS_TURN_TIMEOUT_MS === 0 ? Number.POSITIVE_INFINITY : value.HEADLESS_TURN_TIMEOUT_MS,
      credentialRefreshMs: value.HEADLESS_CREDENTIAL_REFRESH_MS,
      contextCharBudget: value.HEADLESS_CONTEXT_CHAR_BUDGET,
    },
    systemPrompt: value.HEADLESS_SYSTEM_PROMPT,
    files: filesConfig(value),
    fileLimits: { maxFileBytes: value.HEADLESS_FILES_MAX_BYTES, maxSessionBytes: value.HEADLESS_FILES_MAX_SESSION_BYTES },
    computer: computerConfig(value),
    errorReporting: errorReportingConfig(value),
  }
}

function errorReportingConfig(value: z.infer<typeof configSchema>): Config["errorReporting"] {
  if (!value.HEADLESS_SENTRY_DSN) return undefined
  const version = value.HEADLESS_RUNNER_VERSION && value.HEADLESS_RUNNER_VERSION !== "dev" ? value.HEADLESS_RUNNER_VERSION : undefined
  return {
    dsn: value.HEADLESS_SENTRY_DSN,
    environment: value.HEADLESS_SENTRY_ENVIRONMENT,
    release: value.HEADLESS_SENTRY_RELEASE ?? (version ? `headless-runner@${version}` : undefined),
    runnerVersion: value.HEADLESS_RUNNER_VERSION,
  }
}

function computerConfig(value: z.infer<typeof configSchema>): Config["computer"] {
  if (value.HEADLESS_COMPUTER === "off") return undefined
  const apiKey = value.HEADLESS_COMPUTER === "daytona" ? value.DAYTONA_API_KEY : value.FREESTYLE_API_KEY
  if (!apiKey) throw new Error(`Invalid headless-runner configuration: HEADLESS_COMPUTER=${value.HEADLESS_COMPUTER} needs ${value.HEADLESS_COMPUTER === "daytona" ? "DAYTONA_API_KEY" : "FREESTYLE_API_KEY"}`)
  if (value.HEADLESS_COMPUTER === "daytona" && !value.HEADLESS_COMPUTER_SNAPSHOT) throw new Error("Daytona computers need HEADLESS_COMPUTER_SNAPSHOT (snapshot:build:daytona)")
  if (value.HEADLESS_COMPUTER === "daytona" && value.HEADLESS_COMPUTER_DESKTOP === "true" && value.HEADLESS_COMPUTER_CLASS !== "linux-vm") throw new Error("Daytona desktop computers require HEADLESS_COMPUTER_CLASS=linux-vm for memory-preserving pause and snapshots")
  return {
    kind: value.HEADLESS_COMPUTER,
    apiKey,
    apiUrl: value.DAYTONA_API_URL,
    target: value.DAYTONA_TARGET,
    sandboxClass: value.HEADLESS_COMPUTER_CLASS,
    desktop: value.HEADLESS_COMPUTER_DESKTOP === "true",
    scope: value.HEADLESS_COMPUTER_SCOPE,
    snapshot: value.HEADLESS_COMPUTER_SNAPSHOT,
    idlePauseMs: value.HEADLESS_COMPUTER_PAUSE_SECONDS * 1000,
    keepDays: value.HEADLESS_COMPUTER_KEEP_DAYS,
  }
}

function filesConfig(value: z.infer<typeof configSchema>): Config["files"] {
  if (value.HEADLESS_FILES === "disk") return { kind: "disk", directory: value.HEADLESS_FILES_DIR ?? join(dirname(value.HEADLESS_DB_PATH), "files") }
  if (value.HEADLESS_FILES !== "s3") return { kind: "off" }
  const { HEADLESS_S3_ENDPOINT: endpoint, HEADLESS_S3_BUCKET: bucket, HEADLESS_S3_ACCESS_KEY_ID: accessKeyId, HEADLESS_S3_SECRET_ACCESS_KEY: secretAccessKey } = value
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Invalid headless-runner configuration:\nHEADLESS_FILES=s3 needs HEADLESS_S3_ENDPOINT, HEADLESS_S3_BUCKET, HEADLESS_S3_ACCESS_KEY_ID and HEADLESS_S3_SECRET_ACCESS_KEY")
  }
  return {
    kind: "s3",
    endpoint,
    region: value.HEADLESS_S3_REGION,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: value.HEADLESS_S3_FORCE_PATH_STYLE === "true",
  }
}
