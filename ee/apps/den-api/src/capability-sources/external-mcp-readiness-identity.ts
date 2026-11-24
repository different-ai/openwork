import type { ConnectedAccountTable, ExternalMcpConnectionTable, ExternalMcpReadinessCheck } from "@openwork-ee/den-db/schema"

type Connection = typeof ExternalMcpConnectionTable.$inferSelect
type Account = typeof ConnectedAccountTable.$inferSelect
export type ReadinessIdentity = Pick<Connection, "url" | "authType" | "credentialMode" | "apiKeyAuthScheme" | "oauthConfiguration" | "oauthIssuerReviewRequiredAt" | "accessToken" | "apiKey" | "readinessCredentialBinding">
export type ReadinessAccountIdentity = Pick<Account, "accessToken" | "externalAccountId" | "readinessCredentialBinding">
export type VisibleReadiness = Pick<ExternalMcpReadinessCheck, "status" | "checkedAt" | "lastSuccessfulAt" | "reason"> & {
  failure: ExternalMcpReadinessCheck["failure"]
  referenceId?: string
  providerSettingsUrl?: string
}

function configurationIdentity(connection: ReadinessIdentity) {
  return [
    connection.url, connection.authType, connection.credentialMode, connection.apiKeyAuthScheme,
    connection.oauthConfiguration?.authorizationServerIssuer, connection.oauthConfiguration?.requestedScopes,
    connection.oauthConfiguration?.callbackMode, connection.oauthIssuerReviewRequiredAt,
    connection.oauthConfiguration?.manualOAuthEndpoints,
    ...(connection.oauthConfiguration?.requestSelectedScopesOnly === true ? ["selected-scopes-only"] : []),
  ]
}

export function fingerprintReadinessIdentity(connection: ReadinessIdentity, account?: ReadinessAccountIdentity | null) {
  const credentialIdentity = connection.credentialMode === "shared"
    ? [connection.authType === "apikey" ? Boolean(connection.apiKey) : Boolean(connection.accessToken), connection.readinessCredentialBinding]
    : [Boolean(account?.accessToken), account?.readinessCredentialBinding, account?.externalAccountId]
  return JSON.stringify([...configurationIdentity(connection), credentialIdentity])
}

export function fingerprintOrganizationReadinessIdentity(connection: ReadinessIdentity) {
  return JSON.stringify(["organization", ...configurationIdentity(connection)])
}

export function visibleReadiness(check: ExternalMcpReadinessCheck | null, fingerprint: string): VisibleReadiness | null {
  if (!check || check.fingerprint !== fingerprint) return null
  return {
    status: check.status,
    checkedAt: check.checkedAt,
    lastSuccessfulAt: check.lastSuccessfulAt,
    reason: check.reason,
    failure: check.failure ?? null,
    ...(check.referenceId ? { referenceId: check.referenceId } : {}),
    ...(check.providerSettingsUrl ? { providerSettingsUrl: check.providerSettingsUrl } : {}),
  }
}

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
