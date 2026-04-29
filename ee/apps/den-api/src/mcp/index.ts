import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import type { Hono } from "hono"
import { getMcpResourceUrl, verifyMcpRequest } from "./auth.js"
import { buildMcpCatalog, getToolDescription, loadOpenApiDocument } from "./catalog.js"
import { invokeMcpOperation } from "./invoke.js"

function protectedResourceMetadata(request: Request) {
  const resource = getMcpResourceUrl(request)
  return {
    resource,
    authorization_servers: [resource.replace(/\/mcp$/, "/api/auth")],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
  }
}

export function registerMcpRoutes<T extends { Variables: Record<string, unknown> }>(app: Hono<T>) {
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(c.req.raw)))
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(c.req.raw)))
  app.get("/mcp/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(c.req.raw)))

  app.all("/mcp", async (c) => {
    const principal = await verifyMcpRequest(c.req.raw.headers, getMcpResourceUrl(c.req.raw))
    if (principal instanceof Response) {
      return principal
    }

    const document = await loadOpenApiDocument(app as unknown as Hono, c.env)
    const catalog = buildMcpCatalog(document)
    const server = new McpServer({
      name: "openwork-den-api",
      version: "1.0.0",
    })

    for (const operation of catalog) {
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
