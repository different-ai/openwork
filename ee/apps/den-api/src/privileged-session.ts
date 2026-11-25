import type { OrganizationContext } from "./orgs.js"
import type { AuthContextVariables } from "./session.js"
import { adminReauthMaxAgeMs } from "./session-security-settings.js"

export const PRIVILEGED_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000
export const CONNECTIONS_READ_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const WORKSPACE_REAUTH_SECURITY_MESSAGE = "For security, confirm it's you before changing workspace settings."

export type FreshPrivilegedSessionRequiredResponse = {
  error: "reauth"
  reason: "fresh_auth_required"
  message: string
}

export function getFreshPrivilegedSessionRequiredResponse(): FreshPrivilegedSessionRequiredResponse {
  return {
    error: "reauth",
    reason: "fresh_auth_required",
    message: WORKSPACE_REAUTH_SECURITY_MESSAGE,
  }
}

export function hasFreshPrivilegedSession(
  payload: { session: { createdAt?: Date | string | null } | null | undefined },
  now = new Date(),
  maxAgeMs = PRIVILEGED_SESSION_MAX_AGE_MS,
) {
  const createdAt = payload.session?.createdAt
  const createdAtMs = createdAt instanceof Date
    ? createdAt.getTime()
    : typeof createdAt === "string"
      ? new Date(createdAt).getTime()
      : Number.NaN

  if (!Number.isFinite(createdAtMs)) {
    return false
  }

  const ageMs = now.getTime() - createdAtMs
  return ageMs >= 0 && ageMs <= maxAgeMs
}

type PrivilegedSessionVariables = AuthContextVariables & { organizationContext?: OrganizationContext }

export type PrivilegedSessionContext = {
  get: <K extends "apiKey" | "session" | "organizationContext">(key: K) => PrivilegedSessionVariables[K] | undefined
}

export function organizationPrivilegedSessionMaxAgeMs(organizationContext: Pick<OrganizationContext, "organization"> | null | undefined): number | null {
  if (!organizationContext) return PRIVILEGED_SESSION_MAX_AGE_MS
  return adminReauthMaxAgeMs(organizationContext.organization.metadata)
}



export type PrivilegedSessionInput = {
  apiKey: AuthContextVariables["apiKey"] | undefined
  session: { createdAt?: Date | string | null } | null | undefined
}

export type FreshPrivilegedSessionResult = { ok: true } | { ok: false; response: FreshPrivilegedSessionRequiredResponse }

export function checkFreshPrivilegedSession(
  input: PrivilegedSessionInput,
  maxAgeMs: number | null = PRIVILEGED_SESSION_MAX_AGE_MS,
): FreshPrivilegedSessionResult {
  if (input.apiKey || maxAgeMs === null) {
    return { ok: true }
  }

  if (hasFreshPrivilegedSession({ session: input.session }, new Date(), maxAgeMs)) {
    return { ok: true }
  }

  return {
    ok: false,
    response: getFreshPrivilegedSessionRequiredResponse(),
  }
}

export function ensureFreshPrivilegedSession(
  c: PrivilegedSessionContext,
  minimumMaxAgeMs?: number,
): FreshPrivilegedSessionResult {
  return checkFreshPrivilegedSession({ apiKey: c.get("apiKey"), session: c.get("session") }, requestPrivilegedSessionMaxAgeMs(c, minimumMaxAgeMs))
}

export function requestPrivilegedSessionMaxAgeMs(c: PrivilegedSessionContext, minimumMaxAgeMs?: number): number | null {
  const maxAgeMs = organizationPrivilegedSessionMaxAgeMs(c.get("organizationContext"))
  if (maxAgeMs === null || minimumMaxAgeMs === undefined) return maxAgeMs
  return Math.max(maxAgeMs, minimumMaxAgeMs)
}
