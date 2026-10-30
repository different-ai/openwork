import { and, eq, gt, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthUserTable, InvitationTable, MemberTable, OrganizationTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { BILLING_PLAN_TIERS } from "@openwork/types/den/billing-plans"
import { desktopConfigSchema } from "@openwork/types/den/desktop-policies"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { OPENWORK_DOWNLOAD_URL } from "../../CONSTS.js"
import { recordProfileUpdated } from "../../audit/domain/account.js"
import { recordSessionOrganizationEntered } from "../../audit/domain/sessions.js"
import { cache } from "../../cache.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { automationAvailabilityFor, headlessAutomationsConfigured } from "../../automations/organization-availability.js"
import { authenticatedRoute, jsonValidator, orgMemberRoute, userSessionRoute, type OrganizationContextVariables, type UserOrganizationsContext } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { resolveUserOrganizations, setSessionActiveOrganization, type UserOrgSummary } from "../../orgs.js"
import type { AuthContextVariables } from "../../session.js"
import { calculateDesktopPolicyForOrgMember } from "../../desktop-policies.js"
import { readAgentPermissionRulesForMember } from "../../agent-permissions.js"
import { desktopConfigDefaultModel } from "../../default-model.js"
import { readPromptsForMember } from "../../prompts.js"
import { memberPromptsSchema } from "@openwork/types/den/prompts"
import { getOrganizationFeatures } from "../../features.js"
import { DenEmailSendError, sendEmail } from "../../utils/email/send-email.js"
import { registerMeActivationRoutes } from "./activation.js"
import { registerMeAgentRoutes } from "./agent.js"

const DOWNLOAD_LINK_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const DOWNLOAD_LINK_RATE_LIMIT_MAX = 5

const meResponseSchema = z.object({
  user: z.object({}).passthrough(),
  session: z.object({}).passthrough(),
}).meta({ ref: "CurrentUserResponse" })

const meOrganizationsResponseSchema = z.object({
  orgs: z.array(z.object({
    id: denTypeIdSchema("organization"),
    planTier: z.enum(BILLING_PLAN_TIERS),
    isSandbox: z.boolean(),
    isActive: z.boolean(),
  }).passthrough()),
  activeOrgId: denTypeIdSchema("organization").nullable(),
  activeOrgSlug: z.string().nullable(),
}).meta({ ref: "CurrentUserOrganizationsResponse" })

const meInvitationsResponseSchema = z.object({
  invitations: z.array(z.object({
    id: denTypeIdSchema("invitation"),
    organization: z.object({ id: denTypeIdSchema("organization"), name: z.string() }),
    role: z.string(),
    expiresAt: z.string().datetime(),
  })),
}).meta({ ref: "CurrentUserInvitationsResponse" })

const meDesktopConfigResponseSchema = desktopConfigSchema.meta({
  ref: "CurrentUserDesktopConfigResponse",
})

const sendDownloadLinkResponseSchema = z.object({
  ok: z.literal(true),
}).meta({ ref: "SendDownloadLinkResponse" })

const sendDownloadLinkRateLimitSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "SendDownloadLinkRateLimitError" })

const sendDownloadLinkEmailFailedSchema = z.object({
  error: z.literal("download_link_email_failed"),
  reason: z.enum(["email_not_configured", "resend_rejected", "resend_network", "nodemailer_rejected"]),
  message: z.string(),
}).meta({ ref: "SendDownloadLinkEmailFailedError" })

const updateProfileSchema = z.object({
  firstName: z.string().trim().max(120),
  lastName: z.string().trim().max(120),
}).refine((value) => value.firstName.length > 0 || value.lastName.length > 0, {
  message: "Enter a first or last name.",
})

const updateProfileResponseSchema = z.object({
  user: z.object({}).passthrough(),
}).meta({ ref: "UpdateCurrentUserProfileResponse" })

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

export function getAllowedSingleOrgActiveOrganization(input: {
  orgs: Pick<UserOrgSummary, "id" | "slug">[]
  requestedOrgId: string | null
  requestedOrgSlug?: string
}) {
  const singletonOrg = input.orgs[0] ?? null
  if (!singletonOrg) {
    return null
  }

  if (input.requestedOrgId) {
    return input.requestedOrgId === singletonOrg.id ? singletonOrg : null
  }

  if (input.requestedOrgSlug) {
    return input.requestedOrgSlug === singletonOrg.slug ? singletonOrg : null
  }

  return singletonOrg
}

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

