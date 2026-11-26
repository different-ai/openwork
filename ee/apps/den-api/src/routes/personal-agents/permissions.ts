import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { createPersonalAgentChangeRequestSchema, decidePersonalAgentRequestSchema, personalAgentRequestListSchema, personalAgentRequestSchema, personalAgentToolCatalogSchema, setPersonalAgentSharedLoginSchema } from "@openwork/types/den/personal-agents"
import { jsonValidator, orgMemberRoute, paramValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema } from "../../openapi.js"
import { personalAgentAccess, personalAgentOwnerScope } from "../../personal-agents/access.js"
import { PERSONAL_AGENT_MEMORY_ERRORS } from "../../personal-agents/memory.js"
import { personalAgentToolCatalog } from "../../personal-agents/permissions-catalog.js"
import { personalAgentRepository } from "../../personal-agents/repository.js"
import { createPersonalAgentChangeRequest, decidePersonalAgentRequest, listPersonalAgentRequests } from "../../personal-agents/requests.js"
import { setPersonalAgentSharedLogin } from "../../personal-agents/shared-logins.js"
import type { AuthContextVariables } from "../../session.js"
import { automationRouteFailure } from "../automations/index.js"

type RouteVariables = Partial<OrganizationContextVariables> & Partial<Pick<AuthContextVariables, "session" | "signInSessionId">>
const idSchema = z.string().min(1).max(160)
const agent = z.object({ id: idSchema })
const request = agent.extend({ requestId: idSchema })
const sharedLogin = agent.extend({ connectionId: idSchema })
const errorSchema = z.object({ error: z.string(), message: z.string().optional() })
const notFound = { error: "personal_agent_not_found" }
const requestNotFound = { error: "personal_agent_request_not_found" }
const forbidden = { error: "personal_agent_forbidden" }
const describe = (options: DescribeRouteOptions & { "x-mcp"?: true }) => describeRoute({ tags: ["Personal agents"], ...options })

function caller(c: { get(name: "organizationContext"): OrganizationContextVariables["organizationContext"] }) {
  const context = c.get("organizationContext")
  return { organizationId: context.organization.id, memberId: context.currentMember.id }
}

function failure(error: unknown) {
  if (error instanceof Error) {
    switch (error.message) {
      case "personal_agent_shared_logins_off": return { status: 403, body: { error: error.message, message: "Your admin has not allowed shared logins." } } as const
      case "personal_agent_shared_login_connection_unavailable": return { status: 403, body: { error: error.message, message: "Connect your own login before sharing it." } } as const
      case "personal_agent_organization_asks": return { status: 409, body: { error: error.message, message: "Your admin requires this tool to ask every time." } } as const
      case "personal_agent_memory_full": return { status: 409, body: { error: error.message, message: PERSONAL_AGENT_MEMORY_ERRORS.personal_agent_memory_full } } as const
      case "personal_agent_change_stale": return { status: 409, body: { error: error.message, message: "This agent or routine changed since this was asked. Ask for the change again." } } as const
      case "personal_agent_forbidden": return { status: 403, body: forbidden } as const
      case "personal_agent_not_found": return { status: 404, body: notFound } as const
      case "personal_agent_routine_not_found": return { status: 404, body: { error: error.message, message: "That routine does not belong to this agent." } } as const
      case "personal_agent_request_decided": return { status: 409, body: { error: error.message, message: "Someone already decided this request." } } as const
      case "personal_agent_routine_required": return { status: 409, body: { error: error.message, message: "Create a routine for this agent first." } } as const
      case "personal_agent_routine_ambiguous": return { status: 409, body: { error: error.message, message: "Choose which routine to change." } } as const
      case "personal_agent_tool_policy_too_large":
      case "personal_agent_tool_policy_connection_invalid": return { status: 400, body: { error: error.message } } as const
    }
  }
  return automationRouteFailure(error)
}

