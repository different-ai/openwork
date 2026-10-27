import type { ConnectedAccountTable, ExternalMcpConnectionTable, ExternalMcpReadinessCheck } from "@openwork-ee/den-db/schema"

type Connection = typeof ExternalMcpConnectionTable.$inferSelect
type Account = typeof ConnectedAccountTable.$inferSelect
export type ReadinessIdentity = Pick<Connection, "url" | "authType" | "credentialMode" | "apiKeyAuthScheme" | "oauthConfiguration" | "oauthIssuerReviewRequiredAt" | "accessToken" | "apiKey" | "readinessCredentialBinding">
export type ReadinessAccountIdentity = Pick<Account, "accessToken" | "externalAccountId" | "readinessCredentialBinding">
export type VisibleReadiness = Pick<ExternalMcpReadinessCheck, "status" | "checkedAt" | "lastSuccessfulAt" | "reason"> & { failure: ExternalMcpReadinessCheck["failure"] }

function configurationIdentity(connection: ReadinessIdentity) {
  return [
    connection.url, connection.authType, connection.credentialMode, connection.apiKeyAuthScheme,
    connection.oauthConfiguration?.authorizationServerIssuer, connection.oauthConfiguration?.requestedScopes,
    connection.oauthConfiguration?.callbackMode, connection.oauthIssuerReviewRequiredAt,
    connection.oauthConfiguration?.manualOAuthEndpoints,
  ]
}

export function fingerprintReadinessIdentity(connection: ReadinessIdentity, account?: ReadinessAccountIdentity | null) {
  // Only public configuration, credential presence and a random credential
  // revision are retained. No key/token material or password verifier is stored.
  // OAuth revisions change on re-authorization, not routine token refresh;
  // API-key revisions change atomically with key replacement, even while off.
  const credentialIdentity = connection.credentialMode === "shared"
    ? [connection.authType === "apikey" ? Boolean(connection.apiKey) : Boolean(connection.accessToken), connection.readinessCredentialBinding]
    : [Boolean(account?.accessToken), account?.readinessCredentialBinding, account?.externalAccountId]
  return JSON.stringify([...configurationIdentity(connection), credentialIdentity])
}

/**
 * The organization-level identity of a per-member connection: its
 * configuration only. A member's Ready check is copied here so admins can see
 * the connector works without signing in themselves. It never makes another
 * member Ready; each member's own view keeps using their own fingerprint.
 */
export function fingerprintOrganizationReadinessIdentity(connection: ReadinessIdentity) {
  return JSON.stringify(["organization", ...configurationIdentity(connection)])
}

export function visibleReadiness(check: ExternalMcpReadinessCheck | null, fingerprint: string): VisibleReadiness | null {
  if (!check || check.fingerprint !== fingerprint) return null
  return { status: check.status, checkedAt: check.checkedAt, lastSuccessfulAt: check.lastSuccessfulAt, reason: check.reason, failure: check.failure ?? null }
}

/** The most recent Ready check among members' own checks that still match their current sign-in. */
export function latestMemberReady(
  connection: ReadinessIdentity,
  accounts: Array<ReadinessAccountIdentity & { readinessCheck: ExternalMcpReadinessCheck | null }>,
): VisibleReadiness | null {
  let latest: VisibleReadiness | null = null
  for (const account of accounts) {
    if (!account.accessToken) continue
    const visible = visibleReadiness(account.readinessCheck, fingerprintReadinessIdentity(connection, account))
    if (visible?.status !== "ready") continue
    if (!latest || Date.parse(visible.checkedAt) > Date.parse(latest.checkedAt)) latest = visible
  }
  return latest
}
