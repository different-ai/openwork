import { z } from "zod"

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
  HEADLESS_MAX_STEPS: z.coerce.number().int().min(1).max(200).default(30),
  HEADLESS_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(128_000).default(8192),
  HEADLESS_TURN_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(60 * 60_000),
  HEADLESS_CONTEXT_CHAR_BUDGET: z.coerce.number().int().min(10_000).default(400_000),
  HEADLESS_SYSTEM_PROMPT: z.string().optional(),
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
    contextCharBudget: number
  }
  systemPrompt?: string
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
      maxSteps: value.HEADLESS_MAX_STEPS,
      turnTimeoutMs: value.HEADLESS_TURN_TIMEOUT_MS,
      contextCharBudget: value.HEADLESS_CONTEXT_CHAR_BUDGET,
    },
    systemPrompt: value.HEADLESS_SYSTEM_PROMPT,
  }
}
