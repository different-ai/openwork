import { isPermissionSensitive, type PermissionKey } from "@openwork/types/den/permissions"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError, type AgentErrorEnvelope } from "../agent-error-envelope.js"
import {
  checkFreshPrivilegedSession,
  PRIVILEGED_SESSION_MAX_AGE_MS,
  type FreshPrivilegedSessionRequiredResponse,
  type PrivilegedSessionInput,
} from "../privileged-session.js"
import { permissionDeniedMessage, type MemberPermissions } from "./effective.js"

/**
 * 403 body for a missing permission. Keeps the `error: "forbidden"` and
 * `requires_admin` envelope fields older clients read from role checks, and
 * adds `requiredPermission`.
 */
export type PermissionDeniedResponse = AgentErrorEnvelope & {
  error: "forbidden"
  requiredPermission: PermissionKey
}

export type PermissionCheckFailure =
  | PermissionDeniedResponse
  | FreshPrivilegedSessionRequiredResponse
  | { error: "organization_not_found" }

export type PermissionCheckResult = { ok: true } | { ok: false; response: PermissionCheckFailure }

export type PermissionCheckOptions = {
  /**
   * The recent sign-in window for a sensitive key: the organization's
   * (organizationPrivilegedSessionMaxAgeMs), null when it turned the check
   * off. Defaults to PRIVILEGED_SESSION_MAX_AGE_MS.
   */
  maxAgeMs?: number | null
}

export function permissionDeniedResponse(key: PermissionKey): PermissionDeniedResponse {
  return {
    error: "forbidden",
    ...requiresAdminError(permissionDeniedMessage(key)),
    requiredPermission: key,
  }
}

/**
 * Headers to send with a failure: the RFC 6750 insufficient-scope challenge on
 * a missing permission, as orgRoleRoute does. Use as `c.json(response, status, permissionFailureHeaders(response))`.
 */
export function permissionFailureHeaders(response: PermissionCheckFailure): Record<string, string> {
  return response.error === "forbidden" ? { "WWW-Authenticate": INSUFFICIENT_SCOPE_CHALLENGE } : {}
}

/**
 * The one permission check: the key must be held, and a sensitive key also
 * needs a recent sign-in, exactly like ensureOrganizationAdmin /
 * ensureOrganizationSuperAdmin. API keys skip the sign-in check, and MCP
 * principals pass it because their synthesized session is created per request
 * (see checkFreshPrivilegedSession); MCP exposure is limited by src/mcp/policy.ts.
 */
export function checkMemberPermission(
  request: PrivilegedSessionInput,
  permissions: MemberPermissions,
  key: PermissionKey,
  options: PermissionCheckOptions = {},
): PermissionCheckResult {
  if (!permissions.has(key)) return { ok: false, response: permissionDeniedResponse(key) }
  if (!isPermissionSensitive(key)) return { ok: true }
  return checkFreshPrivilegedSession(request, options.maxAgeMs === undefined ? PRIVILEGED_SESSION_MAX_AGE_MS : options.maxAgeMs)
}
