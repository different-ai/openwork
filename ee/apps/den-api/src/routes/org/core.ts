import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireCloudWorkerAccess } from "../../billing/polar.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, paramValidator, queryValidator, requireUserMiddleware, resolveMemberTeamsMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { acceptInvitationForUser, createOrganizationForUser, getInvitationPreview, setSessionActiveOrganization } from "../../orgs.js"
import { getRequiredUserEmail } from "../../user.js"
import type { OrgRouteVariables } from "./shared.js"
import { orgIdParamSchema } from "./shared.js"

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
})

const invitationPreviewQuerySchema = z.object({
  id: denTypeIdSchema("invitation"),
})

const acceptInvitationSchema = z.object({
  id: denTypeIdSchema("invitation"),
})

const organizationResponseSchema = z.object({
  organization: z.object({}).passthrough().nullable(),
}).meta({ ref: "OrganizationResponse" })

const paymentRequiredSchema = z.object({
  error: z.literal("payment_required"),
  message: z.string(),
  polar: z.object({
    checkoutUrl: z.string().nullable(),
    productId: z.string().nullable().optional(),
    benefitId: z.string().nullable().optional(),
  }).passthrough(),
}).meta({ ref: "PaymentRequiredError" })

const invitationPreviewResponseSchema = z.object({}).passthrough().meta({ ref: "InvitationPreviewResponse" })

const invitationAcceptedResponseSchema = z.object({
  accepted: z.literal(true),
  organizationId: denTypeIdSchema("organization"),
  organizationSlug: z.string().nullable(),
  invitationId: denTypeIdSchema("invitation"),
}).meta({ ref: "InvitationAcceptedResponse" })

const organizationContextResponseSchema = z.object({
  currentMemberTeams: z.array(z.object({}).passthrough()),
}).passthrough().meta({ ref: "OrganizationContextResponse" })

const userEmailRequiredSchema = z.object({
  error: z.literal("user_email_required"),
}).meta({ ref: "UserEmailRequiredError" })

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

export function registerOrgCoreRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Create organization",
      description: "Creates a new organization for the signed-in user after verifying that their account can provision OpenWork Cloud workspaces.",
      responses: {
        201: jsonResponse("Organization created successfully.", organizationResponseSchema),
        400: jsonResponse("The organization creation request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create an organization.", unauthorizedSchema),
        402: jsonResponse("The caller needs an active cloud plan before creating an organization.", paymentRequiredSchema),
        403: jsonResponse("API keys cannot create organizations.", forbiddenSchema),
      },
    }),
    requireUserMiddleware,
    jsonValidator(createOrganizationSchema),
    async (c) => {
    if (c.get("apiKey")) {
      return c.json({
        error: "forbidden",
        message: "API keys cannot create organizations.",
      }, 403)
    }

    const user = c.get("user")
    const session = c.get("session")
    const input = c.req.valid("json")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }

    const access = await requireCloudWorkerAccess({
      userId: normalizeDenTypeId("user", user.id),
      email,
      name: user.name ?? user.email ?? "OpenWork User",
    })

    if (!access.allowed) {
      return c.json({
        error: "payment_required",
        message: "Creating a workspace requires an active OpenWork Cloud plan.",
        polar: {
          checkoutUrl: access.checkoutUrl,
          productId: env.polar.productId,
          benefitId: env.polar.benefitId,
        },
      }, 402)
    }

    const organizationId = await createOrganizationForUser({
      userId: normalizeDenTypeId("user", user.id),
      name: input.name,
    })

    const sessionId = getStoredSessionId(session)
    if (sessionId) {
      await setSessionActiveOrganization(sessionId, organizationId)
    }

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
        403: jsonResponse("API keys cannot accept organization invitations.", forbiddenSchema),
        404: jsonResponse("The invitation could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    jsonValidator(acceptInvitationSchema),
    async (c) => {
    if (c.get("apiKey")) {
      return c.json({
        error: "forbidden",
        message: "API keys cannot accept organization invitations.",
      }, 403)
    }

    const user = c.get("user")
    const session = c.get("session")
    const input = c.req.valid("json")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }

    const accepted = await acceptInvitationForUser({
      userId: normalizeDenTypeId("user", user.id),
      email,
      invitationId: input.id,
    })

    if (!accepted) {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    const sessionId = getStoredSessionId(session)
    if (sessionId) {
      await setSessionActiveOrganization(sessionId, accepted.member.organizationId)
    }

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

  app.get(
    "/v1/orgs/:orgId/context",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get organization context",
      description: "Returns the resolved organization context for a specific org, including the current member record and their team memberships.",
      responses: {
        200: jsonResponse("Organization context returned successfully.", organizationContextResponseSchema),
        400: jsonResponse("The organization context path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to load organization context.", unauthorizedSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    resolveMemberTeamsMiddleware,
    (c) => {
      return c.json({
        ...c.get("organizationContext"),
        currentMemberTeams: c.get("memberTeams") ?? [],
      })
    },
  )
}
