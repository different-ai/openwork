import { createDenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"
import { customAlphabet } from "nanoid"
import { z } from "zod"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "../../middleware/index.js"
import { env } from "../../env.js"
import { denTypeIdSchema } from "../../openapi.js"
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

type PrivilegedOrgRouteContext = {
  get: <K extends "organizationContext" | "session">(key: K) => OrgRouteVariables[K]
}

export function hasFreshPrivilegedSession(payload: { session: { createdAt?: Date | string | null } | null | undefined }, now = new Date()) {
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
  return ageMs >= 0 && ageMs <= PRIVILEGED_SESSION_MAX_AGE_MS
}

function ensureFreshPrivilegedSession(c: { get: (key: "session") => OrgRouteVariables["session"] }) {
  if (hasFreshPrivilegedSession({ session: c.get("session") })) {
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "reauth",
      reason: "fresh_auth_required",
      message: "Sign in again before performing this privileged action.",
    },
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
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function memberHasRole(value: string, role: string) {
  return splitRoles(value).includes(role)
}

export function normalizeRoleName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
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
        message: "Only workspace owners can manage members and roles.",
      },
    }
  }

  return ensureFreshPrivilegedSession(c)
}

export function ensureOrganizationAdmin(c: PrivilegedOrgRouteContext, message: string) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")) {
    return ensureFreshPrivilegedSession(c)
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message,
    },
  }
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

  if (payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")) {
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

  if (payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")) {
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

export function ensureApiKeyManager(c: PrivilegedOrgRouteContext) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (canManageApiKeys(payload)) {
    return ensureFreshPrivilegedSession(c)
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners or members with security configuration permission can manage API keys.",
    },
  }
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

export function ensureScimManager(c: PrivilegedOrgRouteContext) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (canManageIdentityConfiguration(payload)) {
    return ensureFreshPrivilegedSession(c)
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners or members with security configuration permission can manage SCIM.",
    },
  }
}

export function ensureSsoManager(c: PrivilegedOrgRouteContext) {
  const payload = c.get("organizationContext")
  if (!payload) {
    return {
      ok: false as const,
      response: {
        error: "organization_not_found",
      },
    }
  }

  if (canManageIdentityConfiguration(payload)) {
    return ensureFreshPrivilegedSession(c)
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners or members with security configuration permission can manage SSO.",
    },
  }
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
