import { createHash } from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, ScimProviderTable, SsoConnectionTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auth } from "../../auth.js"
import { verifyBotProtection } from "../../bot-protection.js"
import { validateBrandIconUrl } from "../../brand-icon-validation.js"
import { organizationCloudEnabled } from "../../capability-sources/cloud-rollout.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { organizationInstallLinksEnabled } from "../../capability-sources/install-links-rollout.js"
import { db } from "../../db.js"
import { checkEntitlement, getOrganizationEntitlements, parseOrganizationPlan } from "../../entitlements.js"
import { env } from "../../env.js"
import { findEnterpriseAuthRequirementForEmailDomain, resolveNonSsoSignInMethodForEmail } from "../../enterprise-auth-requirement.js"
import { authenticatedRoute, jsonValidator, orgMemberRoute, orgRoleRoute, publicRoute, queryValidator, resolveMemberTeamsMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, enterprisePlanRequiredSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { validateInvitationAcceptVerification } from "../../organization-join-verification.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { isOpenWorkWebAvailable } from "../../openwork-web-availability.js"
import {
  acceptInvitationForUser,
  createOrganizationForUser,
  getOrganizationContextForUser,
  getInvitationPreview,
  getSingletonSsoStatus,
  normalizeAllowedEmailDomains,
  OrganizationEmailDomainRestrictionError,
  serializeMemberFacingOrganizationMetadata,
  seedDefaultOrganizationRoles,
  setSessionActiveOrganization,
  type AcceptInvitationForUserResult,
  updateOrganizationSettings,
} from "../../orgs.js"
import { getRequiredUserEmail } from "../../user.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdminRole, ensureOrganizationSuperAdmin, orgAccessFailureStatus } from "./shared.js"

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
})

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  allowedEmailDomains: z.array(z.string().trim().min(1).max(255)).max(100).nullable().optional(),
  allowedDesktopVersions: z.array(z.string().trim().min(1).max(32)).max(200).nullable().optional(),
  requireSso: z.boolean().optional(),
  brandAppName: z.string().trim().min(1).max(64).nullable().optional(),
  brandLogoUrl: z.string().url().max(2048).nullable().optional(),
  brandIconUrl: z.string().url().max(2048).nullable().optional(),
  brandAccentColor: z.string().trim().min(1).max(32).nullable().optional(),
}).refine((value) => value.name !== undefined || value.allowedEmailDomains !== undefined || value.allowedDesktopVersions !== undefined || value.requireSso !== undefined || value.brandAppName !== undefined || value.brandLogoUrl !== undefined || value.brandIconUrl !== undefined || value.brandAccentColor !== undefined, {
  message: "Provide at least one organization field to update.",
})

const resolveSsoByEmailQuerySchema = z.object({
  email: z.string().trim().email(),
})

const organizationContextQuerySchema = z.object({
  refreshRoles: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
})

const resolveSsoByEmailResponseSchema = z.object({
  requireSso: z.literal(true),
  method: z.literal("sso"),
  organizationSlug: z.string(),
  signInPath: z.string(),
  signInUrl: z.string().url(),
}).or(z.object({
  requireSso: z.literal(false),
  method: z.union([z.literal("google"), z.literal("password"), z.literal("signup")]),
})).meta({ ref: "ResolveOrganizationSsoByEmailResponse" })

const botVerificationFailedSchema = z.object({
  error: z.literal("bot_verification_failed"),
  message: z.string(),
}).meta({ ref: "BotVerificationFailedError" })

const rateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "RateLimitedError" })

const SSO_RESOLVE_IDENTITY_RATE_LIMIT_MAX = 20
const SSO_RESOLVE_RATE_LIMIT_WINDOW_MS = 60_000
// See the login-options buckets: a long domain window buys burst tolerance for
// a coworker sign-in wave while keeping SUSTAINED per-domain throughput below
// the previous flat 20/min (120 per 10 min = 12/min; 30 misses per 10 min = 3/min).
const SSO_RESOLVE_DOMAIN_RATE_LIMIT_WINDOW_MS = 600_000
const SSO_RESOLVE_DOMAIN_RATE_LIMIT_MAX = 120
const SSO_RESOLVE_DOMAIN_MISS_RATE_LIMIT_MAX = 30
// A generous domain bucket bounds distributed enumeration without recreating coworker lockouts;
// only unresolved addresses pay the tighter miss bucket.

