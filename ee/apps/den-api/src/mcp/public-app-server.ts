import { StreamableHTTPTransport } from "@hono/mcp"
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { MCP_APP_LAUNCH_TOOL_NAME, mcpAppPublicPath } from "@openwork/types/mcp-app"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { RequestIdVariables } from "hono/request-id"
import { loadPublicMcpApp } from "../mcp-apps.js"
import { publicRoute } from "../middleware/index.js"
import { createMcpAppServer } from "./app-server.js"
import { appSiteResponse, NO_INDEX, wantsAppSite } from "./app-site.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { DEN_MCP_READ_SCOPE } from "./scopes.js"

/** Where an App marked public is served, by its App id or its friendly name. It needs no sign-in, unlike every /mcp/agent path. */
export const PUBLIC_MCP_APP_ROUTE = "/mcp/public/apps/:appIdOrName"

/** MCP requests to a public App are a few hundred bytes; anything far larger is refused unread. */
const MAX_REQUEST_BYTES = 64 * 1024
const PUBLIC_READ_SCOPES: ReadonlySet<string> = new Set([DEN_MCP_READ_SCOPE])
const UNAVAILABLE = "This App is not available."

function jsonRpcError(id: string | number | null, message: string, error: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCode.InvalidRequest, message, data: { error } } }), {
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

/**
 * Serves an App its editor marked public, to anyone, without sign-in: its
 * current revision and open_app, nothing else. No OAuth challenge or
 * protected-resource metadata is sent, so MCP clients connect without asking
 * anyone to sign in. Every refusal reads the same, so it says nothing about
 * which Apps exist.
 */
export function registerPublicMcpAppRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.all(
    PUBLIC_MCP_APP_ROUTE,
    publicRoute,
    // Every answer at a public App's URL, page or not, stays out of search results.
    async (c, next) => {
      await next()
      c.header("x-robots-tag", NO_INDEX)
    },
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: () => jsonRpcError(null, "The request is too large.", "request_too_large", 413),
    }),
    async (c) => {
      const request = c.req.raw
      // A browser gets the App as a page when its author made it a site.
      if (wantsAppSite(request)) {
        const page = await appSiteResponse({ appIdOrName: c.req.param("appIdOrName"), publicOnly: true })
        if (page) return page
      }
      if (c.req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })

      const requestIdValue = c.get("requestId")
      const preflight = await preflightMcpJsonRpcRequest(request, typeof requestIdValue === "string" ? requestIdValue : "unknown")
      if (preflight) return preflight

      const appIdOrName = c.req.param("appIdOrName")
      const resource = await loadPublicMcpApp({ appIdOrName })
      if (!resource) return jsonRpcError(await requestId(request), UNAVAILABLE, "public_app_unavailable")

      const served = { ...resource.app, serverPath: mcpAppPublicPath(appIdOrName), tools: [] }
      const server = createMcpAppServer({
        definition: { app: served, tools: [] },
        scopes: PUBLIC_READ_SCOPES,
        // Only the revision checked above is served.
        loadResource: async (revision) => {
          if (revision.appId !== served.appId || revision.revisionId !== served.revisionId) throw new Error("revision_not_public")
          return { ...resource, app: served }
        },
        callTool: async () => ({ isError: true, content: [{ type: "text", text: UNAVAILABLE }] }),
        instructions: `This is the ${served.title} App, published from OpenWork. Call ${MCP_APP_LAUNCH_TOOL_NAME} to open it. It needs no sign-in and has no other tools.`,
      })
      const transport = new StreamableHTTPTransport()
      await server.connect(transport)
      return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
    },
  )
}
