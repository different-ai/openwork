import type { Context } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { automationRunnerAuth, type AutomationRunnerIdentity } from "../../automations/runner-auth.js"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { jsonResponse } from "../../openapi.js"
import { sessionRunnerService, type SessionRunnerService } from "./service.js"

export const runnerErrorSchema = z.object({ error: z.string() })

const describeRunnerRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)

/** Runner credentials never become MCP tools, including released aliases. */
export const runnerRoute = (input: { summary: string; description?: string; responses: DescribeRouteOptions["responses"] }) => describeRunnerRoute({
  tags: ["Internal"],
  "x-mcp": false,
  security: [{ automationRunnerToken: [] }],
  ...input,
  responses: {
    ...input.responses,
    401: jsonResponse("The runner token was missing, expired, or its owner is no longer an active member.", runnerErrorSchema),
  },
})

export const runnerConflictResponse = jsonResponse("The lease was lost or the request conflicts with its current state.", runnerErrorSchema)

export function createRunnerProtocol(service: Pick<SessionRunnerService, "isActiveRunnerOwner"> = sessionRunnerService) {
  return {
    // Stateless credentials are honored only while the owner is active. This
    // runs for every HTTP request; a held-open stream rechecks periodically.
    async authenticateRunner(c: { req: { header(name: string): string | undefined } }) {
      const identity = automationRunnerAuth.authenticate(c.req.header("Authorization"))
      if (!identity) return null
      return await service.isActiveRunnerOwner(identity) ? identity : null
    },
    attributeRunner(c: Context, identity: AutomationRunnerIdentity) {
      return attributeAuditRequest(c, {
        organizationId: identity.organizationId,
        ...auditServiceAttribution("automation-runner", identity.runnerId, { memberId: identity.ownerMemberId }),
      })
    },
  }
}
