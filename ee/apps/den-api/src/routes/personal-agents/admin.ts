import { isDenTypeId } from "@openwork-ee/utils/typeid"
import {
  personalAgentAdminItemSchema,
  personalAgentAdminListSchema,
  personalAgentEventListSchema,
  personalAgentOrgPolicySchema,
  setPersonalAgentAdminBudgetSchema,
  setPersonalAgentAudienceSchema,
  setPersonalAgentOrgPolicySchema,
  transferPersonalAgentSchema,
} from "@openwork/types/den/personal-agents"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { z } from "zod"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { jsonValidator, orgRoleRoute, queryValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import {
  archiveAdminPersonalAgent,
  changeAdminPersonalAgent,
  getAdminPersonalAgentPolicy,
  listAdminPersonalAgentEvents,
  listAdminPersonalAgents,
  PersonalAgentAdminInputError,
  setAdminPersonalAgentAudience,
  setAdminPersonalAgentPolicy,
} from "../../personal-agents/admin.js"
import { PERSONAL_AGENT_INVALID_TEAM, PERSONAL_AGENT_NOT_SHARED } from "../../personal-agents/audience.js"
import type { AuthContextVariables } from "../../session.js"

type RouteVariables = Partial<OrganizationContextVariables> & Partial<Pick<AuthContextVariables, "session">>

const notFound = { error: "personal_agent_not_found" }
const agentParams = validator("param", z.object({ id: z.string().refine((id) => isDenTypeId("personalAgent", id)) }), (result, c) => {
  if (!result.success) return c.json(notFound, 404)
})
const eventQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), agentId: z.string().optional() })

function adminDescription(operationId: string, summary: string, schema: typeof personalAgentAdminItemSchema | typeof personalAgentAdminListSchema | typeof personalAgentOrgPolicySchema | typeof personalAgentEventListSchema, options?: { conflict: string }) {
  return describeRoute({
    tags: ["Agents"], operationId, summary,
    responses: {
      200: jsonResponse(summary, schema),
      400: jsonResponse("Invalid request.", invalidRequestSchema),
      404: jsonResponse("Not found.", notFoundSchema),
      ...(options ? { 409: jsonResponse(options.conflict, invalidRequestSchema) } : {}),
    },
  })
}

function caller(c: { get(name: "organizationContext"): OrganizationContextVariables["organizationContext"] }) {
  const context = c.get("organizationContext")
  return { organizationId: context.organization.id, memberId: context.currentMember.id }
}

async function adminAgentResponse(c: Context, load: () => ReturnType<typeof changeAdminPersonalAgent>) {
  try {
    const item = await load()
    if (!item) return c.json(notFound, 404)
    addAuditRequestResource(c, { type: "personal_agent", id: item.agent.id })
    return c.json(item)
  } catch (error) {
    if (error instanceof PersonalAgentAdminInputError) return c.json({ error: "invalid_request", message: error.message }, 400)
    if (error instanceof Error && error.message === PERSONAL_AGENT_INVALID_TEAM) return c.json({ error: "invalid_request", message: "Choose teams in this organization." }, 400)
    if (error instanceof Error && error.message === PERSONAL_AGENT_NOT_SHARED) return c.json({ error: error.message, message: "The owner must share this agent before you can change who can use it." }, 409)
    throw error
  }
}

