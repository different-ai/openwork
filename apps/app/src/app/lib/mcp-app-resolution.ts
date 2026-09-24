import { OpenworkServerError } from "./openwork-server"

// Catalog discovery can fail while OpenWork Connect is still warming up; that
// is not evidence the connection or the App is gone.
const TRANSIENT_MCP_APP_RESOLUTION_CODES = new Set(["server_unavailable", "mcp_unreachable", "connect_catalog_discovery_unavailable"])
const MCP_APP_RESOLUTION_RETRY_DELAYS_MS = [1_000, 3_000]

/** Retry discovery only, never the launch tool or a deterministic rejection.
 * In particular, mcp_auth_required and mcp_access_denied require human action. */
export function mcpAppResolutionRetryDelayMs(cause: unknown, attemptIndex: number): number | null {
  if (!(cause instanceof OpenworkServerError) || !TRANSIENT_MCP_APP_RESOLUTION_CODES.has(cause.code)) return null
  return MCP_APP_RESOLUTION_RETRY_DELAYS_MS[attemptIndex] ?? null
}
