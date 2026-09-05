import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"

const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version"

// Callers inject their structured logger; this module stays free of the
// observability import chain so focused runtime tests can load it without
// building workspace packages.
export type McpProtocolVersionWarn = (message: string, fields: Record<string, string>) => void

/**
 * The pinned MCP SDK rejects any `mcp-protocol-version` value outside its
 * supported list with a thrown JSON-RPC 404, which breaks clients that
 * negotiated a newer spec revision (observed in production with claude.ai's
 * connector) or whose proxies duplicate the header into a comma-joined value.
 *
 * Den's MCP endpoints are stateless per request, so instead of failing the
 * request:
 * - identical duplicated copies of a supported version collapse to that value,
 * - unknown values are removed so the transport falls back to the SDK default,
 *   and the observed value is logged so support can be added deliberately.
 */
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
