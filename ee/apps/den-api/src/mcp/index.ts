import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../env.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { jsonResponse } from "../openapi.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { buildMcpCatalog, getToolDescription, loadOpenApiDocument, type CatalogApp, type McpToolOperation } from "./catalog.js"
import { filterMicrosoftGraphResources, filterPersonalAgents, filterTeamsMeetingTranscripts, limitedAgentRunMayCall } from "./catalog-availability.js"
import { isLimitedAgentRun } from "./workbot-turn-limits.js"
import { cachedOrganizationFeatureContext, cachedOrganizationFeatureEnabled } from "../features.js"
import { invokeMcpOperation } from "./invoke.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { appLogger } from "../observability/logger.js"
import { normalizeMcpProtocolVersionHeader } from "./protocol-version.js"
import { getDenAuthIssuer } from "./jwt-policy.js"
import { DEN_MCP_REQUESTED_SCOPES } from "./scopes.js"
import { SEARCH_CAPABILITIES_TOOL_NAME, searchCapabilities } from "./search.js"

const protocolVersionLogger = appLogger.child({ component: "mcp_protocol_version" })

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000

let catalogCache: { catalog: McpToolOperation[]; expiresAt: number } | null = null

export async function getCatalog<Bindings>(app: CatalogApp<Bindings>, env: Bindings) {
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.catalog
  }
  const document = await loadOpenApiDocument(app, env)
  const catalog = buildMcpCatalog(document)
  catalogCache = { catalog, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS }
  return catalog
}

const protectedResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
  scopes_supported: z.array(z.string()),
  bearer_methods_supported: z.array(z.string()),
}).meta({ ref: "OAuthProtectedResourceMetadata" })

export function protectedResourceMetadataRoute(route: "mcp" | "agent" | "admin") {
  return describeRoute({
    tags: ["OAuth"],
    security: [],
    summary: `Get OAuth protected resource metadata for /${route === "mcp" ? "mcp" : `mcp/${route}`}`,
    description: "Returns the RFC 9728 protected-resource metadata MCP clients use to discover the authorization server and scopes for this transport.",
    responses: { 200: jsonResponse("Protected resource metadata (RFC 9728).", protectedResourceMetadataSchema) },
  })
}

export function protectedResourceMetadata(request: Request, route: "mcp" | "agent" | "admin" = "mcp") {
  const resource = getMcpResourceContext(request, route).resourceUrl
  return {
    resource,
    authorization_servers: [getDenAuthIssuer(env.betterAuthUrl)],
    scopes_supported: [...DEN_MCP_REQUESTED_SCOPES],
    bearer_methods_supported: ["header"],
  }
}

export function registerMcpRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadataRoute("mcp"), publicRoute, (c) => c.json(protectedResourceMetadata(c.req.raw)))
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadataRoute("mcp"), publicRoute, (c) => c.json(protectedResourceMetadata(c.req.raw)))
  app.get("/mcp/.well-known/oauth-protected-resource", protectedResourceMetadataRoute("mcp"), publicRoute, (c) => c.json(protectedResourceMetadata(c.req.raw)))

  app.all("/mcp", tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await verifyMcpRequest(
      c.req.raw.headers,
      getMcpResourceContext(c.req.raw, "mcp", requestId),
    )
    if (principal instanceof Response) {
      return principal
    }

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) {
      return preflightResponse
    }

    normalizeMcpProtocolVersionHeader(c.req.raw.headers, "mcp", requestId, (message, fields) => {
      protocolVersionLogger.warn(message, fields)
    })

    const catalog = await getCatalog(app as unknown as Hono, c.env)
    const limitedAgentRun = isLimitedAgentRun(principal.scopes)
    const { features } = await cachedOrganizationFeatureContext(principal.organizationId, principal.userId)
    const offered = filterPersonalAgents(
      filterMicrosoftGraphResources(filterTeamsMeetingTranscripts(catalog, features.teamsMeetingTranscripts), features),
      await cachedOrganizationFeatureEnabled(principal.organizationId, "personalAgents", { userId: principal.userId }),
    ).filter((operation) => !limitedAgentRun || limitedAgentRunMayCall(operation))
    const server = new McpServer({
      name: "openwork-den-api",
      version: "1.0.0",
    })

    server.registerTool(
      SEARCH_CAPABILITIES_TOOL_NAME,
      {
        title: "Search capabilities",
        description: [
          "Search this catalog by keyword instead of browsing every tool at once.",
          "Returns the best-matching tool names with a short summary of each.",
          "Call the matched tool name directly via the normal tools/call protocol; this tool does not execute anything itself.",
        ].join(" "),
        inputSchema: z.object({
          query: z.string().min(1).describe("Keywords describing the capability you need, e.g. \"create organization\" or \"list workers\"."),
          limit: z.number().int().min(1).max(20).optional().describe("Max number of matches to return. Defaults to 5."),
        }),
      },
      async ({ query, limit }) => {
        const matches = searchCapabilities(offered, query, limit ?? 5)
        const text = matches.length > 0
          ? JSON.stringify({ matches }, null, 2)
          : JSON.stringify({ matches: [], hint: "No matches. Try broader or different keywords." }, null, 2)
        return { content: [{ type: "text" as const, text }] }
      },
    )

    for (const operation of offered) {
      server.registerTool(
        operation.name,
        {
          title: operation.operation.summary ?? operation.name,
          description: getToolDescription(operation),
          inputSchema: operation.inputSchema,
        },
        async (toolInput) => invokeMcpOperation({
          app: app as unknown as Hono,
          env: c.env,
          operation,
          principal,
          toolInput,
        }),
      )
    }

    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
}
