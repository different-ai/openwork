import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { desktopConfigSchema } from "@openwork/types/den/desktop-policies"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { authenticatedRoute, jsonValidator, orgMemberRoute, type OrganizationContextVariables, type UserOrganizationsContext } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { resolveUserOrganizations, setSessionActiveOrganization } from "../../orgs.js"
import type { AuthContextVariables } from "../../session.js"
import { calculateDesktopPolicyForOrgMember } from "../../desktop-policies.js"

const meResponseSchema = z.object({
  user: z.object({}).passthrough(),
  session: z.object({}).passthrough(),
}).meta({ ref: "CurrentUserResponse" })

const meOrganizationsResponseSchema = z.object({
  orgs: z.array(z.object({
    id: denTypeIdSchema("organization"),
    isActive: z.boolean(),
  }).passthrough()),
  activeOrgId: denTypeIdSchema("organization").nullable(),
  activeOrgSlug: z.string().nullable(),
}).meta({ ref: "CurrentUserOrganizationsResponse" })

const meDesktopConfigResponseSchema = desktopConfigSchema.meta({
  ref: "CurrentUserDesktopConfigResponse",
})

const setActiveOrganizationSchema = z.object({
  organizationId: denTypeIdSchema("organization").optional(),
  organizationSlug: z.string().trim().min(1).max(255).optional(),
}).refine((value) => value.organizationId !== undefined || value.organizationSlug !== undefined, {
  message: "Provide an organization id or slug.",
})

const activeOrganizationResponseSchema = z.object({
  activeOrgId: denTypeIdSchema("organization"),
  activeOrgSlug: z.string().nullable(),
}).meta({ ref: "ActiveOrganizationResponse" })

function normalizeAuthProvider(providerId: string) {
  const normalized = providerId.trim().toLowerCase()
  if (normalized === "credential" || normalized === "email-password") {
    return "email"
  }
  if (normalized.startsWith("openwork-sso-")) {
    return "sso"
  }
  if (normalized.startsWith("openwork-scim-")) {
    return "scim"
  }
  return normalized || "unknown"
}

export function registerMeRoutes<T extends { Variables: AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  app.get(
    "/v1/me",
    describeRoute({
      tags: ["Users"],
      summary: "Get current user",
      description: "Returns the currently authenticated user and active session details for the caller.",
      responses: {
        200: jsonResponse("Current user and session returned successfully.", meResponseSchema),
        401: jsonResponse("The caller must be signed in to read profile data.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    async (c) => {
    const user = c.get("user")
    if (!user) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const accounts = await db
      .select({ providerId: AuthAccountTable.providerId })
      .from(AuthAccountTable)
      .where(eq(AuthAccountTable.userId, normalizeDenTypeId("user", user.id)))

    const authProviders = [...new Set(accounts.map((account) => normalizeAuthProvider(account.providerId)))].sort()

    return c.json({
      user: {
        ...user,
        authProviders,
      },
      session: c.get("session"),
    })
    },
  )

  app.get(
    "/v1/me/orgs",
    describeRoute({
      tags: ["Users"],
      summary: "List current user's organizations",
      description: "Lists the organizations visible to the current user and marks which organization is currently active.",
      responses: {
        200: jsonResponse("Current user organizations returned successfully.", meOrganizationsResponseSchema),
      },
    }),
    orgMemberRoute({ useUserOrganizations: true }),
    (c) => {
    const orgs = (c.get("userOrganizations") ?? []) as NonNullable<UserOrganizationsContext["userOrganizations"]>

    return c.json({
      orgs: orgs.map((org) => ({
        ...org,
        isActive: org.id === c.get("activeOrganizationId"),
      })),
      activeOrgId: c.get("activeOrganizationId") ?? null,
      activeOrgSlug: c.get("activeOrganizationSlug") ?? null,
    })
    },
  )

  app.post(
    "/v1/me/active-organization",
    describeRoute({
      tags: ["Users"],
      hide: true,
      summary: "Set active organization for current session",
      description: "Updates the current database-backed session's active organization. This is used by desktop bearer-token sessions that cannot call Better Auth's cookie-backed organization endpoint.",
      responses: {
        200: jsonResponse("Active organization updated successfully.", activeOrganizationResponseSchema),
        400: jsonResponse("The active organization request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update active organization.", unauthorizedSchema),
        403: jsonResponse("The caller cannot switch this kind of session.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    jsonValidator(setActiveOrganizationSchema),
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      const input = c.req.valid("json")

      if (c.get("apiKey") || !session?.id) {
        return c.json({ error: "forbidden", message: "Active organization can only be updated for a user session." }, 403)
      }

      const requestedOrgId = input.organizationId ?? null
      const resolved = await resolveUserOrganizations({
        activeOrganizationId: requestedOrgId,
        userId: normalizeDenTypeId("user", user.id),
      })
      const activeOrg = requestedOrgId
        ? resolved.orgs.find((org) => org.id === requestedOrgId) ?? null
        : resolved.orgs.find((org) => org.slug === input.organizationSlug) ?? null
      if (!activeOrg) {
        return c.json({ error: "forbidden", message: "You do not have access to this organization." }, 403)
      }

      const sessionId = normalizeDenTypeId("session", session.id)
      await setSessionActiveOrganization(sessionId, activeOrg.id)
      c.set("session", { ...session, activeOrganizationId: activeOrg.id })

      return c.json({ activeOrgId: activeOrg.id, activeOrgSlug: activeOrg.slug })
    },
  )

  app.get(
    "/v1/me/desktop-config",
    describeRoute({
      tags: ["Users"],
      summary: "Get current user's desktop config",
      description: "Returns the authenticated desktop app restrictions for the caller's active organization.",
      responses: {
        200: jsonResponse("Current user desktop config returned successfully.", meDesktopConfigResponseSchema),
        401: jsonResponse("The caller must be signed in to read desktop config.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const organization = c.get("organizationContext").organization
      const currentMember = c.get("organizationContext").currentMember
      const metadata = normalizeOrganizationMetadata(organization.metadata).metadata
      const desktopPolicy = await calculateDesktopPolicyForOrgMember({
        organizationId: organization.id,
        orgMemberId: currentMember.id,
      })

      return c.json({
        ...desktopPolicy,
        ...(Array.isArray(metadata.allowedDesktopVersions)
          ? { allowedDesktopVersions: metadata.allowedDesktopVersions }
          : {}),
      })
    },
  )
}
