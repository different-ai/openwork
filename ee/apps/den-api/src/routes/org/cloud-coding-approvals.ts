import { cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema, cloudCodingPushDecisionInputSchema } from "@openwork/types/den/cloud-coding"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auditChangeCapture } from "../../audit/request-capture.js"
import { cloudCodingApprovalView, decideCloudCodingApproval, getCloudCodingApproval, listCloudCodingApprovals } from "../../cloud-coding/gateway/approvals.js"
import { recordGatewayEvent } from "../../cloud-coding/gateway/audit.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, userSessionRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const root = "/v1/cloud-coding/approvals"
const errorSchema = z.object({ error: z.string(), message: z.string() })
const notFound = { error: "approval_not_found", message: "This push approval could not be found." }

const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
}

const approvalParams = z.object({ approvalId: z.string() })

function docs(operationId: string, summary: string, description: string, schema: z.ZodType, sessionOnly = false) {
  return describeRoute({ operationId, tags: ["Organizations"], summary, description, ...(sessionOnly ? { security: [{ bearerAuth: [] }] } : {}), responses: {
    200: jsonResponse(summary, schema), 400: jsonResponse("Check the information you entered.", invalidRequestSchema),
    401: jsonResponse("Sign in to continue.", unauthorizedSchema), 403: jsonResponse("You do not have permission.", forbiddenSchema),
    404: jsonResponse("The approval could not be found.", errorSchema), 409: jsonResponse("This approval is no longer pending.", errorSchema),
  } })
}

export function registerCloudCodingApprovalRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const gate = requireFeature("cloudCoding")
  app.get(root, docs("listCloudCodingPushApprovals", "List your Cloud coding push approvals", "Returns your 20 most recent approvals, or all approvals waiting for your decision when status is pending.", cloudCodingPushApprovalListSchema), noStore, orgMemberRoute(), gate,
    queryValidator(z.object({ status: z.literal("pending").optional() })), async c => {
      const { organization, currentMember } = c.get("organizationContext")
      const approvals = await listCloudCodingApprovals({ organizationId: organization.id, memberId: currentMember.id }, c.req.valid("query").status)
      return c.json(cloudCodingPushApprovalListSchema.parse({ approvals }))
    })
  app.get(`${root}/:approvalId`, docs("getCloudCodingPushApproval", "Read your Cloud coding push approval", "Returns the current status of your approval and a link to the pull request after it opens.", cloudCodingPushApprovalSchema), noStore, orgMemberRoute(), gate, paramValidator(approvalParams), async c => {
    const { organization, currentMember } = c.get("organizationContext")
    const approval = await getCloudCodingApproval({ organizationId: organization.id, memberId: currentMember.id }, c.req.param("approvalId"))
    if (!approval) return c.json(notFound, 404)
    return c.json(await cloudCodingApprovalView(approval))
  })
  app.post(`${root}/:approvalId/decision`, docs("decideCloudCodingPushApproval", "Allow once or deny your Cloud coding push", "Decides a pending approval from your signed-in session. Allow once applies only to the commit shown in the approval.", cloudCodingPushApprovalSchema, true), noStore,
    userSessionRoute(), orgMemberRoute(), gate, paramValidator(approvalParams), jsonValidator(cloudCodingPushDecisionInputSchema), async c => {
      const { organization, currentMember } = c.get("organizationContext")
      const { decision } = c.req.valid("json")
      const approval = await decideCloudCodingApproval({ organizationId: organization.id, memberId: currentMember.id }, c.req.param("approvalId"), decision,
        (tx, row) => recordGatewayEvent(tx, auditChangeCapture(c), decision === "allow_once" ? "cloud_coding.push.approved" : "cloud_coding.push.denied", row))
      if (!approval) return c.json(notFound, 404)
      if (approval === "not_pending") return c.json({ error: "approval_not_pending", message: "This push approval is no longer waiting for a decision." }, 409)
      return c.json(await cloudCodingApprovalView(approval))
    })
}
