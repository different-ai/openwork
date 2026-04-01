import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "../../middleware/index.js"
import { env } from "../../env.js"
import type { AuthContextVariables } from "../../session.js"

export type OrgRouteVariables =
  & AuthContextVariables
  & Partial<UserOrganizationsContext>
  & Partial<OrganizationContextVariables>
  & Partial<MemberTeamsContext>

export const orgIdParamSchema = z.object({
  orgId: z.string().trim().min(1).max(255),
})

export function idParamSchema<K extends string>(key: K) {
  return z.object({
    [key]: z.string().trim().min(1).max(255),
  } as Record<K, z.ZodString>)
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

export function buildInvitationLink(invitationId: string) {
  return new URL(`/join-org?invite=${encodeURIComponent(invitationId)}`, getInvitationOrigin()).toString()
}

export function parseTemplateJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function ensureOwner(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }) {
  const payload = c.get("organizationContext")
  if (!payload?.currentMember.isOwner) {
    return {
      ok: false as const,
      response: {
        error: "forbidden",
        message: "Only organization owners can manage members and roles.",
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
      message: "Only organization owners and admins can invite members.",
    },
  }
}

export function createInvitationId() {
  return createDenTypeId("invitation")
}

export function createRoleId() {
  return createDenTypeId("organizationRole")
}
