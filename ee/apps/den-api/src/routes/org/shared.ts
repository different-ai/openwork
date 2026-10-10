import { createDenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { customAlphabet } from "nanoid"
import { z } from "zod"
import type { MemberPermissionsVariables, MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "../../middleware/index.js"
import { memberPermissionsForOrganizationContext } from "../../middleware/member-permissions.js"
import { checkMemberPermission, type PermissionCheckOptions, type PermissionCheckResult } from "../../permissions/check.js"
import type { MemberPermissions } from "../../permissions/effective.js"
import { env } from "../../env.js"
import { denTypeIdSchema } from "../../openapi.js"
import {
  normalizeOrganizationRoleName,
  splitOrganizationRoles,
} from "../../organization-role-hierarchy.js"
import type { AuthContextVariables } from "../../session.js"
import { ensureFreshPrivilegedSession } from "../../privileged-session.js"

export type OrgRouteVariables =
  & AuthContextVariables
  & Partial<UserOrganizationsContext>
  & Partial<OrganizationContextVariables>
  & Partial<MemberTeamsContext>
  & Partial<MemberPermissionsVariables>

export {
  CONNECTIONS_READ_SESSION_MAX_AGE_MS,
  PRIVILEGED_SESSION_MAX_AGE_MS,
  WORKSPACE_REAUTH_SECURITY_MESSAGE,
  getFreshPrivilegedSessionRequiredResponse,
  hasFreshPrivilegedSession,
  type FreshPrivilegedSessionRequiredResponse,
} from "../../privileged-session.js"

type PrivilegedOrgRouteContext = {
  get: <K extends "apiKey" | "organizationContext" | "session">(key: K) => OrgRouteVariables[K]
}

export {
  checkMemberPermission,
  permissionDeniedResponse,
  permissionFailureHeaders,
  type PermissionCheckFailure,
  type PermissionCheckOptions,
  type PermissionCheckResult,
  type PermissionDeniedResponse,
} from "../../permissions/check.js"
export { permissionDeniedMessage } from "../../permissions/effective.js"

type PermissionRouteVariables = Pick<AuthContextVariables, "apiKey" | "session"> & Partial<OrganizationContextVariables>

/** Any Hono context for an organization route (orgMemberRoute, orgRoleRoute, orgPermissionRoute, cloudTransportRoute). */
export type PermissionRouteContext = {
  get: <K extends keyof PermissionRouteVariables>(key: K) => PermissionRouteVariables[K]
}

/**
 * The caller's effective permissions for this request, resolved at most once
 * per request (shared with orgPermissionRoute and resolveMemberPermissionsMiddleware).
 * Null without an organization context.
 */
export async function memberPermissionsForRequest(c: PermissionRouteContext): Promise<MemberPermissions | null> {
  const payload = c.get("organizationContext")
  return payload ? memberPermissionsForOrganizationContext(payload) : null
}

/**
 * In-handler permission check for conditional cases (depends on the body or
 * the target row). Same result shape as the ensure* helpers, so call sites stay
 *   const permission = await requirePermission(c, "teams.manage_admin")
 *   if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))
 * Includes the recent sign-in check for sensitive keys.
 */
export async function requirePermission(
  c: PermissionRouteContext,
  key: PermissionKey,
  options: PermissionCheckOptions = {},
): Promise<PermissionCheckResult> {
  const permissions = await memberPermissionsForRequest(c)
  if (!permissions) return { ok: false, response: { error: "organization_not_found" } }
  return checkMemberPermission({ apiKey: c.get("apiKey"), session: c.get("session") }, permissions, key, options)
}

/** Whether the caller holds `key`. No recent sign-in check: use for visibility and filtering, not for sensitive writes. */
export async function hasPermission(c: PermissionRouteContext, key: PermissionKey): Promise<boolean> {
  const permissions = await memberPermissionsForRequest(c)
  return permissions?.has(key) ?? false
}

export function orgAccessFailureStatus(response: { error: string }) {
  return response.error === "organization_not_found" ? 404 : 403
}

export function idParamSchema<K extends string>(key: K, typeName?: DenTypeIdName) {
  if (!typeName) {
    return z.object({
      [key]: z.string().trim().min(1).max(255),
    } as unknown as Record<K, z.ZodString>)
  }

  return z.object({
    [key]: denTypeIdSchema(typeName),
  } as unknown as Record<K, z.ZodType<string, string>>)
}

export function splitRoles(value: string) {
  return splitOrganizationRoles(value)
}

export function normalizeRoleName(value: string) {
  return normalizeOrganizationRoleName(value)
}

export function getInvitationOrigin() {
  return env.betterAuthTrustedOrigins.find((origin) => origin !== "*") ?? env.betterAuthUrl
}

const createNanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 21)

export function buildInvitationLink(inviteToken: string) {
  return new URL(`/join-org?invite=${encodeURIComponent(inviteToken)}`, getInvitationOrigin()).toString()
}

export function ensureOwner(c: PrivilegedOrgRouteContext) {
  const payload = c.get("organizationContext")
  if (!payload?.currentMember.isOwner) {
    return {
      ok: false as const,
      response: {
        error: "forbidden",
        message: "Only workspace owners can transfer ownership.",
      },
    }
  }

  return ensureFreshPrivilegedSession(c)
}

export function createInvitationId() {
  return createDenTypeId("invitation")
}

export function createInvitationToken() {
  return createNanoid()
}
