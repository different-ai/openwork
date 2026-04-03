import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { z } from "zod"
import { requireCloudWorkerAccess } from "../../billing/polar.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, paramValidator, queryValidator, requireUserMiddleware, resolveMemberTeamsMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { acceptInvitationForUser, createOrganizationForUser, getInvitationPreview, setSessionActiveOrganization } from "../../orgs.js"
import { getRequiredUserEmail } from "../../user.js"
import type { OrgRouteVariables } from "./shared.js"
import { orgIdParamSchema } from "./shared.js"

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
})

const invitationPreviewQuerySchema = z.object({
  id: z.string().trim().min(1),
})

const acceptInvitationSchema = z.object({
  id: z.string().trim().min(1),
})

export function registerOrgCoreRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post("/v1/orgs", requireUserMiddleware, jsonValidator(createOrganizationSchema), async (c) => {
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

    if (session?.id) {
      await setSessionActiveOrganization(normalizeDenTypeId("session", session.id), organizationId)
    }

    const organization = await db
      .select()
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)

    return c.json({ organization: organization[0] ?? null }, 201)
  })

  app.get("/v1/orgs/invitations/preview", queryValidator(invitationPreviewQuerySchema), async (c) => {
    const query = c.req.valid("query")
    const invitation = await getInvitationPreview(query.id)

    if (!invitation) {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    return c.json(invitation)
  })

  app.post("/v1/orgs/invitations/accept", requireUserMiddleware, jsonValidator(acceptInvitationSchema), async (c) => {
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

    if (session?.id) {
      await setSessionActiveOrganization(normalizeDenTypeId("session", session.id), accepted.member.organizationId)
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
  })

  app.get(
    "/v1/orgs/:orgId/context",
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