export function registerPersonalAgentAdminRoutes<T extends { Variables: RouteVariables }>(app: Hono<T>, gate: MiddlewareHandler): void {
  app.get(
    "/v1/org/personal-agents",
    adminDescription("listAdminPersonalAgents", "List the organization's agents", personalAgentAdminListSchema),
    orgRoleRoute(["admin"]), gate,
    async (c) => c.json(await listAdminPersonalAgents(caller(c).organizationId)),
  )
  app.post(
    "/v1/org/personal-agents/:id/pause",
    adminDescription("pauseAdminPersonalAgent", "Pause an agent", personalAgentAdminItemSchema),
    orgRoleRoute(["admin"]), gate, agentParams,
    (c) => adminAgentResponse(c, () => changeAdminPersonalAgent(caller(c), c.req.valid("param").id, { kind: "pause" })),
  )
  app.post(
    "/v1/org/personal-agents/:id/resume",
    adminDescription("resumeAdminPersonalAgent", "Resume an agent", personalAgentAdminItemSchema),
    orgRoleRoute(["admin"]), gate, agentParams,
    (c) => adminAgentResponse(c, () => changeAdminPersonalAgent(caller(c), c.req.valid("param").id, { kind: "resume" })),
  )
  app.put(
    "/v1/org/personal-agents/:id/budget",
    adminDescription("setAdminPersonalAgentBudget", "Set an agent's monthly spending limit", personalAgentAdminItemSchema),
    orgRoleRoute(["admin"]), gate, agentParams, jsonValidator(setPersonalAgentAdminBudgetSchema),
    (c) => adminAgentResponse(c, () => changeAdminPersonalAgent(caller(c), c.req.valid("param").id, { kind: "budget", ...c.req.valid("json") })),
  )
  app.post(
    "/v1/org/personal-agents/:id/transfer",
    adminDescription("transferAdminPersonalAgent", "Move an agent and its routines to another owner", personalAgentAdminItemSchema),
    orgRoleRoute(["admin"]), gate, agentParams, jsonValidator(transferPersonalAgentSchema),
    (c) => adminAgentResponse(c, () => changeAdminPersonalAgent(caller(c), c.req.valid("param").id, { kind: "transfer", ...c.req.valid("json") })),
  )
  app.post(
    "/v1/org/personal-agents/:id/archive",
    adminDescription("archiveAdminPersonalAgent", "Archive an agent and its routines", personalAgentAdminItemSchema),
    orgRoleRoute(["admin"]), gate, agentParams,
    (c) => adminAgentResponse(c, () => archiveAdminPersonalAgent(caller(c), c.req.valid("param").id)),
  )
  app.put(
    "/v1/org/personal-agents/:id/audience",
    adminDescription("setAdminPersonalAgentAudience", "Change who can use an already shared agent", personalAgentAdminItemSchema, { conflict: "This agent has not been shared yet." }),
    orgRoleRoute(["admin"]), gate, agentParams, jsonValidator(setPersonalAgentAudienceSchema),
    (c) => adminAgentResponse(c, () => setAdminPersonalAgentAudience(caller(c), c.req.valid("param").id, c.req.valid("json"))),
  )
  app.get(
    "/v1/org/personal-agent-policy",
    adminDescription("getPersonalAgentOrgPolicy", "Read the organization's agent policy", personalAgentOrgPolicySchema),
    orgRoleRoute(["admin"]), gate,
    async (c) => {
      const { organizationId } = caller(c)
      addAuditRequestResource(c, { type: "organization", id: organizationId })
      return c.json(await getAdminPersonalAgentPolicy(organizationId))
    },
  )
  app.put(
    "/v1/org/personal-agent-policy",
    adminDescription("setPersonalAgentOrgPolicy", "Set sharing, tool rules, and spending limits for agents", personalAgentOrgPolicySchema),
    orgRoleRoute(["admin"]), gate, jsonValidator(setPersonalAgentOrgPolicySchema),
    async (c) => {
      const admin = caller(c)
      try {
        const policy = await setAdminPersonalAgentPolicy(admin, c.req.valid("json"))
        addAuditRequestResource(c, { type: "organization", id: admin.organizationId })
        return c.json(policy)
      } catch (error) {
        if (error instanceof PersonalAgentAdminInputError) return c.json({ error: "invalid_request", message: error.message }, 400)
        if (error instanceof Error && error.message === "tool_permission_rules_limit") {
          return c.json({ error: "invalid_request", message: "This organization has too many tool rules. Remove some rules before adding more." }, 400)
        }
        throw error
      }
    },
  )
  app.get(
    "/v1/org/personal-agent-events",
    adminDescription("listPersonalAgentEvents", "List changes to the organization's agents and policy", personalAgentEventListSchema),
    orgRoleRoute(["admin"]), gate, queryValidator(eventQuery),
    async (c) => {
      const query = c.req.valid("query")
      const events = await listAdminPersonalAgentEvents(caller(c).organizationId, query)
      if (!events) return c.json(notFound, 404)
      if (query.agentId) addAuditRequestResource(c, { type: "personal_agent", id: query.agentId })
      return c.json(events)
    },
  )
}
