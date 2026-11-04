import { StreamableHTTPTransport } from "@hono/mcp"
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { MCP_APP_LAUNCH_TOOL_NAME } from "@openwork/types/mcp-app"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { RequestIdVariables } from "hono/request-id"
import { publicRoute } from "../middleware/index.js"
import { isPublicAppSlug, loadPublicMcpApp, PUBLIC_MCP_APP_ROUTE, publicMcpAppPath, type PublicMcpAppRefusal } from "../public-mcp-apps.js"
import { createMcpAppServer } from "./app-server.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { DEN_MCP_READ_SCOPE } from "./scopes.js"

/** MCP requests to a public App are a few hundred bytes; anything far larger is refused unread. */
const MAX_REQUEST_BYTES = 64 * 1024
const PUBLIC_READ_SCOPES: ReadonlySet<string> = new Set([DEN_MCP_READ_SCOPE])
const UNAVAILABLE = "This App is not available."

function jsonRpcError(id: string | number | null, message: string, data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCode.InvalidRequest, message, data } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function requestId(request: Request): Promise<string | number | null> {
  try {
    const body: unknown = await request.clone().json()
    if (typeof body === "object" && body !== null && "id" in body && (typeof body.id === "string" || typeof body.id === "number")) return body.id
  } catch {
    // Preflight already refused malformed JSON.
  }
  return null
}

/** Every refusal reads the same to a visitor, so it reveals nothing about the organization. */
async function refuse(request: Request, reason: PublicMcpAppRefusal, organizationId?: string): Promise<Response> {
  if (organizationId) console.warn("public_mcp_app_refused", { reason, organizationId })
  return jsonRpcError(await requestId(request), UNAVAILABLE, { error: "public_app_unavailable" })
}

/**
 * Serves an App an owner or admin published, to anyone, without sign-in: the
 * revision pinned at publishing, and no tools besides open_app. No OAuth
 * challenge or protected-resource metadata is sent, so MCP clients connect
 * without asking anyone to sign in.
 */
export function registerPublicMcpAppRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.all(
    PUBLIC_MCP_APP_ROUTE,
    publicRoute,
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: () => jsonRpcError(null, "The request is too large.", { error: "request_too_large" }, 413),
    }),
    async (c) => {
      const request = c.req.raw
      if (c.req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })

      const slug = c.req.param("slug")
      if (!isPublicAppSlug(slug)) return refuse(request, "not_found")

      const requestIdValue = c.get("requestId")
      const preflight = await preflightMcpJsonRpcRequest(request, typeof requestIdValue === "string" ? requestIdValue : "unknown")
      if (preflight) return preflight

      const loaded = await loadPublicMcpApp(slug)
      if (!loaded.ok) return refuse(request, loaded.reason, loaded.organizationId)

      const { resource } = loaded
      const served = { ...resource.app, serverPath: publicMcpAppPath(loaded.slug), tools: [] }
      const server = createMcpAppServer({
        definition: { app: served, tools: [] },
        scopes: PUBLIC_READ_SCOPES,
        // Only the pinned revision is served; any other revision id is refused.
        loadResource: async (revision) => {
          if (revision.appId !== served.appId || revision.revisionId !== served.revisionId) throw new Error("revision_not_published")
          return { ...resource, app: served }
        },
        callTool: async () => ({ isError: true, content: [{ type: "text", text: UNAVAILABLE }] }),
        instructions: `This is the ${served.title} App, published from OpenWork. Call ${MCP_APP_LAUNCH_TOOL_NAME} to open it. It needs no sign-in and runs no other tools.`,
      })
      const transport = new StreamableHTTPTransport()
      await server.connect(transport)
      return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
    },
  )
}
