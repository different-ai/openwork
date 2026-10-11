import type { ConnectedAccountTable, ExternalMcpConnectionTable, ExternalMcpReadinessCheck } from "@openwork-ee/den-db/schema"

type Connection = typeof ExternalMcpConnectionTable.$inferSelect
type Account = typeof ConnectedAccountTable.$inferSelect
export type ReadinessIdentity = Pick<Connection, "url" | "authType" | "credentialMode" | "apiKeyAuthScheme" | "oauthConfiguration" | "oauthIssuerReviewRequiredAt" | "accessToken" | "apiKey" | "readinessCredentialBinding">
export type ReadinessAccountIdentity = Pick<Account, "accessToken" | "externalAccountId" | "readinessCredentialBinding">

export function fingerprintReadinessIdentity(connection: ReadinessIdentity, account?: ReadinessAccountIdentity | null) {
  // Only public configuration, credential presence and a random credential
  // revision are retained. No key/token material or password verifier is stored.
  // OAuth revisions change on re-authorization, not routine token refresh;
  // API-key revisions change atomically with key replacement, even while off.
  const credentialIdentity = connection.credentialMode === "shared"
    ? [connection.authType === "apikey" ? Boolean(connection.apiKey) : Boolean(connection.accessToken), connection.readinessCredentialBinding]
    : [Boolean(account?.accessToken), account?.readinessCredentialBinding, account?.externalAccountId]
  return JSON.stringify([
    connection.url, connection.authType, connection.credentialMode, connection.apiKeyAuthScheme,
    connection.oauthConfiguration?.authorizationServerIssuer, connection.oauthConfiguration?.requestedScopes,
    connection.oauthConfiguration?.callbackMode, connection.oauthIssuerReviewRequiredAt,
    credentialIdentity,
  ])
}

export function visibleReadiness(check: ExternalMcpReadinessCheck | null, fingerprint: string) {
  if (!check || check.fingerprint !== fingerprint) return null
  return { status: check.status, checkedAt: check.checkedAt, lastSuccessfulAt: check.lastSuccessfulAt, reason: check.reason }
}
