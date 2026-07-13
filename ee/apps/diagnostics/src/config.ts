import type { DiagnosticsProfile } from "./contracts"

function profile(value: string | undefined): DiagnosticsProfile {
  if (value === "microsoft" || value === "servicenow") return value
  return "generic"
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

export function diagnosticsConfig() {
  const hosted = Boolean(process.env.VERCEL)
  return {
    adminPassword: process.env.DIAGNOSTICS_ADMIN_PASSWORD ?? (hosted ? "" : "OpenWorkDiagnosticsLocal!"),
    adminUsername: process.env.DIAGNOSTICS_ADMIN_USERNAME ?? "diagnostics-admin",
    bearerToken: process.env.DIAGNOSTICS_MCP_BEARER_TOKEN ?? (hosted ? "" : "OpenWorkDiagnosticsToken!"),
    profile: profile(process.env.DIAGNOSTICS_PROFILE),
    publicOrigin: publicOrigin(process.env.NEXT_PUBLIC_DIAGNOSTICS_ORIGIN, hosted),
    signingSecret: process.env.DIAGNOSTICS_SIGNING_SECRET ?? (hosted ? "" : "local-diagnostics-signing-secret-change-me"),
  }
}

export function validateProductionConfig(): readonly string[] {
  if (!process.env.VERCEL) return []
  const config = diagnosticsConfig()
  const missing: string[] = []
  if (config.adminPassword.length < 24) missing.push("DIAGNOSTICS_ADMIN_PASSWORD")
  if (config.signingSecret.length < 32) missing.push("DIAGNOSTICS_SIGNING_SECRET")
  if (config.bearerToken.length < 24) missing.push("DIAGNOSTICS_MCP_BEARER_TOKEN")
  if (!config.publicOrigin.startsWith("https://")) missing.push("NEXT_PUBLIC_DIAGNOSTICS_ORIGIN")
  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)) missing.push("UPSTASH_REDIS_REST_URL")
  if (!(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) missing.push("UPSTASH_REDIS_REST_TOKEN")
  return missing
}
