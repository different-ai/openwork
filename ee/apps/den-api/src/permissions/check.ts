import { isPermissionSensitive, type PermissionKey } from "@openwork/types/den/permissions"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError, type AgentErrorEnvelope } from "../agent-error-envelope.js"
import {
  checkFreshPrivilegedSession,
  PRIVILEGED_SESSION_MAX_AGE_MS,
  type FreshPrivilegedSessionRequiredResponse,
  type PrivilegedSessionInput,
} from "../privileged-session.js"
import { permissionDeniedMessage, type MemberPermissions } from "./effective.js"

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
  maxAgeMs?: number | null
}

export function permissionDeniedResponse(key: PermissionKey): PermissionDeniedResponse {
  return {
    error: "forbidden",
    ...requiresAdminError(permissionDeniedMessage(key)),
    requiredPermission: key,
  }
}

export function permissionFailureHeaders(response: PermissionCheckFailure): Record<string, string> {
  return response.error === "forbidden" ? { "WWW-Authenticate": INSUFFICIENT_SCOPE_CHALLENGE } : {}
}

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
