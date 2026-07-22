/**
 * Kill switch for member-facing org MCP connections.
 *
 * Connect is default-on for every org. Platform admins can explicitly disable
 * the member-facing rail with `metadata.capabilities.mcpConnections: false`;
 * that backoffice capability outranks the historical flat aliases
 * (`metadata.mcpConnectionsEnabled` and `metadata.connectEnabled`). Admin
 * management (scope=manageable, create, access grants) stays available so orgs
 * can stage or repair connections while members see an empty list.
 *
 * DEN_MCP_CONNECTIONS_GATING_ENABLED is deprecated and inert. env.ts still
 * accepts it, and callers still pass `options.gatingEnabled`, so existing
 * deployment configs and call sites continue to work while this helper ignores
 * the deployment-level gate.
 */

type MetadataInput = Record<string, unknown> | string | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

export function memberFacingMcpConnectionsEnabled(
  metadata: MetadataInput,
  options: { gatingEnabled: boolean },
): boolean {
  const parsed = parseMetadata(metadata)
  const capabilities = isRecord(parsed.capabilities) ? parsed.capabilities : {}

  if (capabilities.mcpConnections === true) {
    return true
  }
  if (capabilities.mcpConnections === false) {
    return false
  }
  if (parsed.connectEnabled === true || parsed.mcpConnectionsEnabled === true) {
    return true
  }
  if (parsed.connectEnabled === false || parsed.mcpConnectionsEnabled === false) {
    return false
  }
  return true
}
