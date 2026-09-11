import { OpenworkServerError } from "./openwork-server"

const TRANSIENT_MCP_APP_RESOLUTION_CODES = new Set(["server_unavailable", "mcp_unreachable"])
const MCP_APP_RESOLUTION_RETRY_DELAYS_MS = [1_000, 3_000]

/** Retry discovery only, never the launch tool or a deterministic rejection. */
export function mcpAppResolutionRetryDelayMs(cause: unknown, attemptIndex: number): number | null {
  if (!(cause instanceof OpenworkServerError) || !TRANSIENT_MCP_APP_RESOLUTION_CODES.has(cause.code)) return null
  return MCP_APP_RESOLUTION_RETRY_DELAYS_MS[attemptIndex] ?? null
}
