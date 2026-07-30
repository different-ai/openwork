export const DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 45 * 60

function accessTokenExpiresInSeconds() {
  if (process.env.OPENWORK_DEV_MODE?.trim() !== "1") return DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS

  const configured = process.env.DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS?.trim()
  if (!configured) return DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS

  const parsed = Number(configured)
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS) {
    throw new Error(`DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS must be a positive integer no greater than ${DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS}.`)
  }
  return parsed
}

export const DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS = accessTokenExpiresInSeconds()
// Refresh grants are rotating: every successful refresh revokes the old token
// and issues a new one with a fresh inactivity window. Thirty days keeps an
// occasionally used MCP connected without making access tokens long-lived.
export const DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60
// The first-party Cloud Control token is a bearer access token, not a rotating
// refresh grant. Keep its exposure window bounded; the desktop maintenance
// loop replaces it silently before expiry while OpenWork is in normal use.
export const DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
