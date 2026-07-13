import type { DiagnosticsProfile } from "./contracts"

function isDiagnosticsProfile(value: string | undefined): value is DiagnosticsProfile {
  return value === "generic" || value === "microsoft" || value === "servicenow"
}

function profile(value: string | undefined): DiagnosticsProfile {
  if (isDiagnosticsProfile(value)) return value
  return "generic"
}

function secureRootUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (url.pathname === "/" || url.pathname === "")
      && !url.search
      && !url.hash
  } catch {
    return false
  }
}

export function diagnosticsRedisConfig(): { source: "kv" | "upstash"; token: string; url: string } | null {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN
  if (upstashUrl && upstashToken) return { source: "upstash", token: upstashToken, url: upstashUrl.replace(/\/$/u, "") }
  const kvUrl = process.env.KV_REST_API_URL
  const kvToken = process.env.KV_REST_API_TOKEN
  if (kvUrl && kvToken) return { source: "kv", token: kvToken, url: kvUrl.replace(/\/$/u, "") }
  return null
}

function publicOrigin(value: string | undefined, hosted: boolean): string {
  const configured = value ?? (hosted ? "" : "http://localhost:3010")
  try {
    const url = new URL(configured)
    if ((url.protocol !== "https:" && (hosted || url.protocol !== "http:"))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return ""
    return url.origin
  } catch {
    return ""
  }
}

function configuredPublicOrigin(hosted: boolean): string | undefined {
  if (hosted && process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`
  }
  return process.env.NEXT_PUBLIC_DIAGNOSTICS_ORIGIN
}

export function diagnosticsConfig() {
  const hosted = Boolean(process.env.VERCEL)
  return {
    adminPassword: process.env.DIAGNOSTICS_ADMIN_PASSWORD ?? (hosted ? "" : "OpenWorkDiagnosticsLocal!"),
    adminUsername: process.env.DIAGNOSTICS_ADMIN_USERNAME ?? "diagnostics-admin",
    bearerToken: process.env.DIAGNOSTICS_MCP_BEARER_TOKEN ?? (hosted ? "" : "OpenWorkDiagnosticsToken!"),
    profile: profile(process.env.DIAGNOSTICS_PROFILE),
    publicOrigin: publicOrigin(configuredPublicOrigin(hosted), hosted),
    signingSecret: process.env.DIAGNOSTICS_SIGNING_SECRET ?? (hosted ? "" : "local-diagnostics-signing-secret-change-me"),
  }
}

export function validateProductionConfig(): readonly string[] {
  if (!process.env.VERCEL) return []
  const config = diagnosticsConfig()
  const missing: string[] = []
  const configuredProfile = process.env.DIAGNOSTICS_PROFILE
  const redis = diagnosticsRedisConfig()
  if (!config.adminUsername.trim()) missing.push("DIAGNOSTICS_ADMIN_USERNAME")
  if (config.adminPassword.length < 24) missing.push("DIAGNOSTICS_ADMIN_PASSWORD")
  if (config.signingSecret.length < 32) missing.push("DIAGNOSTICS_SIGNING_SECRET")
  if (config.bearerToken.length < 24) missing.push("DIAGNOSTICS_MCP_BEARER_TOKEN")
  if (!isDiagnosticsProfile(configuredProfile)) missing.push("DIAGNOSTICS_PROFILE")
  if (!config.publicOrigin.startsWith("https://")) {
    missing.push(process.env.VERCEL_ENV === "preview" ? "VERCEL_URL" : "NEXT_PUBLIC_DIAGNOSTICS_ORIGIN")
  }
  if (!redis) {
    missing.push("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN")
  } else if (!secureRootUrl(redis.url)) {
    missing.push(redis.source === "upstash" ? "UPSTASH_REDIS_REST_URL" : "KV_REST_API_URL")
  }
  if (new Set([config.adminPassword, config.signingSecret, config.bearerToken]).size !== 3) {
    missing.push("DIAGNOSTICS_SECRETS_MUST_BE_DISTINCT")
  }
  return [...new Set(missing)]
}
