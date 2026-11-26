import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { automationDetailSchema, automationRunReceiptSchema } from "@openwork/types/automations"
import {
  personalAgentChatResponseSchema,
  personalAgentPendingChangeSchema,
  personalAgentRunListSchema,
  personalAgentShareListSchema,
  setPersonalAgentChatSchema,
  setPersonalAgentShareSchema,
  updatePersonalAgentRoutineSchema,
  type PersonalAgentShareRole,
} from "@openwork/types/den/personal-agents"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { listPersonalAgentRuns } from "../../automations/repository.js"
import { automationService } from "../../automations/service.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, type OrganizationContextVariables,
  verifyOrgRole,
} from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import { canManagePersonalAgent, personalAgentAccess, personalAgentOwnerScope } from "../../personal-agents/access.js"
import { createPersonalAgentChangeRequest } from "../../personal-agents/requests.js"
import { personalAgentRepository } from "../../personal-agents/repository.js"
import { personalAgentService, type PersonalAgentService } from "../../personal-agents/service.js"
import type { AuthContextVariables } from "../../session.js"
import { automationRouteFailure } from "../automations/index.js"

type RouteVariables = Partial<OrganizationContextVariables> & Partial<Pick<AuthContextVariables, "session">>
const id = z.string().min(1).max(160)
const agentParams = z.object({ id })
const shareParams = agentParams.extend({ memberId: id })
const routineParams = agentParams.extend({ routineId: id })
const runParams = agentParams.extend({ runId: id })
const chatQuery = setPersonalAgentChatSchema.pick({ workspaceId: true })
const runQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
const notFound = { error: "personal_agent_not_found" }
const runNotFound = { error: "automation_run_not_found" }
const missingResponse = jsonResponse("Not found.", notFoundSchema)
const forbiddenResponse = jsonResponse("You cannot make this change.", invalidRequestSchema)

function describe(options: DescribeRouteOptions & { "x-mcp"?: true }) {
  return describeRoute({ tags: ["Personal agents"], ...options })
}

export function personalAgentCaller(c: { get(name: "organizationContext"): OrganizationContextVariables["organizationContext"] }) {
  const { organization, currentMember } = c.get("organizationContext")
  return { organizationId: organization.id, memberId: currentMember.id, isOrgAdmin: verifyOrgRole({ roles: ["admin"], userContext: currentMember }) }
}

export function personalAgentForbidden(message: string) {
  return { error: "personal_agent_forbidden", message }
}

