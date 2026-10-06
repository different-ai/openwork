import "./load-env.js"
import { z } from "zod"

const EnvSchema = z.object({
  PORT: z.string().optional(),
  DEN_API_BASE: z.string().optional(),
  DEN_GATEWAY_KEY: z.string().optional(),
  DEN_GATEWAY_VERSION: z.string().optional(),
  RENDER_GIT_COMMIT: z.string().optional(),
  DEN_GATEWAY_WEB_ROOT: z.string().optional(),
  DEN_GATEWAY_DEN_WEB_URL: z.string().optional(),
  DEN_GATEWAY_RESOLVE_TTL_MS: z.string().optional(),
  DEN_GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS: z.string().optional(),
  DEN_GATEWAY_LOG_REQUESTS: z.string().optional(),
})

const parsed = EnvSchema.parse(process.env)

function optionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

// GH Actions builds pass DEN_GATEWAY_VERSION; Render repo builds rely on RENDER_GIT_COMMIT.
export function resolveGatewayBuildVersion(input: { denGatewayVersion?: string; renderGitCommit?: string }): string | undefined {
  return optionalString(input.denGatewayVersion) ?? optionalString(input.renderGitCommit)
}

function parsePort(value: string | undefined) {
  const port = Number(value ?? "8788")
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535")
  }
  return port
}

function parsePositiveInteger(envName: string, value: string | undefined, fallback: number) {
  const parsedValue = Number(value ?? String(fallback))
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${envName} must be a positive integer`)
  }
  return parsedValue
}

function normalizeHttpBaseUrl(envName: string, value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${envName} must be an absolute http or https URL`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${envName} must be an absolute http or https URL`)
  }

  return value.replace(/\/+$/, "")
}

function optionalHttpBaseUrl(envName: string, value: string | undefined) {
  const trimmed = optionalString(value)
  return trimmed ? normalizeHttpBaseUrl(envName, trimmed) : undefined
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return fallback
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false
  }
  throw new Error("DEN_GATEWAY_LOG_REQUESTS must be true or false")
}

export const env = {
  port: parsePort(parsed.PORT),
  denApiBase: normalizeHttpBaseUrl("DEN_API_BASE", optionalString(parsed.DEN_API_BASE) ?? "http://127.0.0.1:8790"),
  gatewayKey: optionalString(parsed.DEN_GATEWAY_KEY),
  buildVersion: resolveGatewayBuildVersion({
    denGatewayVersion: parsed.DEN_GATEWAY_VERSION,
    renderGitCommit: parsed.RENDER_GIT_COMMIT,
  }),
  webRoot: optionalString(parsed.DEN_GATEWAY_WEB_ROOT),
  // Self-hosted: the Den web origin the served app signs in with. Unset keeps
  // the app's build-time default (hosted OpenWork Cloud).
  denWebUrl: optionalHttpBaseUrl("DEN_GATEWAY_DEN_WEB_URL", parsed.DEN_GATEWAY_DEN_WEB_URL),
  resolveTtlMs: parsePositiveInteger("DEN_GATEWAY_RESOLVE_TTL_MS", parsed.DEN_GATEWAY_RESOLVE_TTL_MS, 15_000),
  upstreamConnectTimeoutMs: parsePositiveInteger(
    "DEN_GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS",
    parsed.DEN_GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS,
    3_000,
  ),
  logRequests: parseBoolean(parsed.DEN_GATEWAY_LOG_REQUESTS, true),
}
