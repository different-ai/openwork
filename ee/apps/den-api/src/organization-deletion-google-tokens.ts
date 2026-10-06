export const GOOGLE_WORKSPACE_PROVIDER_ID = "google-workspace"

export type ConnectedAccountTokens = {
  providerId: string
  tokenType: string | null
  accessToken: string | null
  refreshToken: string | null
}

/**
 * Google tokens to revoke for connected accounts deleted with an organization.
 * Google Workspace accounts are keyed by the legacy registry id or by the id of
 * a native Google Workspace connection. Personal API keys are not OAuth grants.
 * The refresh token is preferred because revoking it ends the whole grant.
 */
export function googleWorkspaceRevocationTokens(
  accounts: readonly ConnectedAccountTokens[],
  googleWorkspaceConnectionIds: readonly string[],
): string[] {
  const providerIds = new Set([GOOGLE_WORKSPACE_PROVIDER_ID, ...googleWorkspaceConnectionIds])
  const tokens = new Set<string>()
  for (const account of accounts) {
    if (!providerIds.has(account.providerId) || account.tokenType === "api_key") continue
    const token = account.refreshToken?.trim() || account.accessToken?.trim()
    if (token) tokens.add(token)
  }
  return [...tokens]
}
