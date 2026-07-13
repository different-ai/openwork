export const DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60
// Refresh grants are rotating: every successful refresh revokes the old token
// and issues a new one with a fresh inactivity window. Thirty days keeps an
// occasionally used MCP connected without making access tokens long-lived.
export const DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60
// The first-party Cloud Control token is a bearer access token, not a rotating
// refresh grant. Keep its exposure window bounded; the desktop maintenance
// loop replaces it silently before expiry while OpenWork is in normal use.
export const DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
