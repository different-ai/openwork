import type { Context } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { COMPUTER_DISCONNECTED_ERROR } from "@openwork/types/den/remote-devices"
import { automationRunnerAuth, type AutomationRunnerIdentity } from "../../automations/runner-auth.js"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { computerDisconnectedException } from "../../computer-disconnect.js"
import { jsonResponse } from "../../openapi.js"
import { sessionRunnerService, type SessionRunnerService } from "./service.js"

export const runnerErrorSchema = z.object({ error: z.string() })
const runnerDisconnectedSchema = z.object({ error: z.literal(COMPUTER_DISCONNECTED_ERROR), message: z.string() })

const describeRunnerRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)

/** Runner credentials never become MCP tools, including released aliases. */
export const runnerRoute = (input: { summary: string; description?: string; responses: DescribeRouteOptions["responses"] }) => describeRunnerRoute({
  tags: ["Internal"],
  "x-mcp": false,
  security: [{ automationRunnerToken: [] }],
  ...input,
  responses: {
    403: jsonResponse("This computer was disconnected from the organization; signing in on it again connects it.", runnerDisconnectedSchema),
    ...input.responses,
    401: jsonResponse("The runner token was missing, expired, or its owner is no longer an active member.", runnerErrorSchema),
  },
})

export const runnerConflictResponse = jsonResponse("The lease was lost or the request conflicts with its current state.", runnerErrorSchema)

export function createRunnerProtocol(service: Pick<SessionRunnerService, "runnerStanding"> = sessionRunnerService) {
  return {
    // Stateless credentials are honored only while the owner is active and the
    // computer is connected. This runs for every HTTP request; a held-open
    // stream rechecks periodically. A disconnected computer is answered 403
    // computer_disconnected here, for every runner route at once: the 401 the
    // handlers send would only make the desktop mint another credential.
    async authenticateRunner(c: { req: { header(name: string): string | undefined } }) {
      const identity = automationRunnerAuth.authenticate(c.req.header("Authorization"))
      if (!identity) return null
      const standing = await service.runnerStanding(identity)
      if (standing === "disconnected") throw computerDisconnectedException()
      return standing === "active" ? identity : null
    },
    attributeRunner(c: Context, identity: AutomationRunnerIdentity) {
      return attributeAuditRequest(c, {
        organizationId: identity.organizationId,
        ...auditServiceAttribution("automation-runner", identity.runnerId, { memberId: identity.ownerMemberId }),
      })
    },
  }
}