export function registerPersonalAgentSharingRoutes<T extends { Variables: RouteVariables }>(app: Hono<T>, gate: MiddlewareHandler, service: PersonalAgentService = personalAgentService): void {
  const changeShare = async (caller: ReturnType<typeof personalAgentCaller>, agentId: string, memberId: string, role: PersonalAgentShareRole | null, audit: (id: string) => void) => {
    const access = await personalAgentAccess(caller, agentId)
    if (!access) return { status: 404, body: notFound } as const
    audit(access.agentId)
    try {
      const changed = await personalAgentRepository.changeShare(access, caller, memberId, role)
      if (changed.status === "forbidden") return { status: 403, body: personalAgentForbidden("You cannot change this person's access to the agent.") } as const
      if (changed.status === "member_not_found") return { status: 404, body: { error: "member_not_found", message: "This person is not a member of the organization." } } as const
      if (changed.status !== "ok") return { status: 404, body: notFound } as const
      return { status: 200, body: changed.shares } as const
    } catch (error) {
      if (error instanceof Error && error.message === "personal_agent_sharing_admins_only") {
        return { status: 403, body: { error: error.message, message: "Only admins can share agents in this organization." } } as const
      }
      throw error
    }
  }

  app.get("/v1/personal-agents/:id/shares",
    describe({ operationId: "listPersonalAgentShares", "x-mcp": true, summary: "See who can use a personal agent",
      responses: { 200: jsonResponse("People with access to the agent.", personalAgentShareListSchema), 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(agentParams), async (c) => {
      const access = await personalAgentAccess(personalAgentCaller(c), c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      return c.json(await personalAgentRepository.shares(access))
    })

  app.put("/v1/personal-agents/:id/shares/:memberId",
    describe({ operationId: "sharePersonalAgent", "x-mcp": true, summary: "Share a personal agent with a teammate",
      description: "An owner can add managers and collaborators. Managers can only add collaborators.",
      responses: { 200: jsonResponse("People with access to the agent.", personalAgentShareListSchema), 403: forbiddenResponse, 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(shareParams), jsonValidator(setPersonalAgentShareSchema), async (c) => {
      const { id, memberId } = c.req.valid("param")
      const result = await changeShare(personalAgentCaller(c), id, memberId, c.req.valid("json").role,
        (agentId) => addAuditRequestResource(c, { type: "personal_agent", id: agentId }))
      return c.json(result.body, result.status)
    })

  app.delete("/v1/personal-agents/:id/shares/:memberId",
    describe({ operationId: "unsharePersonalAgent", "x-mcp": true, summary: "Remove someone's access to a personal agent",
      description: "An owner can remove managers and collaborators. Managers can remove collaborators. A teammate can also leave on their own.",
      responses: { 200: jsonResponse("People with access to the agent.", personalAgentShareListSchema), 403: forbiddenResponse, 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(shareParams), async (c) => {
      const { id, memberId } = c.req.valid("param")
      const result = await changeShare(personalAgentCaller(c), id, memberId, null,
        (agentId) => addAuditRequestResource(c, { type: "personal_agent", id: agentId }))
      return c.json(result.body, result.status)
    })

  app.get("/v1/personal-agents/:id/chat",
    describe({ operationId: "getPersonalAgentChat", summary: "Find your chat with this agent in a workspace",
      responses: { 200: jsonResponse("Your chat, if you have one.", personalAgentChatResponseSchema), 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(agentParams), queryValidator(chatQuery), async (c) => {
      const caller = personalAgentCaller(c)
      const access = await personalAgentAccess(caller, c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      return c.json({ chat: await personalAgentRepository.chat(caller, access.agentId, c.req.valid("query").workspaceId) })
    })

  app.put("/v1/personal-agents/:id/chat",
    describe({ operationId: "setPersonalAgentChat", summary: "Remember your chat with this agent in a workspace",
      responses: { 200: jsonResponse("Your saved chat.", personalAgentChatResponseSchema), 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(agentParams), jsonValidator(setPersonalAgentChatSchema), async (c) => {
      const caller = personalAgentCaller(c)
      const access = await personalAgentAccess(caller, c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      return c.json({ chat: await personalAgentRepository.setChat(caller, access.agentId, c.req.valid("json")) })
    })

  app.patch("/v1/personal-agents/:id/routines/:routineId",
    describe({ operationId: "updatePersonalAgentRoutine", "x-mcp": true, summary: "Change or pause an agent's routine",
      responses: { 200: jsonResponse("Routine updated.", automationDetailSchema), 202: jsonResponse("Change requested and waiting for the owner.", personalAgentPendingChangeSchema), 400: jsonResponse("Invalid request.", invalidRequestSchema), 403: forbiddenResponse, 404: missingResponse, 409: jsonResponse("The routine cannot be updated right now.", invalidRequestSchema) } }),
    orgMemberRoute(), gate, paramValidator(routineParams), jsonValidator(updatePersonalAgentRoutineSchema), async (c) => {
      const caller = personalAgentCaller(c)
      const { id, routineId } = c.req.valid("param")
      const access = await personalAgentAccess(caller, id)
      if (!access) return c.json(notFound, 404)
      if (!canManagePersonalAgent(access.role)) return c.json(personalAgentForbidden("Only the owner or a manager can change this routine."), 403)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      try {
        if (access.state !== "active") return c.json(notFound, 404)
        const input = c.req.valid("json")
        if (access.role === "manager") {
          const request = await createPersonalAgentChangeRequest(access, caller, { change: { routineId, ...input } })
          addAuditRequestResource(c, { type: "automation", id: request.change?.routineId ?? routineId })
          return c.json({ request }, 202)
        }
        const routine = await service.updateRoutine(personalAgentOwnerScope(access), access.agentId, routineId, input, caller.memberId)
        if (!routine) return c.json(notFound, 404)
        addAuditRequestResource(c, { type: "automation", id: routine.automation.id })
        return c.json(routine)
      } catch (error) {
        if (error instanceof Error && error.message === "personal_agent_routine_not_found") return c.json({ error: error.message, message: "That routine does not belong to this agent." }, 404)
        const mapped = automationRouteFailure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    })

  app.get("/v1/personal-agents/:id/runs",
    describe({ operationId: "listPersonalAgentRuns", summary: "List your runs and scheduled runs of this agent",
      responses: { 200: jsonResponse("Your runs and scheduled run summaries, newest first.", personalAgentRunListSchema), 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(agentParams), queryValidator(runQuery), async (c) => {
      const caller = personalAgentCaller(c)
      const access = await personalAgentAccess(caller, c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      const audience = { actingMemberId: caller.memberId, includeOwnerRuns: access.role === "owner" }
      return c.json(await listPersonalAgentRuns({ organizationId: access.organizationId, agentId: access.agentId, ...audience, limit: c.req.valid("query").limit }))
    })

  app.get("/v1/personal-agents/:id/runs/:runId",
    describe({ operationId: "getPersonalAgentRun", summary: "Read one of your runs of this agent",
      responses: { 200: jsonResponse("Your run and its events.", automationRunReceiptSchema), 404: missingResponse } }),
    orgMemberRoute(), gate, paramValidator(runParams), async (c) => {
      const caller = personalAgentCaller(c)
      const { id, runId } = c.req.valid("param")
      const access = await personalAgentAccess(caller, id)
      if (!access) return c.json(notFound, 404)
      const audience = { actingMemberId: caller.memberId, includeOwnerRuns: access.role === "owner" }
      const receipt = await automationService.getRun(personalAgentOwnerScope(access), runId, { ...audience, agentId: access.agentId })
      if (!receipt) return c.json(runNotFound, 404)
      addAuditRequestResource(c, { type: "automation_run", id: receipt.run.id })
      return c.json(receipt)
    })
}
