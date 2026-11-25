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
export const DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60
export const DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEN_MCP_OAUTH_AUTHORIZATION_EXPIRES_IN_SECONDS = 30 * 60