const singleOrgSsoStatusResponseSchema = z.object({
  configured: z.boolean(),
  organizationSlug: z.string(),
  signInPath: z.string(),
  signInUrl: z.string().url(),
}).meta({ ref: "SingleOrgSsoStatusResponse" })

const invitationPreviewQuerySchema = z.object({
  id: z.string().trim().min(1).max(255),
})

const acceptInvitationSchema = z.object({
  id: z.string().trim().min(1).max(255),
})

const scimDeprovisionedSchema = z.object({
  error: z.literal("scim_deprovisioned"),
  message: z.string(),
}).meta({ ref: "ScimDeprovisionedError" })

const organizationResponseSchema = z.object({
  organization: z.object({}).passthrough().nullable(),
}).meta({ ref: "OrganizationResponse" })

const singleOrgModeSchema = z.object({
  error: z.literal("single_org_mode"),
  message: z.string(),
}).meta({ ref: "SingleOrgModeError" })

const organizationOwnerSchema = z.object({
  memberId: denTypeIdSchema("member"),
  userId: denTypeIdSchema("user"),
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  image: z.string().nullable().optional(),
}).meta({ ref: "OrganizationOwner" })

const invitationPreviewResponseSchema = z.object({
  invitation: z.object({
    id: denTypeIdSchema("invitation"),
    email: z.string().email(),
    role: z.string(),
    status: z.enum(["pending", "accepted", "canceled", "expired"]),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  }),
  organization: z.object({
    id: denTypeIdSchema("organization"),
    name: z.string(),
    slug: z.string(),
    allowedEmailDomains: z.array(z.string()).nullable(),
    branding: z.object({
      appName: z.string(),
      logoUrl: z.string().url().nullable(),
      iconUrl: z.string().url().nullable(),
    }),
  }),
}).meta({ ref: "InvitationPreviewResponse" })

const invitationAcceptedResponseSchema = z.object({
  accepted: z.literal(true),
  organizationId: denTypeIdSchema("organization"),
  organizationSlug: z.string().nullable(),
  invitationId: denTypeIdSchema("invitation"),
}).meta({ ref: "InvitationAcceptedResponse" })

const organizationContextResponseSchema = z.object({
  organization: z.object({
    owner: organizationOwnerSchema.nullable().optional(),
  }).passthrough(),
  currentMember: z.object({}).passthrough(),
  currentMemberTeams: z.array(z.object({}).passthrough()),
}).passthrough().meta({ ref: "OrganizationContextResponse" })

const userEmailRequiredSchema = z.object({
  error: z.literal("user_email_required"),
}).meta({ ref: "UserEmailRequiredError" })

const invalidEmailDomainSchema = z.object({
  error: z.literal("invalid_email_domain"),
  message: z.string(),
  invalidDomains: z.array(z.string()),
}).meta({ ref: "InvalidEmailDomainError" })

const invalidBrandIconSchema = z.object({
  error: z.literal("invalid_brand_icon"),
  reason: z.string(),
  message: z.string(),
}).meta({ ref: "InvalidBrandIconError" })

const updateOrganizationBadRequestSchema = z.union([
  invalidRequestSchema,
  invalidEmailDomainSchema,
  invalidBrandIconSchema,
]).meta({ ref: "UpdateOrganizationBadRequest" })

const accountEmailDomainNotAllowedSchema = z.object({
  error: z.literal("account_email_domain_not_allowed"),
  message: z.string(),
  emailDomain: z.string().nullable(),
  allowedEmailDomains: z.array(z.string()),
}).meta({ ref: "AccountEmailDomainNotAllowedError" })

const membershipRemovedSchema = z.object({
  error: z.literal("membership_removed"),
  message: z.string(),
}).meta({ ref: "MembershipRemovedError" })

function getStoredSessionId(session: { id?: string | null } | null) {
  if (!session?.id) {
    return null
  }

  try {
    return normalizeDenTypeId("session", session.id)
  } catch {
    return null
  }
}