export function registerPersonalAgentPermissionsRoutes<T extends { Variables: RouteVariables }>(app: Hono<T>, gate: MiddlewareHandler): void {
  app.get("/v1/personal-agents/:id/requests", describe({
    operationId: "listPersonalAgentRequests", "x-mcp": true, summary: "List requests for an agent",
    responses: { 200: jsonResponse("Requests, newest first.", personalAgentRequestListSchema), 404: jsonResponse("Agent not found.", notFoundSchema) },
  }), orgMemberRoute(), gate, paramValidator(agent), async (c) => {
    const member = caller(c)
    const access = await personalAgentAccess(member, c.req.valid("param").id)
    if (!access) return c.json(notFound, 404)
    return c.json(await listPersonalAgentRequests(access, member))
  })

  app.post("/v1/personal-agents/:id/requests", describe({
    operationId: "requestPersonalAgentChange", "x-mcp": true, summary: "Ask for a change to an agent",
    description: "Use this when a person who cannot change the agent asks for a change to what it does or how often it runs.",
    responses: { 201: jsonResponse("Change requested.", personalAgentRequestSchema), 403: jsonResponse("This agent cannot be changed.", errorSchema), 404: jsonResponse("Agent or routine not found.", notFoundSchema), 409: jsonResponse("Choose a routine to change.", errorSchema) },
  }), orgMemberRoute(), gate, paramValidator(agent), jsonValidator(createPersonalAgentChangeRequestSchema), async (c) => {
    const member = caller(c)
    const access = await personalAgentAccess(member, c.req.valid("param").id)
    if (!access) return c.json(notFound, 404)
    try {
      return c.json(await createPersonalAgentChangeRequest(access, member, c.req.valid("json")), 201)
    } catch (error) {
      const refused = failure(error)
      if (!refused) throw error
      return c.json(refused.body, refused.status)
    }
  })

  app.post("/v1/personal-agents/:id/requests/:requestId/decision", describe({
    operationId: "decidePersonalAgentRequest", summary: "Decide a request for an agent",
    responses: { 200: jsonResponse("Request decided.", personalAgentRequestSchema), 403: jsonResponse("You cannot make this decision.", errorSchema), 404: jsonResponse("Agent or request not found.", notFoundSchema), 409: jsonResponse("Someone already decided this request.", errorSchema) },
  }), orgMemberRoute(), gate, paramValidator(request), jsonValidator(decidePersonalAgentRequestSchema), async (c) => {
    if (!c.get("signInSessionId")) return c.json(forbidden, 403)
    const member = caller(c)
    const { id, requestId } = c.req.valid("param")
    const access = await personalAgentAccess(member, id)
    if (!access) return c.json(notFound, 404)
    try {
      const decided = await decidePersonalAgentRequest(access, member, requestId, c.req.valid("json").decision)
      return decided ? c.json(decided) : c.json(requestNotFound, 404)
    } catch (error) {
      const refused = failure(error)
      if (!refused) throw error
      return c.json(refused.body, refused.status)
    }
  })

  app.get("/v1/personal-agents/:id/tools", describe({
    operationId: "listPersonalAgentTools", "x-mcp": true, summary: "List tools and permissions for a personal agent",
    responses: { 200: jsonResponse("Tools and their permissions.", personalAgentToolCatalogSchema), 404: jsonResponse("Agent not found.", notFoundSchema) },
  }), orgMemberRoute(), gate, paramValidator(agent), async (c) => {
    const member = caller(c)
    const access = await personalAgentAccess(member, c.req.valid("param").id)
    if (!access) return c.json(notFound, 404)
    const current = await personalAgentRepository.get({ ...personalAgentOwnerScope(access), agentId: access.agentId })
    if (!current) return c.json(notFound, 404)
    return c.json(await personalAgentToolCatalog(member, current.revision.toolPolicy, access))
  })

  app.put("/v1/personal-agents/:id/shared-logins/:connectionId", describe({
    operationId: "setPersonalAgentSharedLogin", summary: "Share or take back your login for an agent",
    responses: { 200: jsonResponse("Tools and their permissions.", personalAgentToolCatalogSchema), 403: jsonResponse("You cannot change this shared login.", errorSchema), 404: jsonResponse("Agent not found.", notFoundSchema) },
  }), orgMemberRoute(), gate, paramValidator(sharedLogin), jsonValidator(setPersonalAgentSharedLoginSchema), async (c) => {
    if (!c.get("signInSessionId")) return c.json(forbidden, 403)
    const member = caller(c)
    const { id, connectionId } = c.req.valid("param")
    const access = await personalAgentAccess(member, id)
    if (!access) return c.json(notFound, 404)
    const current = await personalAgentRepository.get({ ...personalAgentOwnerScope(access), agentId: access.agentId })
    if (!current) return c.json(notFound, 404)
    try {
      await setPersonalAgentSharedLogin(member, access, connectionId, c.req.valid("json").shared)
      return c.json(await personalAgentToolCatalog(member, current.revision.toolPolicy, access))
    } catch (error) {
      const refused = failure(error)
      if (!refused) throw error
      return c.json(refused.body, refused.status)
    }
  })
}
