export const DEN_MCP_HEADLESS_RUN_CLIENT_ID = "openwork-headless-run"
export const DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS = 60 * 60 * 1000

export function isHeadlessRunMcpToken(payload: Record<string, unknown>, source: "jwt" | "opaque") {
  if (source !== "opaque" || payload.client_id !== DEN_MCP_HEADLESS_RUN_CLIENT_ID) return false
  if (payload.sid !== undefined) return false
  const { exp, iat } = payload
  if (typeof exp !== "number" || typeof iat !== "number") return false
  return exp > iat && (exp - iat) * 1000 <= DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS
}

export const DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM = "openwork_run_token_id"

export function headlessRunTokenId(payload: Record<string, unknown>): string | null {
  if (payload.client_id !== DEN_MCP_HEADLESS_RUN_CLIENT_ID) return null
  const value = payload[DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM]
  return typeof value === "string" && value ? value : null
}