function getRequestAddress(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeResolveEmail(email: string) {
  return email.trim().toLowerCase()
}

export function ssoResolveRateLimitKeys(headers: Headers, email: string) {
  const normalizedEmail = normalizeResolveEmail(email)
  const domainHash = sha256Hex(normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1))
  return {
    ip: `org-sso-resolve:ip:${sha256Hex(getRequestAddress(headers))}`,
    email: `org-sso-resolve:email:${sha256Hex(normalizedEmail)}`,
    domain: `org-sso-resolve:domain:${domainHash}`,
    domainMiss: `org-sso-resolve:domain-miss:${domainHash}`,
  }
}

async function checkSsoResolveRateLimit(keys: ReturnType<typeof ssoResolveRateLimitKeys>) {
  const now = Date.now()

  for (const key of [keys.ip, keys.email]) {
    const retryAfter = await checkRateLimit(key, SSO_RESOLVE_IDENTITY_RATE_LIMIT_MAX, SSO_RESOLVE_RATE_LIMIT_WINDOW_MS, now)
    if (retryAfter !== null) {
      return retryAfter
    }
  }

  return checkRateLimit(keys.domain, SSO_RESOLVE_DOMAIN_RATE_LIMIT_MAX, SSO_RESOLVE_DOMAIN_RATE_LIMIT_WINDOW_MS, now)
}

function checkSsoResolveMissRateLimit(key: string) {
  return checkRateLimit(key, SSO_RESOLVE_DOMAIN_MISS_RATE_LIMIT_MAX, SSO_RESOLVE_DOMAIN_RATE_LIMIT_WINDOW_MS, Date.now())
}

async function setRequestActiveOrganization(
  c: {
    get: (key: "session") => { id?: string | null } | null
    req: { raw: Request }
  },
  organizationId: DenTypeId<"organization"> | null,
) {
  try {
    await auth.api.setActiveOrganization({
      body: { organizationId },
      headers: c.req.raw.headers,
    })
    return
  } catch {}

  const sessionId = getStoredSessionId(c.get("session"))
  if (sessionId) {
    await setSessionActiveOrganization(sessionId, organizationId)
  }
}

