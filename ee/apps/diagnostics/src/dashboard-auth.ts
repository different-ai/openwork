import { createHmac, timingSafeEqual } from "node:crypto"
import type { diagnosticsConfig } from "./config"

export const DASHBOARD_SESSION_COOKIE = "openwork_diagnostics_admin"
export const DASHBOARD_SESSION_LIFETIME_SECONDS = 60 * 60

type DashboardAuthConfig = Pick<ReturnType<typeof diagnosticsConfig>, "adminPassword" | "adminUsername" | "signingSecret">

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function dashboardSigningKey(config: DashboardAuthConfig): Buffer {
  return createHmac("sha256", config.signingSecret)
    .update("openwork-diagnostics-dashboard-v1\0")
    .update(config.adminUsername)
    .update("\0")
    .update(config.adminPassword)
    .digest()
}

function signature(payload: string, config: DashboardAuthConfig): string {
  return createHmac("sha256", dashboardSigningKey(config)).update(payload).digest("base64url")
}

export function dashboardCredentialsAuthorized(
  username: string,
  password: string,
  config: DashboardAuthConfig,
): boolean {
  const usernameMatches = constantTimeEqual(username, config.adminUsername)
  const passwordMatches = constantTimeEqual(password, config.adminPassword)
  return usernameMatches && passwordMatches
}

export function createDashboardSession(config: DashboardAuthConfig, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    exp: now + DASHBOARD_SESSION_LIFETIME_SECONDS * 1000,
    kind: "dashboard",
    version: 1,
  }), "utf8").toString("base64url")
  return `${payload}.${signature(payload, config)}`
}

export function verifyDashboardSession(token: string, config: DashboardAuthConfig, now = Date.now()): boolean {
  const [payload, suppliedSignature, extra] = token.split(".")
  if (!payload || !suppliedSignature || extra !== undefined) return false
  const expected = Buffer.from(signature(payload, config))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && "version" in value && value.version === 1
      && "kind" in value && value.kind === "dashboard"
      && "exp" in value && typeof value.exp === "number" && value.exp >= now
  } catch {
    return false
  }
}
