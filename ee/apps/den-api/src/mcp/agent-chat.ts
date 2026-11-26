import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/server"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { z } from "zod"
import { env } from "../env.js"
import { tokenRoute } from "../middleware/index.js"
import { listRequestablePersonalAgentConnections } from "../personal-agents/connector-access.js"
import { personalAgentChatDispatchContext } from "../personal-agents/permissions-dispatch.js"
import { primaryReadsMiddleware } from "../read-routing.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { registerAgentConnectorRequestTool } from "./agent-connector-request.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { executeExternalCapability, mcpMemberForToken, parseExternalCapabilityName, resolveMcpMemberIdentity, searchExternalCapabilities } from "./external-capabilities.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { rejectStandaloneSseResponse } from "./standalone-sse.js"
import { personalAgentChatTurnId } from "./workbot-turn-limits.js"

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
    const server = new McpServer({ name: "openwork-agent-chat", version: "1.0.0" })
    server.registerTool("search_capabilities", {
      description: "Search the external connector tools available to this agent. Off connectors have no tools until approved; request a connector by exact name when needed.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).optional() }).strict(),
    }, async ({ query, limit }) => {
      const [matches, off] = await Promise.all([
        searchExternalCapabilities({ organizationId, member, scopes, redirectUriBase, query, limit }),
        listRequestablePersonalAgentConnections({ organizationId, memberId: member.orgMembershipId, scopes }),
      ])
      return textResult({ matches, offConnectors: off.map(({ name }) => name).slice(0, 100) })
    })
    server.registerTool("execute_capability", {
      description: "Call an external connector tool by its exact name from search. Copy the schema digest and supply the connector's arguments. A tool that needs approval cannot run until a person approves it.",
      inputSchema: z.object({ name: z.string().min(1).max(400), schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
        arguments: z.record(z.string(), z.unknown()).optional(), body: z.record(z.string(), z.unknown()).optional() }).strict(),
    }, async ({ name, schemaDigest, arguments: args, body }) => {
      const capability = parseExternalCapabilityName(name)
      if (!capability) return textResult({ error: "forbidden", message: "Only tools from external connectors are available here." }, true)
      const result = await executeExternalCapability({ organizationId, member, scopes, ...capability, args: args ?? body,
        schemaDigest, redirectUriBase, usageSource: "agent" })
      return result.ok ? textResult({ result: result.result, schemaGuidance: result.schemaGuidance }, result.result.isError === true) : textResult(result, true)
    })
    registerAgentConnectorRequestTool(server, { organizationId, execution: { kind: "chat", id: turnId }, member, scopes, redirectUriBase })
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
  })
}
