import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import type { Hono } from "hono"
import { isPlatformAdminUserId } from "../middleware/admin.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { getMcpResourceContext, mcpPrincipalCredentialId, verifyMcpRequest } from "./auth.js"
import { protectedResourceMetadata, protectedResourceMetadataRoute } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { DEN_ADMIN_MCP_VERSION, registerAdminMcpTools } from "./admin-tools.js"

export function registerAdminMcpRoutes<T extends { Variables: Record<string, unknown> }>(app: Hono<T>) {
  app.get("/.well-known/oauth-protected-resource/mcp/admin", protectedResourceMetadataRoute("admin"), publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "admin")))
  app.get("/mcp/admin/.well-known/oauth-protected-resource", protectedResourceMetadataRoute("admin"), publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "admin")))

  app.all("/mcp/admin", tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await verifyMcpRequest(
      c.req.raw.headers,
      getMcpResourceContext(c.req.raw, "admin", requestId),
    )
    if (principal instanceof Response) {
      return principal
    }

    if (!(await isPlatformAdminUserId(principal.userId))) {
      return c.json({
        error: "admin_required",
        message: "The den-admin MCP is restricted to allowlisted platform admins.",
      }, 403)
    }

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) {
      return preflightResponse
    }

    const server = new McpServer({
      name: "den-admin",
      version: DEN_ADMIN_MCP_VERSION,
    })
    registerAdminMcpTools(server, { userId: principal.userId, credentialId: mcpPrincipalCredentialId(principal), scopes: principal.scopes })

    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
}
