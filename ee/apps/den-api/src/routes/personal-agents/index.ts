import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { automationDetailSchema } from "@openwork/types/automations"
import {
  createPersonalAgentRoutineSchema,
  createPersonalAgentSchema,
  personalAgentDetailSchema,
  personalAgentListSchema,
  personalAgentPendingChangeSchema,
  personalAgentRoutineListSchema,
  personalAgentRunResponseSchema,
  runPersonalAgentNowSchema,
  updatePersonalAgentSchema,
} from "@openwork/types/den/personal-agents"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { requireFeature } from "../../features.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  queryValidator,
  validationIssuesMessage,
  type OrganizationContextVariables,
  verifyOrgRole,
} from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import { canManagePersonalAgent, personalAgentAccess, personalAgentOwnerScope } from "../../personal-agents/access.js"
import { createPersonalAgentChangeRequest } from "../../personal-agents/requests.js"
import { personalAgentService, type PersonalAgentService } from "../../personal-agents/service.js"
import type { AuthContextVariables } from "../../session.js"
import { automationRouteFailure } from "../automations/index.js"
import { registerPersonalAgentAdminRoutes } from "./admin.js"
import { registerPersonalAgentAudienceRoutes } from "./audience.js"
import { registerPersonalAgentMemoryRoutes } from "./memory.js"
import { registerPersonalAgentPermissionsRoutes } from "./permissions.js"
import { registerPersonalAgentStandingChatRoutes } from "./standing-chat.js"
import { personalAgentCaller, personalAgentForbidden, registerPersonalAgentSharingRoutes } from "./sharing.js"

