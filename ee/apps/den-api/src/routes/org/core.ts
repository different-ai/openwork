import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, ScimProviderTable, SsoConnectionTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auth } from "../../auth.js"
import { validateBrandIconUrl } from "../../brand-icon-validation.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { organizationInstallLinksEnabled } from "../../capability-sources/install-links-rollout.js"
import { db } from "../../db.js"
import { checkEntitlement, getOrganizationEntitlements, parseOrganizationPlan } from "../../entitlements.js"
import { env } from "../../env.js"
import { findEnterpriseAuthRequirementForEmail } from "../../enterprise-auth-requirement.js"
import { authenticatedRoute, jsonValidator, orgMemberRoute, orgRoleRoute, publicRoute, queryValidator, resolveMemberTeamsMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, enterprisePlanRequiredSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { normalizeOrganizationCapabilities } from "../../organization-capabilities.js"
import { validateInvitationAcceptVerification } from "../../organization-join-verification.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { isDesktopVersionOnlyOrganizationUpdate } from "../../organization-settings-permissions.js"
import {
  acceptInvitationForUser,
  createOrganizationForUser,
  getInvitationPreview,
  getSingletonSsoStatus,
  normalizeAllowedEmailDomains,
  OrganizationEmailDomainRestrictionError,
  setSessionActiveOrganization,
  updateOrganizationSettings,
} from "../../orgs.js"
import { getRequiredUserEmail } from "../../user.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner } from "./shared.js"

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

const resolveSsoByEmailResponseSchema = z.object({
  requireSso: z.boolean(),
  organizationSlug: z.string(),
  signInPath: z.string(),
  signInUrl: z.string().url(),
}).meta({ ref: "ResolveOrganizationSsoByEmailResponse" })

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

const invitationPreviewResponseSchema = z.object({}).passthrough().meta({ ref: "InvitationPreviewResponse" })

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
        409: jsonResponse("The current account email is not allowed to join this organization.", accountEmailDomainNotAllowedSchema),
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

    let accepted
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
      description: "Updates organization fields. Workspace admins can change allowed desktop versions; all other fields remain owner-only. The slug is immutable to avoid breaking dashboard URLs.",
      responses: {
        200: jsonResponse("Organization updated successfully.", organizationResponseSchema),
        400: jsonResponse("The organization update request body was invalid, contained malformed email domains, or contained an invalid brand icon URL.", updateOrganizationBadRequestSchema),
        401: jsonResponse("The caller must be signed in to update an organization.", unauthorizedSchema),
        402: jsonResponse("Enabling enforced SSO or desktop version controls requires an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("The caller does not have permission to update the requested organization fields.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    jsonValidator(updateOrganizationSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      if (payload.currentMember.isOwner) {
        const permission = ensureOwner(c)
        if (!permission.ok) {
          return c.json(permission.response, 403)
        }
      } else if (!isDesktopVersionOnlyOrganizationUpdate(input)) {
        return c.json({
          error: "forbidden",
          message: "Workspace admins can only change allowed desktop versions.",
        }, 403)
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
      summary: "Resolve required organization SSO by email",
      description: "Returns the org SSO entry URL when the email belongs to a member of any organization with SSO or SCIM configured.",
      responses: {
        200: jsonResponse("Organization SSO resolution returned successfully.", resolveSsoByEmailResponseSchema),
        204: { description: "No organization SSO or SCIM requirement matched this email." },
        400: jsonResponse("The SSO resolution query parameters were invalid.", invalidRequestSchema),
      },
    }),
    publicRoute,
    queryValidator(resolveSsoByEmailQuerySchema),
    async (c) => {
      const query = c.req.valid("query")
      const requirement = await findEnterpriseAuthRequirementForEmail(query.email)
      if (!requirement) {
        return c.body(null, 204)
      }

      return c.json({
        requireSso: true,
        organizationSlug: requirement.organizationSlug,
        signInPath: requirement.signInPath,
        signInUrl: new URL(requirement.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
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
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const owner = payload.members.find((member: typeof payload.members[number]) => member.isOwner) ?? null
      const capabilities = normalizeOrganizationCapabilities(payload.organization.metadata)
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
          ...capabilities,
          // Expose the effective value, not the raw stored flag: Connect is
          // member-facing default-on unless an explicit org kill switch says no.
          mcpConnections: memberFacingMcpConnectionsEnabled(payload.organization.metadata, {
            gatingEnabled: env.mcpConnectionsGatingEnabled,
          }),
          installLinks: organizationInstallLinksEnabled(payload.organization.metadata, {
            gatingEnabled: env.installLinksGatingEnabled,
          }),
        },
        authMethods: {
          sso: Boolean(ssoRows[0]),
          scim: Boolean(scimRows[0]),
        },
      })
    },
  )
}
