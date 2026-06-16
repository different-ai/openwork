import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { db } from "../db.js"
import { isAdminEmailAllowed } from "../middleware/admin.js"
import { tokenRoute } from "../middleware/index.js"
import { getMcpResourceUrl, verifyMcpRequest } from "./auth.js"
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
  app.all("/mcp/admin", tokenRoute, async (c) => {
    const principal = await verifyMcpRequest(c.req.raw.headers, getMcpResourceUrl(c.req.raw))
    if (principal instanceof Response) {
      return principal
    }

    let userId: ReturnType<typeof normalizeDenTypeId<"user">> | null = null
    try {
      userId = normalizeDenTypeId("user", principal.userId)
    } catch {
      userId = null
    }

    const user = userId
      ? (await db
          .select({ email: AuthUserTable.email })
          .from(AuthUserTable)
          .where(eq(AuthUserTable.id, userId))
          .limit(1))[0]
      : undefined

    if (!user || !(await isAdminEmailAllowed(user.email))) {
      return c.json({
        error: "admin_required",
        message: "The den-admin MCP is restricted to allowlisted platform admins.",
      }, 403)
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