export function registerOrgCoreRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/org",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Create organization",
      description: "Creates a new organization for the signed-in user. Billing is enforced only when launching shared cloud workspaces.",
      responses: {
        201: jsonResponse("Organization created successfully.", organizationResponseSchema),
        400: jsonResponse("The organization creation request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create an organization.", unauthorizedSchema),
        403: jsonResponse("API keys cannot create organizations.", forbiddenSchema),
        409: jsonResponse("Organization creation is disabled in single-org mode.", singleOrgModeSchema),
      },
    }),
    authenticatedRoute(),
    jsonValidator(createOrganizationSchema),
    async (c) => {
    if (c.get("apiKey")) {
      return c.json({
        error: "forbidden",
        message: "API keys cannot create organizations.",
      }, 403)
    }

    if (env.orgMode === "single_org") {
      return c.json({
        error: "single_org_mode",
        message: "This deployment is configured for one organization. New organizations cannot be created.",
      }, 409)
    }

    const user = c.get("user")
    const input = c.req.valid("json")

    const organizationId = await createOrganizationForUser({
      userId: normalizeDenTypeId("user", user.id),
      name: input.name,
    })

    await setRequestActiveOrganization(c, organizationId)

    const organization = await db
      .select()
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)

    return c.json({ organization: organization[0] ?? null }, 201)
    },
  )

  app.get(
    "/v1/orgs/invitations/preview",
    describeRoute({
      tags: ["Invitations"],
      summary: "Preview organization invitation",
      description: "Returns invitation preview details so a user can inspect an organization invite before accepting it.",
      responses: {
        200: jsonResponse("Invitation preview returned successfully.", invitationPreviewResponseSchema),
        400: jsonResponse("The invitation preview query parameters were invalid.", invalidRequestSchema),
        404: jsonResponse("The invitation could not be found.", notFoundSchema),
      },
    }),
    publicRoute,
    queryValidator(invitationPreviewQuerySchema),
    async (c) => {
    const query = c.req.valid("query")
    const invitation = await getInvitationPreview(query.id)

    if (!invitation) {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    return c.json(invitation)
    },
  )

  app.post(
    "/v1/orgs/invitations/accept",
    describeRoute({
      tags: ["Invitations"],
      summary: "Accept organization invitation",
      description: "Accepts an organization invitation for the current signed-in user and switches their active organization to the accepted workspace.",
      responses: {
        200: jsonResponse("Invitation accepted successfully.", invitationAcceptedResponseSchema),
        400: jsonResponse("The invitation acceptance request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to accept an invitation.", unauthorizedSchema),
        403: jsonResponse("API keys cannot accept invitations, or the deployment requires a verified account email.", forbiddenSchema),
        409: jsonResponse("The account cannot join this organization.", z.union([accountEmailDomainNotAllowedSchema, scimDeprovisionedSchema])),
        410: jsonResponse("The user previously accepted this invitation, but their workspace access was removed.", membershipRemovedSchema),
        404: jsonResponse("The invitation could not be found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    jsonValidator(acceptInvitationSchema),
    async (c) => {
    if (c.get("apiKey")) {
      return c.json({
        error: "forbidden",
        message: "API keys cannot accept organization invitations.",
      }, 403)
    }

    const user = c.get("user")
    const input = c.req.valid("json")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }

    const verification = validateInvitationAcceptVerification({
      emailVerified: user.emailVerified,
      emailVerificationRequired: env.requireEmailVerification,
    })
    if (!verification.ok) {
      return c.json({ error: verification.error, message: verification.message }, 403)
    }

    let accepted: AcceptInvitationForUserResult | null = null
    try {
      accepted = await acceptInvitationForUser({
        userId: normalizeDenTypeId("user", user.id),
        email,
        invitationId: input.id,
      })
    } catch (error) {
      if (error instanceof OrganizationEmailDomainRestrictionError) {
        return c.json({
          error: "account_email_domain_not_allowed",
          message: error.message,
          emailDomain: error.emailDomain,
          allowedEmailDomains: error.allowedEmailDomains,
        }, 409)
      }
      throw error
    }

    if (!accepted) {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    if (accepted.status === "membership_removed") {
      return c.json({
        error: "membership_removed",
        message: "Your access to this workspace was removed. Ask a workspace admin for a new invite.",
      }, 410)
    }
    if (accepted.status === "scim_deprovisioned") {
      return c.json({
        error: "scim_deprovisioned",
        message: "This member is managed by your identity provider. Restore their access in the IdP.",
      }, 409)
    }

    await setRequestActiveOrganization(c, accepted.member.organizationId)

    const orgRows = await db
      .select({ slug: OrganizationTable.slug })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, accepted.member.organizationId))
      .limit(1)

    return c.json({
      accepted: true,
      organizationId: accepted.member.organizationId,
      organizationSlug: orgRows[0]?.slug ?? null,
      invitationId: accepted.invitation.id,
    })
    },
  )

  app.patch(
    "/v1/org",
    describeRoute({
      tags: ["Organizations"],
      summary: "Update organization",
      description: "Updates organization fields. Workspace owners and super-admins can change settings. The slug is immutable to avoid breaking dashboard URLs.",
      responses: {
        200: jsonResponse("Organization updated successfully.", organizationResponseSchema),
        400: jsonResponse("The organization update request body was invalid, contained malformed email domains, or contained an invalid brand icon URL.", updateOrganizationBadRequestSchema),
        401: jsonResponse("The caller must be signed in to update an organization.", unauthorizedSchema),
        402: jsonResponse("Enabling enforced SSO or desktop version controls requires an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("The caller does not have permission to update the requested organization fields.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    jsonValidator(updateOrganizationSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can update organization settings.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const normalizedDomains: { domains: string[] | null | undefined; invalidDomains: string[] } = input.allowedEmailDomains === undefined
        ? { domains: undefined, invalidDomains: [] }
        : normalizeAllowedEmailDomains(input.allowedEmailDomains)

      if (normalizedDomains.invalidDomains.length > 0) {
        return c.json({
          error: "invalid_email_domain",
          message: "Enter valid email domains like company.com.",
          invalidDomains: normalizedDomains.invalidDomains,
        }, 400)
      }

      const currentMetadata = normalizeOrganizationMetadata(payload.organization.metadata).metadata
      const enablesRequireSso = input.requireSso === true && currentMetadata.requireSso !== true
      const enablesVersionPinning = Array.isArray(input.allowedDesktopVersions) && input.allowedDesktopVersions.length > 0
      if (enablesRequireSso || enablesVersionPinning) {
        const entitlement = checkEntitlement(payload.organization.metadata, "orgControls")
        if (!entitlement.ok) {
          return c.json(entitlement.response, entitlement.status)
        }
      }

      const enablesBranding = (typeof input.brandAppName === "string") || (typeof input.brandLogoUrl === "string") || (typeof input.brandIconUrl === "string") || (typeof input.brandAccentColor === "string")
      if (enablesBranding) {
        const entitlement = checkEntitlement(payload.organization.metadata, "desktopPolicies")
        if (!entitlement.ok) {
          return c.json(entitlement.response, entitlement.status)
        }
      }

      if (typeof input.brandIconUrl === "string") {
        const brandIconCheck = await validateBrandIconUrl(input.brandIconUrl)
        if (!brandIconCheck.ok) {
          return c.json({
            error: "invalid_brand_icon",
            reason: brandIconCheck.reason,
            message: brandIconCheck.message,
          }, 400)
        }
      }

      const updated = await updateOrganizationSettings({
        organizationId: payload.organization.id,
        name: input.name,
        allowedEmailDomains: normalizedDomains.domains,
        allowedDesktopVersions: input.allowedDesktopVersions,
        requireSso: input.requireSso,
        brandAppName: input.brandAppName,
        brandLogoUrl: input.brandLogoUrl,
        brandIconUrl: input.brandIconUrl,
        brandAccentColor: input.brandAccentColor,
      })

      if (!updated) {
        return c.json({ error: "organization_not_found" }, 404)
      }

      return c.json({ organization: updated })
    },
  )

  app.get(
    "/v1/orgs/sso/singleton",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Resolve singleton organization SSO status",
      description: "Returns whether the singleton organization has SSO configured for single-org deployments.",
      responses: {
        200: jsonResponse("Singleton organization SSO status returned successfully.", singleOrgSsoStatusResponseSchema),
      },
    }),
    publicRoute,
    async (c) => {
      const status = await getSingletonSsoStatus()
      return c.json({
        configured: env.orgMode === "single_org" && status.configured,
        organizationSlug: status.organizationSlug,
        signInPath: status.signInPath,
        signInUrl: new URL(status.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
      })
    },
  )

  app.get(
    "/v1/orgs/sso/resolve",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Resolve sign-in method by email",
      description: "Returns a uniform sign-in routing envelope. SSO routing is resolved by verified domain; non-SSO routing is protected by bot verification and rate limiting.",
      responses: {
        200: jsonResponse("Sign-in resolution returned successfully.", resolveSsoByEmailResponseSchema),
        400: jsonResponse("The SSO resolution query parameters were invalid.", invalidRequestSchema),
        403: jsonResponse("Bot verification failed.", botVerificationFailedSchema),
        429: jsonResponse("Too many SSO resolution attempts.", rateLimitedSchema),
      },
    }),
    publicRoute,
    queryValidator(resolveSsoByEmailQuerySchema),
    async (c) => {
      const query = c.req.valid("query")

      // Security note:
      // This endpoint intentionally preserves per-user auth-method routing for non-SSO
      // accounts as a product UX decision. To reduce enumeration risk it:
      // 1. resolves SSO by verified domain, not membership,
      // 2. requires Vercel BotID verification before per-user method resolution,
      // 3. relies on Better Auth/routing rate limits,
      // 4. returns a uniform 200 response envelope for successful lookups.
      const botProtection = await verifyBotProtection()
      if (!botProtection.ok) {
        return c.json({
          error: "bot_verification_failed",
          message: botProtection.message,
        }, botProtection.status)
      }

      const rateLimitKeys = ssoResolveRateLimitKeys(c.req.raw.headers, query.email)
      const retryAfter = await checkSsoResolveRateLimit(rateLimitKeys)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({
          error: "rate_limited",
          message: "Too many sign-in resolution attempts. Try again later.",
        }, 429)
      }

      const requirement = await findEnterpriseAuthRequirementForEmailDomain(query.email)

      if (requirement) {
        return c.json({
          requireSso: true,
          method: "sso",
          organizationSlug: requirement.organizationSlug,
          signInPath: requirement.signInPath,
          signInUrl: new URL(requirement.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
        })
      }

      const method = await resolveNonSsoSignInMethodForEmail(query.email)
      if (method === "signup") {
        const missRetryAfter = await checkSsoResolveMissRateLimit(rateLimitKeys.domainMiss)
        if (missRetryAfter !== null) {
          c.header("Retry-After", String(missRetryAfter))
          return c.json({
            error: "rate_limited",
            message: "Too many sign-in resolution attempts. Try again later.",
          }, 429)
        }
      }

      return c.json({
        requireSso: false,
        method,
      })
    },
  )

  app.get(
    "/v1/org",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get active organization",
      description: "Returns the active organization from the current session, including its owner, the current member record, and their team memberships.",
      responses: {
        200: jsonResponse("Organization context returned successfully.", organizationContextResponseSchema),
        401: jsonResponse("The caller must be signed in to load organization context.", unauthorizedSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(organizationContextQuerySchema),
    resolveMemberTeamsMiddleware,
    async (c) => {
      let payload = c.get("organizationContext")
      const query = c.req.valid("query")

      if (query.refreshRoles) {
        const permission = ensureOrganizationAdminRole(c, "Only workspace owners and admins can refresh organization roles.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }

        await seedDefaultOrganizationRoles(payload.organization.id)
        const refreshedPayload = await getOrganizationContextForUser({
          organizationId: payload.organization.id,
          userId: normalizeDenTypeId("user", c.get("user").id),
        })
        if (!refreshedPayload) {
          return c.json({ error: "organization_not_found" }, 404)
        }

        payload = refreshedPayload
        c.set("organizationContext", payload)
      }

      const owner = payload.members.find((member: typeof payload.members[number]) => member.isOwner) ?? null
      const cloudEnabled = organizationCloudEnabled(payload.organization.metadata, { orgMode: env.orgMode })
      const [ssoRows, scimRows] = await Promise.all([
        db
          .select({ id: SsoConnectionTable.id })
          .from(SsoConnectionTable)
          .where(eq(SsoConnectionTable.organizationId, payload.organization.id))
          .limit(1),
        db
          .select({ id: ScimProviderTable.id })
          .from(ScimProviderTable)
          .where(eq(ScimProviderTable.organizationId, payload.organization.id))
          .limit(1),
      ])

      return c.json({
        ...payload,
        organization: {
          ...payload.organization,
          metadata: serializeMemberFacingOrganizationMetadata(payload.organization.metadata),
          owner: owner
            ? {
              memberId: owner.id,
              userId: owner.user.id,
              name: owner.user.name,
              email: owner.user.email,
              image: owner.user.image,
            }
            : null,
        },
        currentMemberTeams: c.get("memberTeams") ?? [],
        plan: parseOrganizationPlan(payload.organization.metadata),
        entitlements: getOrganizationEntitlements(payload.organization.metadata),
        capabilities: {
          // Protocol capability: clients must see this explicit signal before
          // calling the dashboard routes. Older Den versions omit the field,
          // allowing newer Desktop builds to fail closed during a staggered
          // rollout instead of calling an endpoint that does not exist yet.
          orgManagedDashboards: true,
          // Expose the effective value, not the raw stored flag: Connect is
          // member-facing default-on unless an explicit org kill switch says no.
          mcpConnections: memberFacingMcpConnectionsEnabled(payload.organization.metadata, {
            gatingEnabled: env.mcpConnectionsGatingEnabled,
          }),
          // Workflows/Code Mode are enabled for every organization; the field
          // remains for published clients that still read it.
          workflows: true,
          installLinks: organizationInstallLinksEnabled(payload.organization.metadata, {
            gatingEnabled: env.installLinksGatingEnabled,
          }),
          // Deployment capability: OpenWork Web is generally available to all
          // organizations only when a hosted-style multi-org Den has the
          // dedicated Stripe Web product configured. This is never read from
          // mutable organization metadata.
          openworkWeb: isOpenWorkWebAvailable(),
          ...(cloudEnabled ? { cloud: true } : {}),
        },
        authMethods: {
          sso: Boolean(ssoRows[0]),
          scim: Boolean(scimRows[0]),
        },
      })
    },
  )
}
