import { personalAgentDetailSchema, setPersonalAgentAudienceSchema } from "@openwork/types/den/personal-agents"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { jsonValidator, orgMemberRoute, paramValidator, verifyOrgRole, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import { canManagePersonalAgent, personalAgentAccess, PERSONAL_AGENT_SHARING_ADMINS_ONLY, PERSONAL_AGENT_SHARING_ADMINS_ONLY_MESSAGE } from "../../personal-agents/access.js"
import { PERSONAL_AGENT_INVALID_TEAM, replacePersonalAgentAudience } from "../../personal-agents/audience.js"
import { personalAgentRepository } from "../../personal-agents/repository.js"
import type { AuthContextVariables } from "../../session.js"

type RouteVariables = Partial<OrganizationContextVariables> & Partial<Pick<AuthContextVariables, "session">>
const agentParams = z.object({ id: z.string().min(1).max(160) })
const notFound = { error: "personal_agent_not_found" }
const forbidden = { error: "personal_agent_forbidden", message: "Only the owner or a manager can change this agent's audience." }

export function registerPersonalAgentAudienceRoutes<T extends { Variables: RouteVariables }>(app: Hono<T>, gate: MiddlewareHandler): void {
  app.put("/v1/personal-agents/:id/audience",
    describeRoute({ tags: ["Agents"], operationId: "setPersonalAgentAudience", summary: "Share an agent with teams or the organization", description: "Replaces which teams, or whether the whole organization, can use the agent. Only the owner or a manager can change it, and the organization's policy can limit sharing to admins.",
      responses: {
        200: jsonResponse("Updated agent.", personalAgentDetailSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("You cannot change who can use this agent.", invalidRequestSchema),
        404: jsonResponse("Not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), gate, paramValidator(agentParams), jsonValidator(setPersonalAgentAudienceSchema), async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      const caller = { organizationId: organization.id, memberId: currentMember.id, isOrgAdmin: verifyOrgRole({ roles: ["admin"], userContext: currentMember }) }
      const access = await personalAgentAccess(caller, c.req.valid("param").id)
      if (!access || access.state === "archived") return c.json(notFound, 404)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      if (!canManagePersonalAgent(access.role)) return c.json(forbidden, 403)
      try {
        const agent = await replacePersonalAgentAudience(caller, access.agentId, c.req.valid("json"), "member")
        if (!agent) return c.json(notFound, 404)
        const detail = await personalAgentRepository.get({ ...caller, agentId: agent.id, ownerMemberId: agent.owner_member_id })
        return detail ? c.json(detail) : c.json(notFound, 404)
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === PERSONAL_AGENT_SHARING_ADMINS_ONLY) return c.json({ error: error.message, message: PERSONAL_AGENT_SHARING_ADMINS_ONLY_MESSAGE }, 403)
          if (error.message === forbidden.error) return c.json(forbidden, 403)
          if (error.message === PERSONAL_AGENT_INVALID_TEAM) return c.json({ error: "invalid_request", message: "Choose teams in this organization." }, 400)
        }
        throw error
      }
    })
}