const idParamsSchema = z.object({ id: z.string().min(1).max(160) })
const paginationSchema = z.object({
  cursor: z.string().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

type McpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": true }
const describeMcpRoute = (options: McpDescribeRouteOptions) => describeRoute(options)

type RouteVariables = Partial<OrganizationContextVariables> & Partial<Pick<AuthContextVariables, "session">>

const about = [
  "An agent has an owner, a name, a brief that says how it works, and rules for which tools it can use.",
  "Every change to the brief or tool policy makes a new version.",
  "An agent does its work through routines. A routine is a Cloud Automation that belongs to the agent, so it also appears in the Automation capabilities; each run starts from the agent's brief and can use only what the agent's tool policy allows.",
  "The owner can share the agent with teammates. Managers can change who can collaborate. The owner must approve changes a manager proposes to the brief, tool policy or routines. Collaborators can use the agent and ask for changes. Runs started by a teammate are private. Scheduled runs use the owner’s accounts and share their results with the team.",
].join(" ")

const notFound = { error: "personal_agent_not_found" as const }

function scope(c: { get(name: "organizationContext"): OrganizationContextVariables["organizationContext"] }) {
  const context = c.get("organizationContext")
  return {
    organizationId: context.organization.id,
    ownerMemberId: context.currentMember.id,
    modelAttentionCapable: true,
    isOrgAdmin: verifyOrgRole({ roles: ["admin"], userContext: context.currentMember }),
  }
}

function failure(error: unknown): { status: 400 | 403 | 404 | 409; body: { error: string; message?: string } } | null {
  if (error instanceof Error) {
    if (error.message === "personal_agent_idempotency_conflict") return { status: 409, body: { error: error.message } }
    if (error.message === "personal_agent_not_found") return { status: 404, body: notFound }
    if (error.message === "personal_agent_tool_policy_connection_invalid") {
      return { status: 400, body: { error: error.message, message: "A tool policy can name only connectors added to this organization, by their connection id. Built-in connectors such as Google Workspace cannot be limited per agent yet." } }
    }
    if (error.message === "personal_agent_tool_policy_too_large") {
      return { status: 400, body: { error: error.message, message: "This tool policy blocks more than a run can carry. Block the whole connection instead of many of its tools." } }
    }
    if (error.message === "personal_agent_run_queue_full") {
      return { status: 409, body: { error: error.message, message: "This agent already has several runs waiting. Try again when one finishes." } }
    }
    if (error.message === "personal_agent_routine_required") {
      return { status: 409, body: { error: error.message, message: "This agent has no routine yet. Create a routine for it, then run it." } }
    }
    if (error.message === "personal_agent_routine_ambiguous") {
      return { status: 409, body: { error: error.message, message: "This agent has more than one routine. Pass routineId to choose which one to run." } }
    }
    if (error.message === "personal_agent_routine_not_found") {
      return { status: 404, body: { error: error.message, message: "That routine does not belong to this agent." } }
    }
  }
  return automationRouteFailure(error)
}

async function runNowBody(c: { req: { text(): Promise<string> } }) {
  const text = await c.req.text()
  if (!text.trim()) return runPersonalAgentNowSchema.safeParse({})
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return runPersonalAgentNowSchema.safeParse(body)
}

export function registerPersonalAgentRoutes<T extends { Variables: RouteVariables }>(
  app: Hono<T>,
  options: { service?: PersonalAgentService } = {},
) {
  const service = options.service ?? personalAgentService
  const gate = requireFeature("personalAgents")

  app.get(
    "/v1/personal-agents",
    describeMcpRoute({
      tags: ["Agents"], operationId: "listPersonalAgents", "x-mcp": true,
      summary: "List your agents", description: about,
      responses: {
        200: jsonResponse("Agents returned, newest first.", personalAgentListSchema),
        404: jsonResponse("Agents are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(), gate, queryValidator(paginationSchema),
    async (c) => c.json(await service.list(scope(c), c.req.valid("query"))),
  )

  app.post(
    "/v1/personal-agents",
    describeMcpRoute({
      tags: ["Agents"], operationId: "createPersonalAgent", "x-mcp": true,
      summary: "Create an agent",
      description: `${about} Create one only when the person asks for an agent. Write the brief as Markdown from what they said: what the agent watches or does, how it decides, and how it reports. The agent does nothing until it has a routine; add one with createPersonalAgentRoutine.`,
      responses: {
        201: jsonResponse("Agent created or returned from an earlier request.", personalAgentDetailSchema),
        409: jsonResponse("This key was already used with a different name or brief.", notFoundSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        404: jsonResponse("Agents are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(), gate, jsonValidator(createPersonalAgentSchema),
    async (c) => {
      try {
        const created = await service.create(scope(c), c.req.valid("json"))
        addAuditRequestResource(c, { type: "personal_agent", id: created.agent.id })
        return c.json(created, 201)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.get(
    "/v1/personal-agents/:id",
    describeMcpRoute({
      tags: ["Agents"], operationId: "getPersonalAgent", "x-mcp": true,
      summary: "Get an agent and its current brief", description: about,
      responses: { 200: jsonResponse("Agent returned.", personalAgentDetailSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), gate, paramValidator(idParamsSchema),
    async (c) => {
      const caller = personalAgentCaller(c)
      const access = await personalAgentAccess(caller, c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      const agent = await service.get(personalAgentOwnerScope(access), access.agentId, caller.memberId)
      return agent ? c.json(agent) : c.json(notFound, 404)
    },
  )

  app.patch(
    "/v1/personal-agents/:id",
    describeMcpRoute({
      tags: ["Agents"], operationId: "updatePersonalAgent", "x-mcp": true,
      summary: "Change an agent",
      description: `${about} Send only what changes. A new brief or tool policy replaces the old one whole, makes the next version, and applies to the agent's routines from their next run; a run already in progress keeps the version it started with. A rename alone keeps the version.`,
      responses: {
        200: jsonResponse("Agent updated.", personalAgentDetailSchema),
        202: jsonResponse("Change requested and waiting for the owner.", personalAgentPendingChangeSchema),
        403: jsonResponse("You cannot make this change.", invalidRequestSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        404: jsonResponse("Not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), gate, paramValidator(idParamsSchema), jsonValidator(updatePersonalAgentSchema),
    async (c) => {
      try {
        const caller = personalAgentCaller(c)
        const access = await personalAgentAccess(caller, c.req.valid("param").id)
        if (!access) return c.json(notFound, 404)
        if (!canManagePersonalAgent(access.role)) return c.json(personalAgentForbidden("Only the owner or a manager can change this agent."), 403)
        const changes = c.req.valid("json")
        if (access.role !== "owner" && (changes.monthlyBudgetMicros !== undefined || changes.defaultExecutionTarget !== undefined)) {
          return c.json(personalAgentForbidden("Only the owner can change the budget or where the agent runs."), 403)
        }
        addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
        if (access.role === "manager" && (changes.brief !== undefined || changes.toolPolicy !== undefined)) {
          if (access.state !== "active") return c.json(notFound, 404)
          const request = await createPersonalAgentChangeRequest(access, caller, { change: { brief: changes.brief, toolPolicy: changes.toolPolicy } })
          return c.json({ request }, 202)
        }
        const updated = await service.update(personalAgentOwnerScope(access), access.agentId, changes, caller.memberId)
        return updated ? c.json(updated) : c.json(notFound, 404)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.delete(
    "/v1/personal-agents/:id",
    describeMcpRoute({
      tags: ["Agents"], operationId: "archivePersonalAgent", "x-mcp": true,
      summary: "Archive an agent",
      description: `${about} Archiving also archives the agent's routines, so nothing keeps running. Run history is kept.`,
      responses: { 200: jsonResponse("Agent archived.", personalAgentDetailSchema), 403: jsonResponse("Only the owner can archive the agent.", invalidRequestSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), gate, paramValidator(idParamsSchema),
    async (c) => {
      const access = await personalAgentAccess(personalAgentCaller(c), c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      if (access.role !== "owner") return c.json(personalAgentForbidden("Only the owner can archive this agent."), 403)
      addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
      const archived = await service.archive(personalAgentOwnerScope(access), access.agentId)
      return archived ? c.json(archived) : c.json(notFound, 404)
    },
  )

  app.get(
    "/v1/personal-agents/:id/routines",
    describeMcpRoute({
      tags: ["Agents"], operationId: "listPersonalAgentRoutines", "x-mcp": true,
      summary: "List an agent's routines", description: `${about} Returns the 100 newest routines.`,
      responses: { 200: jsonResponse("Routines returned, newest first.", personalAgentRoutineListSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), gate, paramValidator(idParamsSchema),
    async (c) => {
      const caller = personalAgentCaller(c)
      const access = await personalAgentAccess(caller, c.req.valid("param").id)
      if (!access) return c.json(notFound, 404)
      const routines = await service.listRoutines(personalAgentOwnerScope(access), access.agentId, caller.memberId)
      return routines ? c.json(routines) : c.json(notFound, 404)
    },
  )

  app.post(
    "/v1/personal-agents/:id/routines",
    describeMcpRoute({
      tags: ["Agents"], operationId: "createPersonalAgentRoutine", "x-mcp": true,
      summary: "Give an agent a routine",
      description: `${about} A manager’s request waits for the owner’s approval. Once created, the routine is active and runs in OpenWork Cloud on its schedule. Its instructions say what this routine does; do not repeat the brief in them. Change or pause it with the agent routine update.`,
      responses: {
        202: jsonResponse("Routine requested and waiting for the owner.", personalAgentPendingChangeSchema),
        201: jsonResponse("Routine created as an active Cloud Automation that carries the agent's id.", automationDetailSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("Cloud Automations are not available.", invalidRequestSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("Cloud runtime or model access is unavailable.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), gate, paramValidator(idParamsSchema), jsonValidator(createPersonalAgentRoutineSchema),
    async (c) => {
      try {
        const caller = personalAgentCaller(c)
        const access = await personalAgentAccess(caller, c.req.valid("param").id)
        if (!access) return c.json(notFound, 404)
        if (!canManagePersonalAgent(access.role)) return c.json(personalAgentForbidden("Only the owner or a manager can add a routine."), 403)
        if (access.state !== "active") return c.json(notFound, 404)
        const input = c.req.valid("json")
        if (access.role === "manager") {
          const { name, instructions, schedule } = input
          const request = await createPersonalAgentChangeRequest(access, caller, { change: { newRoutine: { name, instructions, schedule } } })
          addAuditRequestResource(c, { type: "personal_agent", id: access.agentId })
          return c.json({ request }, 202)
        }
        const routine = await service.createRoutine(personalAgentOwnerScope(access), access.agentId, input, caller.memberId)
        if (!routine) return c.json(notFound, 404)
        addAuditRequestResource(c, { type: "automation", id: routine.automation.id })
        return c.json(routine, 201)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.post(
    "/v1/personal-agents/:id/run",
    describeMcpRoute({
      tags: ["Agents"], operationId: "runPersonalAgentNow", "x-mcp": true,
      summary: "Run an agent now",
      description: `${about} Starts one run of the agent's routine now, in addition to its schedule. Pass routineId when the agent has more than one routine. The run appears in your own run history.`,
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                routineId: { type: "string", description: "Which of the agent's routines to run. Optional when the agent has exactly one." },
              },
            },
          },
        },
      },
      responses: {
        202: jsonResponse("Run queued, pinned to the agent version it will use.", personalAgentRunResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("Cloud Automations are not available.", invalidRequestSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("The agent has no routine, has several, or the cloud runtime or model is unavailable.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), gate, paramValidator(idParamsSchema),
    async (c) => {
      const body = await runNowBody(c)
      if (!body.success) {
        return c.json({ error: "invalid_request", message: validationIssuesMessage(body.error.issues), details: body.error.issues }, 400)
      }
      try {
        const caller = personalAgentCaller(c)
        const access = await personalAgentAccess(caller, c.req.valid("param").id)
        if (!access) return c.json(notFound, 404)
        const started = await service.runNow(personalAgentOwnerScope(access), access.agentId, body.data, {
          agentCaller: c.get("session")?.id === "mcp_internal",
          actingMemberId: access.role === "owner" ? undefined : caller.memberId,
        })
        if (!started) return c.json(notFound, 404)
        addAuditRequestResource(c, { type: "automation_run", id: started.run.id })
        return c.json(started, 202)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )
  registerPersonalAgentStandingChatRoutes(app, gate)
  registerPersonalAgentSharingRoutes(app, gate, service)
  registerPersonalAgentMemoryRoutes(app, gate)
  registerPersonalAgentAudienceRoutes(app, gate)
  registerPersonalAgentPermissionsRoutes(app, gate)
  registerPersonalAgentAdminRoutes(app, gate)
}
