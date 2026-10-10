import type { AuthContextVariables } from "./session.js"

// Step-up window for high-risk workspace actions (security settings, API keys,
// roles, credentials, deletion). Verifying again starts a new session, so this
// counts from the last sign-in or identity check. Routine plugin, marketplace,
// and connector work does not step up; normal role checks still apply.
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

export type PrivilegedSessionContext = {
  get: <K extends "apiKey" | "session">(key: K) => AuthContextVariables[K] | undefined
}

/** What the recent sign-in check reads from a request. */
export type PrivilegedSessionInput = {
  apiKey: AuthContextVariables["apiKey"] | undefined
  session: { createdAt?: Date | string | null } | null | undefined
}

export type FreshPrivilegedSessionResult = { ok: true } | { ok: false; response: FreshPrivilegedSessionRequiredResponse }

/**
 * The recent sign-in check shared by sensitive permissions and the legacy
 * ensureOrganizationAdmin / ensureOrganizationSuperAdmin helpers. API keys
 * skip it; every other caller needs a session created within `maxAgeMs`.
 *
 * MCP principals pass: the internal MCP re-entry (session.ts, session id
 * "mcp_internal") synthesizes a session created at request time, exactly as
 * before Permissions existed, and MCP tools that change members, teams,
 * invitations and organization settings rely on that. Routes that must never
 * be reachable from MCP opt out with `"x-mcp": false` (src/mcp/policy.ts)
 * rather than relying on this check.
 */
export function checkFreshPrivilegedSession(
  input: PrivilegedSessionInput,
  maxAgeMs = PRIVILEGED_SESSION_MAX_AGE_MS,
): FreshPrivilegedSessionResult {
  if (input.apiKey) {
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
  maxAgeMs = PRIVILEGED_SESSION_MAX_AGE_MS,
): FreshPrivilegedSessionResult {
  return checkFreshPrivilegedSession({ apiKey: c.get("apiKey"), session: c.get("session") }, maxAgeMs)
}
