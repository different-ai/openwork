import { createHmac } from "node:crypto"
import type { ConnectedAccountTable, ExternalMcpConnectionTable, ExternalMcpReadinessCheck } from "@openwork-ee/den-db/schema"

type Connection = typeof ExternalMcpConnectionTable.$inferSelect
type Account = typeof ConnectedAccountTable.$inferSelect
export type ReadinessIdentity = Pick<Connection, "url" | "authType" | "credentialMode" | "apiKeyAuthScheme" | "oauthConfiguration" | "oauthIssuerReviewRequiredAt" | "accessToken" | "apiKey" | "readinessCredentialBinding">
export type ReadinessAccountIdentity = Pick<Account, "accessToken" | "externalAccountId" | "readinessCredentialBinding">

export function fingerprintReadinessIdentity(connection: ReadinessIdentity, secret: string, account?: ReadinessAccountIdentity | null) {
  // OAuth tokens rotate within one grant. A separate grant binding survives
  // refresh, but changes when a person authorizes again (including while off).
  const credentialIdentity = connection.authType === "oauth"
    ? connection.credentialMode === "shared"
      ? [Boolean(connection.accessToken), connection.readinessCredentialBinding]
      : [Boolean(account?.accessToken), account?.readinessCredentialBinding, account?.externalAccountId]
    : connection.credentialMode === "shared" ? connection.apiKey : account?.accessToken
  // A database-only reader must not be able to test guesses of a personal key.
  return createHmac("sha256", secret).update(JSON.stringify([
    connection.url, connection.authType, connection.credentialMode, connection.apiKeyAuthScheme,
    connection.oauthConfiguration?.authorizationServerIssuer, connection.oauthConfiguration?.requestedScopes,
    connection.oauthConfiguration?.callbackMode, connection.oauthIssuerReviewRequiredAt,
    credentialIdentity,
  ])).digest("hex")
}

export function visibleReadiness(check: ExternalMcpReadinessCheck | null, fingerprint: string) {
  if (!check || check.fingerprint !== fingerprint) return null
  return { status: check.status, checkedAt: check.checkedAt, lastSuccessfulAt: check.lastSuccessfulAt, reason: check.reason }
}
