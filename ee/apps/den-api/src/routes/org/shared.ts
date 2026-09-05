import { createDenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"
import { customAlphabet } from "nanoid"
import { z } from "zod"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "../../middleware/index.js"
import { env } from "../../env.js"
import { denTypeIdSchema } from "../../openapi.js"
import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  normalizeOrganizationRoleName,
  organizationRoleValueSatisfies,
  splitOrganizationRoles,
} from "../../organization-role-hierarchy.js"
import {
  canManageSecurityConfiguration as canManageOrganizationSecurityConfiguration,
  type SecurityConfigurationPermissionPayload,
} from "../../organization-access.js"
import type { AuthContextVariables } from "../../session.js"

export type OrgRouteVariables =
  & AuthContextVariables
  & Partial<UserOrganizationsContext>
  & Partial<OrganizationContextVariables>
  & Partial<MemberTeamsContext>

export const PRIVILEGED_SESSION_MAX_AGE_MS = 15 * 60 * 1000
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

type PrivilegedOrgRouteContext = {
  get: <K extends "apiKey" | "organizationContext" | "session">(key: K) => OrgRouteVariables[K]
}

type OrganizationAdminRouteContext = {
  get: (key: "organizationContext") => OrgRouteVariables["organizationContext"]
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

function ensureFreshPrivilegedSession(
  c: { get: <K extends "apiKey" | "session">(key: K) => OrgRouteVariables[K] },
  maxAgeMs = PRIVILEGED_SESSION_MAX_AGE_MS,
) {
  if (c.get("apiKey")) {
    return { ok: true as const }
  }

  if (hasFreshPrivilegedSession({ session: c.get("session") }, new Date(), maxAgeMs)) {
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: getFreshPrivilegedSessionRequiredResponse(),
  }
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

export function memberHasRole(value: string, role: string) {
  return organizationRoleValueSatisfies({ roleValue: value, requiredRole: role })
}

export function normalizeRoleName(value: string) {
  return normalizeOrganizationRoleName(value)
}

export function replaceRoleValue(value: string, previousRole: string, nextRole: string | null) {
  const existing = splitRoles(value)
  const remaining = existing.filter((role) => role !== previousRole)

  if (nextRole && !remaining.includes(nextRole)) {
    remaining.push(nextRole)
  }

  return remaining[0] ? remaining.join(",") : "member"
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

/**
 * Checks workspace owner/admin authorization without requiring a recent login.
 * Use this for routine workspace administration; security-sensitive or
 * destructive actions should use ensureOrganizationAdmin instead.
 */
export function ensureOrganizationAdminRole(c: OrganizationAdminRouteContext, message: string) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (organizationRoleValueSatisfies({
    roleValue: payload.currentMember.role,
    requiredRole: ORGANIZATION_ADMIN_ROLE,
    isOwner: payload.currentMember.isOwner,
  })) {
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message,
    },
  }
}

export function ensureOrganizationSuperAdmin(
  c: PrivilegedOrgRouteContext,
  message: string,
  maxAgeMs = PRIVILEGED_SESSION_MAX_AGE_MS,
) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (!organizationRoleValueSatisfies({
    roleValue: payload.currentMember.role,
    requiredRole: ORGANIZATION_SUPER_ADMIN_ROLE,
    isOwner: payload.currentMember.isOwner,
  })) {
    return {
      ok: false as const,
      response: {
        error: "forbidden",
        message,
      },
    }
  }

  return ensureFreshPrivilegedSession(c, maxAgeMs)
}

export function ensureOrganizationAdmin(
  c: PrivilegedOrgRouteContext,
  message: string,
  maxAgeMs = PRIVILEGED_SESSION_MAX_AGE_MS,
) {
  const permission = ensureOrganizationAdminRole(c, message)
  if (!permission.ok) {
    return permission
  }

  return ensureFreshPrivilegedSession(c, maxAgeMs)
}

export function ensureInviteManager(c: PrivilegedOrgRouteContext) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (organizationRoleValueSatisfies({
    roleValue: payload.currentMember.role,
    requiredRole: ORGANIZATION_ADMIN_ROLE,
    isOwner: payload.currentMember.isOwner,
  })) {
    return ensureFreshPrivilegedSession(c)
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can invite members.",
    },
  }
}

export function ensureMemberRemover(c: PrivilegedOrgRouteContext) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (organizationRoleValueSatisfies({
    roleValue: payload.currentMember.role,
    requiredRole: ORGANIZATION_ADMIN_ROLE,
    isOwner: payload.currentMember.isOwner,
  })) {
    return ensureFreshPrivilegedSession(c)
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can remove members.",
    },
  }
}

export function ensureTeamManager(c: PrivilegedOrgRouteContext) {
  return ensureOrganizationAdmin(c, "Only workspace owners and admins can manage teams.")
}

export function ensureApiKeyReader(c: OrganizationAdminRouteContext) {
  return ensureOrganizationAdminRole(c, "Only workspace owners and admins can read API keys.")
}

export function ensureApiKeyManager(c: PrivilegedOrgRouteContext) {
  return ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can manage API keys.")
}

export function canManageSecurityConfiguration(payload: SecurityConfigurationPermissionPayload | null | undefined) {
  return canManageOrganizationSecurityConfiguration(payload)
}

export function canManageApiKeys(payload: SecurityConfigurationPermissionPayload | null | undefined) {
  return canManageSecurityConfiguration(payload)
}

export function canManageIdentityConfiguration(payload: SecurityConfigurationPermissionPayload | null | undefined) {
  return canManageSecurityConfiguration(payload)
}

export function ensureScimReader(c: OrganizationAdminRouteContext) {
  return ensureOrganizationAdminRole(c, "Only workspace owners and admins can read SCIM.")
}

export function ensureScimManager(c: PrivilegedOrgRouteContext) {
  return ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can manage SCIM.")
}

export function ensureSsoReader(c: OrganizationAdminRouteContext) {
  return ensureOrganizationAdminRole(c, "Only workspace owners and admins can read SSO.")
}

export function ensureSsoManager(c: PrivilegedOrgRouteContext) {
  return ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can manage SSO.")
}

export function createInvitationId() {
  return createDenTypeId("invitation")
}

export function createInvitationToken() {
  return createNanoid()
}

export function createRoleId() {
  return createDenTypeId("organizationRole")
}
