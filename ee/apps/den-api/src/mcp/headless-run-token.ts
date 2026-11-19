/**
 * Short-lived opaque MCP tokens that Den mints for one headless run (for
 * example a Slack assistant turn answered by the headless runner) on behalf of
 * a member. They have no login session or OAuth grant behind them, so their
 * liveness is bounded by time: the row must still exist (deleting it revokes
 * the token), the whole lifetime must fit DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS,
 * and verifyMcpRequest still checks active organization membership on every
 * request. A token is never extended: a run longer than its lifetime gets a
 * freshly minted one each time the headless runner pauses it between steps
 * (`credentials_refresh`) and the Slack worker resumes it.
 */
export const DEN_MCP_HEADLESS_RUN_CLIENT_ID = "openwork-headless-run"
export const DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS = 60 * 60 * 1000

export function isHeadlessRunMcpToken(payload: Record<string, unknown>, source: "jwt" | "opaque") {
  if (source !== "opaque" || payload.client_id !== DEN_MCP_HEADLESS_RUN_CLIENT_ID) return false
  if (payload.sid !== undefined) return false
  const { exp, iat } = payload
  if (typeof exp !== "number" || typeof iat !== "number") return false
  return exp > iat && (exp - iat) * 1000 <= DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS
}

/**
 * The token row id of a headless-run token. Only Den's opaque-token
 * verification sets it, from the database row, so it cannot be supplied by a
 * caller; consumers still re-check the row before trusting what it links to.
 */
export const DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM = "openwork_run_token_id"

export function headlessRunTokenId(payload: Record<string, unknown>): string | null {
  if (payload.client_id !== DEN_MCP_HEADLESS_RUN_CLIENT_ID) return null
  const value = payload[DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM]
  return typeof value === "string" && value ? value : null
}