function normalizeNamePart(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

async function checkDownloadLinkRateLimit(userId: string, now: number) {
  const key = `me:send-download-link:${userId}`
  const [row] = await db
    .select({ id: RateLimitTable.id, count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)

  if (row && now - row.lastRequest <= DOWNLOAD_LINK_RATE_LIMIT_WINDOW_MS && row.count >= DOWNLOAD_LINK_RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((DOWNLOAD_LINK_RATE_LIMIT_WINDOW_MS - (now - row.lastRequest)) / 1000))
  }

  if (!row) {
    await db.insert(RateLimitTable).values({
      id: createDenTypeId("rateLimit"),
      key,
      count: 1,
      lastRequest: now,
    })
    return null
  }

  await db
    .update(RateLimitTable)
    .set({ count: now - row.lastRequest > DOWNLOAD_LINK_RATE_LIMIT_WINDOW_MS ? 1 : row.count + 1, lastRequest: now })
    .where(eq(RateLimitTable.id, row.id))

  return null
}

export function registerMeRoutes<T extends { Variables: AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  registerMeActivationRoutes(app)
  registerMeAgentRoutes(app)

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
        401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
      },
    }),
    orgMemberRoute({ useUserOrganizations: true }),
    (c) => {
    const orgs: UserOrganizationsContext["userOrganizations"] = c.get("userOrganizations") ?? []

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

  app.get(
    "/v1/me/invitations",
    describeRoute({
      tags: ["Users"],
      summary: "List current user's pending invitations",
      description: "Lists unexpired invitations sent to the signed-in person's verified email for organizations they have not joined yet. Always empty for an unverified email, whatever the deployment's verification setting. Accept one with POST /v1/orgs/invitations/accept.",
      responses: {
        200: jsonResponse("Pending invitations returned successfully.", meInvitationsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    userSessionRoute(),
    async (c) => {
    const user = c.get("user")
    const email = user.email?.trim().toLowerCase()
    // Only a verified email proves the person owns the inbox an invitation went to. Without it, listing would hand
    // out the invitation id that accepting otherwise requires from the emailed link, even where verification is off.
    if (!email || user.emailVerified !== true) return c.json({ invitations: [] })

    const userId = normalizeDenTypeId("user", user.id)
    const rows = await db
      .select({ id: InvitationTable.id, organizationId: InvitationTable.organizationId, organizationName: OrganizationTable.name, role: InvitationTable.role, expiresAt: InvitationTable.expiresAt })
      .from(InvitationTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, InvitationTable.organizationId))
      .leftJoin(MemberTable, and(eq(MemberTable.organizationId, InvitationTable.organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
      .where(and(
        eq(InvitationTable.status, "pending"),
        gt(InvitationTable.expiresAt, new Date()),
        sql`lower(${InvitationTable.email}) = ${email}`,
        isNull(MemberTable.id),
      ))
      .limit(20)

    return c.json({
      invitations: rows.map((row) => ({
        id: row.id,
        organization: { id: row.organizationId, name: row.organizationName },
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
      })),
    })
    },
  )

  app.post(
    "/v1/me/send-download-link",
    describeRoute({
      tags: ["Users"],
      summary: "Send current user the OpenWork desktop download link",
      description: "Emails the authenticated user a link to download the OpenWork desktop app.",
      responses: {
        200: jsonResponse("Download link email sent successfully.", sendDownloadLinkResponseSchema),
        400: jsonResponse("The signed-in account is missing an email address.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to request a download link.", unauthorizedSchema),
        429: jsonResponse("The user has requested too many download links recently.", sendDownloadLinkRateLimitSchema),
        502: jsonResponse("The download link email provider rejected or failed to deliver the email.", sendDownloadLinkEmailFailedSchema),
      },
    }),
    authenticatedRoute(),
    async (c) => {
      const user = c.get("user")
      const email = user.email?.trim()
      if (!email) {
        return c.json({ error: "user_email_required", message: "This account does not have an email address." }, 400)
      }

      const retryAfter = await checkDownloadLinkRateLimit(user.id, Date.now())
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many download link emails. Try again later." }, 429)
      }

      try {
        await sendEmail({
          to: email,
          template: "downloadLink",
          props: {
            downloadUrl: OPENWORK_DOWNLOAD_URL,
          },
        })
      } catch (error) {
        if (error instanceof DenEmailSendError) {
          return c.json({
            error: "download_link_email_failed",
            reason: error.reason,
            message:
              error.reason === "email_not_configured"
                ? "The download email provider is not configured on this deployment."
                : error.reason === "resend_network"
                  ? "Could not reach the download email provider. Try again later."
                  : `The download email provider rejected the send${error.detail ? `: ${error.detail}` : "."}`,
          }, 502)
        }

        throw error
      }

      return c.json({ ok: true })
    },
  )

  app.patch(
    "/v1/me/profile",
    describeRoute({
      tags: ["Users"],
      summary: "Update current user profile",
      description: "Updates the signed-in user's display name.",
      responses: {
        200: jsonResponse("Current user profile updated successfully.", updateProfileResponseSchema),
        400: jsonResponse("The profile update request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update profile data.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    jsonValidator(updateProfileSchema),
    async (c) => {
      const user = c.get("user")
      const input = c.req.valid("json")
      const firstName = normalizeNamePart(input.firstName)
      const lastName = normalizeNamePart(input.lastName)
      const name = [firstName, lastName].filter((part) => part.length > 0).join(" ")
      const updatedAt = new Date()

      await db
        .update(AuthUserTable)
        .set({ name, updatedAt })
        .where(eq(AuthUserTable.id, normalizeDenTypeId("user", user.id)))
      await cache.auth.deleteSessionsForUser(normalizeDenTypeId("user", user.id))
      // account.profile_updated in every membership (direct update: no better-auth hook).
      await recordProfileUpdated({ userId: user.id, before: user.name, after: name })

      return c.json({
        user: {
          ...user,
          name,
          updatedAt,
        },
      })
    },
  )

  app.post(
    "/v1/me/active-organization",
    describeRoute({
      tags: ["Users"],
      security: [{ bearerAuth: [] }],
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
    userSessionRoute(),
    jsonValidator(setActiveOrganizationSchema),
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      const input = c.req.valid("json")

      const requestedOrgId = input.organizationId ?? null
      const resolved = await resolveUserOrganizations({
        activeOrganizationId: requestedOrgId,
        userId: normalizeDenTypeId("user", user.id),
      })
      const activeOrg = env.orgMode === "single_org"
        ? getAllowedSingleOrgActiveOrganization({
            orgs: resolved.orgs,
            requestedOrgId,
            requestedOrgSlug: input.organizationSlug,
          })
        : requestedOrgId
          ? resolved.orgs.find((org) => org.id === requestedOrgId) ?? null
          : resolved.orgs.find((org) => org.slug === input.organizationSlug) ?? null
      if (!activeOrg) {
        return c.json({ error: "forbidden", message: "You do not have access to this organization." }, 403)
      }

      const sessionId = normalizeDenTypeId("session", session.id)
      await setSessionActiveOrganization(sessionId, activeOrg.id)
      c.set("session", { ...session, activeOrganizationId: activeOrg.id })
      // session.organization_entered in the destination organization only.
      if (session.activeOrganizationId !== activeOrg.id) {
        await recordSessionOrganizationEntered({ userId: user.id, organizationId: activeOrg.id, sessionId })
      }

      return c.json({ activeOrgId: activeOrg.id, activeOrgSlug: activeOrg.slug })
    },
  )

  app.get(
    "/v1/me/prompts",
    describeRoute({
      tags: ["Users"],
      summary: "Get current user's prompts",
      description: "Returns the system prompts that apply to the caller in their active organization, in the order desktops append them to OpenWork's instructions: prompts for everyone, then each of the caller's teams' prompts by team name, then prompts assigned to the caller. Desktops read it with their provider sync.",
      responses: {
        200: jsonResponse("Current user prompts returned successfully.", memberPromptsSchema),
        401: jsonResponse("The caller must be signed in to read their prompts.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      c.header("Cache-Control", "no-store")
      return c.json({ prompts: await readPromptsForMember({ organizationId: organization.id, memberId: currentMember.id }) })
    },
  )

  app.get(
    "/v1/me/desktop-config",
    describeRoute({
      tags: ["Users"],
      summary: "Get current user's desktop config",
      description: "Returns the authenticated desktop app restrictions for the caller's active organization, including the caller's agent permissions as ordered OpenCode permission rules and the model new chats start with (defaultModel, applied by OpenCode v2 desktops only) when the organization has chosen one the caller can use.",
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
      const features = await getOrganizationFeatures(organization.id, { userId: currentMember.userId })
      const agentPermissions = { rules: await readAgentPermissionRulesForMember({ organizationId: organization.id, orgMemberId: currentMember.id }) }
      // The model new chats start with; only v2 desktops apply it. A failure leaves desktops on their own default.
      const defaultModel = await desktopConfigDefaultModel({ organizationId: organization.id, memberId: currentMember.id })
      const automations = automationAvailabilityFor({
        metadata: organization.metadata,
        headlessRunnerConfigured: headlessAutomationsConfigured(),
      })

      return c.json({
        ...desktopPolicy,
        // The Automations page shows when either kind is allowed; only Desktop Automations make this desktop a runner.
        automationsEnabled: env.automations.enabled && (automations.desktop || automations.cloud),
        desktopAutomationsEnabled: automations.desktop,
        cloudAutomationsEnabled: automations.cloud,
        dashboardEnabled: env.dashboardsEnabled,
        // Compatibility field for published desktops: Connect is always on.
        connectEnabled: true,
        liveProviderSync: true,
        nativeAffordanceCodeMode: true,
        // Compatibility fields for published desktops: both behaviors are now always on.
        localProviderMirror: true,
        removeOpencodeZen: true,
        agentPermissions,
        ...(defaultModel ? { defaultModel } : {}),
        ...(Array.isArray(metadata.allowedDesktopVersions)
          ? { allowedDesktopVersions: metadata.allowedDesktopVersions }
          : {}),
        ...(typeof metadata.brandAppName === "string"
          ? { brandAppName: metadata.brandAppName }
          : {}),
        ...(typeof metadata.brandLogoUrl === "string"
          ? { brandLogoUrl: metadata.brandLogoUrl }
          : {}),
        ...(typeof metadata.brandIconUrl === "string"
          ? { brandIconUrl: metadata.brandIconUrl }
          : {}),
        ...(typeof metadata.brandAccentColor === "string"
          ? { brandAccentColor: metadata.brandAccentColor }
          : {}),
      })
    },
  )
}
