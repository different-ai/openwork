import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"

const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version"

export type McpProtocolVersionWarn = (message: string, fields: Record<string, string>) => void

export function normalizeMcpProtocolVersionHeader(
  headers: Headers,
  endpoint: string,
  referenceId: string,
  warn: McpProtocolVersionWarn,
) {
  const raw = headers.get(MCP_PROTOCOL_VERSION_HEADER)
  if (raw === null) {
    return
  }

  const distinct = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))]
  const single = distinct.length === 1 ? distinct[0] : null
  if (single !== undefined && single !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(single)) {
    if (single !== raw) {
      headers.set(MCP_PROTOCOL_VERSION_HEADER, single)
      warn("mcp protocol version header collapsed", {
        endpoint,
        reference_id: referenceId,
        protocol_version: single,
      })
    }
    return
  }

  headers.delete(MCP_PROTOCOL_VERSION_HEADER)
  warn("mcp protocol version unsupported", {
    endpoint,
    reference_id: referenceId,
    protocol_version: raw.slice(0, 128),
    supported_versions: SUPPORTED_PROTOCOL_VERSIONS.join(", "),
  })
}
