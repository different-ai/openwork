import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServer,
} from "@modelcontextprotocol/server"

/** The dual-era, sessionless HTTP entry used by the public agent MCP route. */
export function createAgentMcpHttpHandler(
  serverForRequest: (request: Request) => McpServer,
  onerror?: (error: Error) => void,
): McpHttpHandler {
  return createMcpHandler(({ requestInfo }) => {
    if (!requestInfo) throw new Error("Agent MCP HTTP transport requires request context.")
    return serverForRequest(requestInfo)
  }, {
    legacy: "stateless",
    onerror,
  })
}
