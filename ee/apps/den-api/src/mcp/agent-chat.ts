import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/server"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { z } from "zod"
import { mcpAuditPrincipal } from "../audit/mcp-service-audit.js"
import { env } from "../env.js"
import { cachedOrganizationFeatureContext } from "../features.js"
import { tokenRoute } from "../middleware/index.js"
import { personalAgentChatDispatchContext } from "../personal-agents/permissions-dispatch.js"
import { primaryReadsMiddleware } from "../read-routing.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { executeCapabilityWithBudget, type ExecuteCapabilityToolResult } from "./agent.js"
import { listRequestableAgentConnections, registerAgentConnectorRequestTool } from "./agent-connector-request.js"
import { getMcpResourceContext, mcpPrincipalCredentialId, verifyMcpRequest } from "./auth.js"
import { createCapabilityRegistryContext, executeCapability, searchCapabilityRegistry, type CapabilitySourceKind } from "./capability-registry.js"
import { mcpMemberForToken, resolveMcpMemberIdentity } from "./external-capabilities.js"
import type { InternalApp } from "./catalog.js"
import { getCatalog } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { rejectStandaloneSseResponse } from "./standalone-sse.js"
import { personalAgentChatTurnId } from "./workbot-turn-limits.js"

const AGENT_CHAT_SOURCES: readonly CapabilitySourceKind[] = ["catalog", "native", "externalMcp"]

function textResult(value: unknown, isError = false) {
  const part: { type: "text"; text: string } = { type: "text", text: JSON.stringify(value) }
  return { content: [part], isError }
}

export function registerAgentChatMcpRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.all("/mcp/agent-chat", tokenRoute, primaryReadsMiddleware, async (c) => {
    const requestId = c.get("requestId")
    const raw = c.req.raw
    const principal = await verifyMcpRequest(raw.headers, { ...getMcpResourceContext(raw, "agent", requestId), agentChatOnly: true })
    if (principal instanceof Response) return principal
    if (raw.method === "GET") return rejectStandaloneSseResponse()
    const preflight = await preflightMcpJsonRpcRequest(raw, requestId)
    if (preflight) return preflight
    const turnId = personalAgentChatTurnId(principal.scopes)
    if (!turnId) return c.json({ error: "forbidden" }, 403)
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const identity = await resolveMcpMemberIdentity(principal)
    const context = identity && await personalAgentChatDispatchContext(turnId, organizationId, identity.orgMembershipId, principal.userId)
    if (!identity || !context || context.paused) return c.json({ error: "personal_agent_chat_inactive" }, 403)
    const member = mcpMemberForToken(identity, principal.scopes)
    const scopes = principal.scopes
    const redirectUriBase = resolvePublicOrigin(raw, env.apiPublicUrl)
    const internalApp: InternalApp = app
    const [catalog, { features: organizationFeatures, organizationToolPermissions }] = await Promise.all([
      getCatalog<unknown>(internalApp, c.env),
      cachedOrganizationFeatureContext(organizationId, principal.userId),
    ])
    const capabilityContext = createCapabilityRegistryContext({
      app: internalApp,
      env: c.env,
      catalog,
      principal,
      organizationId,
      member,
      redirectUriBase,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationFeatures,
      organizationToolPermissions,
      audit: mcpAuditPrincipal({ organizationId, userId: principal.userId, memberId: member.orgMembershipId, credentialId: mcpPrincipalCredentialId(principal) }),
      usageSource: "agent",
      sourceKinds: AGENT_CHAT_SOURCES,
    })
    const server = new McpServer({ name: "openwork-agent-chat", version: "1.0.0" })
    server.registerTool("search_capabilities", {
      description: "Search the tools this agent can reach: OpenWork's own tools (its routines, memory and requests, and the person's OpenWork data) and the person's connected apps. A connector listed in offConnectors has no tools here until a person allows it; ask for it by exact name with request_agent_connector_access. Matches give the exact name, and pathParams, queryParams and bodySchema, or argumentsSchema and schemaDigest for a connected app.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).optional() }).strict(),
    }, async ({ query, limit }) => {
      const [found, off] = await Promise.all([
        searchCapabilityRegistry(capabilityContext, { query, limit: limit ?? 5 }),
        listRequestableAgentConnections(capabilityContext),
      ])
      return textResult({ matches: found.matches, ...(found.externalCoverageHint ? { hint: found.externalCoverageHint } : {}),
        offConnectors: off.map(({ name }) => name).slice(0, 100) })
    })
    server.registerTool("execute_capability", {
      description: "Call a tool by its exact name from search. For an OpenWork tool pass path, query and body as the match's pathParams, queryParams and bodySchema describe. For a connected app pass its arguments object as body and copy the schema digest. A tool that needs approval cannot run until a person approves it.",
      inputSchema: z.object({ name: z.string().min(1).max(400), schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
        path: z.record(z.string(), z.unknown()).optional(), query: z.record(z.string(), z.unknown()).optional(),
        arguments: z.record(z.string(), z.unknown()).optional(), body: z.record(z.string(), z.unknown()).optional() }).strict(),
    }, async ({ name, schemaDigest, path, query, arguments: args, body }) => {
      const result = await executeCapabilityWithBudget({
        capability: name,
        invoke: (): Promise<ExecuteCapabilityToolResult> => executeCapability(capabilityContext, {
          name, schemaDigest, path, query, body, ...(args === undefined ? {} : { arguments: args }),
        }),
      })
      return { ...result, isError: result.isError === true }
    })
    registerAgentConnectorRequestTool(server, { execution: { kind: "chat", id: turnId }, capabilityContext, member })
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
  })
}
