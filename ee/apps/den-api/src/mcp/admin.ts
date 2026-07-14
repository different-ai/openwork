import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import type { Hono } from "hono"
import { isPlatformAdminUserId } from "../middleware/admin.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { protectedResourceMetadata } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { DEN_ADMIN_MCP_VERSION, registerAdminMcpTools } from "./admin-tools.js"

/**
 * Streamable-HTTP MCP endpoint for the den-admin analytics toolset.
 *
 * Auth is two layers:
 * 1. The same bearer MCP tokens as /mcp (`verifyMcpRequest`), so the desktop
 *    app's first-party minted token works here with no extra setup.
 * 2. The platform-admin allowlist (`AdminAllowlistTable`) checked against the
 *    token's user — the same gate as /v1/admin/overview. Non-admins get 403.
 *
 * This intentionally does NOT reuse the /mcp OpenAPI tool catalog: admin
 * tools are hand-written read-only analytics (see ./admin-tools.ts), and the
 * /mcp exposure policy keeps blocking everything tagged Admin.
 */
export function registerAdminMcpRoutes<T extends { Variables: Record<string, unknown> }>(app: Hono<T>) {
  // OAuth protected-resource discovery for the admin endpoint. A spec-compliant
  // MCP client connecting to `<origin>/mcp/admin` may self-construct the
  // metadata URL (RFC 9728) instead of following the 401 WWW-Authenticate
  // header — the SDK requests `/.well-known/oauth-protected-resource/mcp/admin`
  // first. Serve the same metadata there so discovery resolves either way.
  // The metadata still declares the route's parent resource for first-party
  // desktop and legacy discovery. Public OAuth JWTs are scoped to /mcp/agent
  // only, so this route relies on first-party opaque MCP tokens and still
  // requires the platform-admin allowlist below.
  app.get("/.well-known/oauth-protected-resource/mcp/admin", publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "admin")))
  app.get("/mcp/admin/.well-known/oauth-protected-resource", publicRoute, (c) =>
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
    registerAdminMcpTools(server)

    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
}
