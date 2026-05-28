import { createDenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"
import { customAlphabet } from "nanoid"
import { z } from "zod"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "../../middleware/index.js"
import { env } from "../../env.js"
import { denTypeIdSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

export type OrgRouteVariables =
  & AuthContextVariables
  & Partial<UserOrganizationsContext>
  & Partial<OrganizationContextVariables>
  & Partial<MemberTeamsContext>

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

export function ensureOwner(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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

  return { ok: true as const }
}

export function ensureInviteManager(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can invite members.",
    },
  }
}

export function ensureMemberRemover(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can remove members.",
    },
  }
}

export function ensureTeamManager(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can manage teams.",
    },
  }
}

export function ensureApiKeyManager(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can manage API keys.",
    },
  }
}

export function ensureScimManager(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can manage SCIM.",
    },
  }
}

export function ensureSsoManager(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
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
    return { ok: true as const }
  }

  return {
    ok: false as const,
    response: {
      error: "forbidden",
      message: "Only workspace owners and admins can manage SSO.",
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
