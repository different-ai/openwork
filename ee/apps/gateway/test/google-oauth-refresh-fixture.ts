import type { GoogleOauthRefreshStore, OauthCredentialRow, RefreshScope, RefreshLock } from "../src/credentials/google-oauth-refresh.js"
import type { GatewayCredentialLookup, GatewayProvider } from "../src/provider-credentials.js"
import type { GatewayAccessRow } from "../src/provider-access.js"

export const now = new Date("2026-09-07T12:00:00Z")
export const provider: GatewayProvider = {
  id: "ipr_fixture", organization_id: "org_fixture", provider_id: "google-vertex",
  provider_config: {}, settings: {}, status: "active",
}
export const credentialSet: GatewayAccessRow["credentialSet"] = {
  id: "gcs_00000000000000000000000001", gateway_provider_id: provider.id, name: "Member tokens", credential_mode: "member", status: "active",
  oauth_client_id: "client-id", oauth_client_secret: "client-secret", created_at: now, updated_at: now,
}
export function matrixRow(overrides: Partial<GatewayAccessRow> = {}): GatewayAccessRow {
  return {
    grant: { id: "ipa_00000000000000000000000001", gateway_provider_id: provider.id, model_group_id: "gmg_00000000000000000000000001",
      credential_set_id: credentialSet.id, audience_key: "member:om_fixture", org_membership_id: "om_fixture", team_id: null, created_at: now },
    group: { id: "gmg_00000000000000000000000001", gateway_provider_id: provider.id, name: "Configured models", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { ...credentialSet },
    model: { id: "ipm_00000000000000000000000001", gateway_provider_id: provider.id, model_id: "gemini", name: "Gemini", model_config: {}, created_at: now },
    ...overrides,
  }
}
export function authorization(credential = row()): GatewayCredentialLookup {
  if (credential.org_membership_id === null) throw new Error("Member credential required")
  return {
    scope: { kind: "gateway", gatewayProviderId: credential.gateway_provider_id, organizationId: credential.organization_id,
      orgMembershipId: credential.org_membership_id, gatewayKeyId: "gky_00000000000000000000000001" },
    selection: { row: matrixRow(), requestedModel: "gemini", upstreamModel: "gemini" }, subject: credential.subject,
  }
}
export function row(overrides: Partial<OauthCredentialRow> = {}): OauthCredentialRow {
  return {
    id: "ipc_fixture", gateway_provider_id: provider.id, credential_set_id: credentialSet.id, organization_id: provider.organization_id,
    subject: "om_fixture", org_membership_id: "om_fixture", kind: "oauth_google",
    secret: JSON.stringify({ accessToken: "old", refreshToken: "rt-1" }),
    secret_revision: "ciphertext-revision-1",
    expires_at: new Date(now.getTime() - 1), status: "active", updated_at: now,
    refreshing_until: null, last_refreshed_at: null, ...overrides,
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
export function memoryStore(initial = row()) {
  const state: { row: OauthCredentialRow | null; lastError: string | null; client: typeof credentialSet; saves: number; failures: number } = {
    row: structuredClone(initial), lastError: null, client: { ...credentialSet }, saves: 0, failures: 0,
  }
  const authorized = (scope: RefreshScope) => state.row && state.client.status === "active"
    && state.client.oauth_client_id === scope.provider.oauth_client_id && state.client.oauth_client_secret === scope.provider.oauth_client_secret
    && state.row.id === scope.credentialId && state.row.gateway_provider_id === scope.authorization.scope.gatewayProviderId
    && state.row.credential_set_id === scope.provider.id && state.client.id === scope.provider.id
    && state.row.subject === scope.subject && state.row.org_membership_id === scope.subject
  // Independent witness for exact CAS state. Never import the product comparator.
  const owns = (lock: RefreshLock) => authorized(lock.scope) && state.row?.status === "active"
    && JSON.stringify(state.row) === JSON.stringify(lock.credential)
  const bump = (at: Date) => {
    if (state.row) state.row.updated_at = new Date(Math.max(state.row.updated_at.getTime() + 1, at.getTime()))
  }
  const store: GoogleOauthRefreshStore = {
    async reloadCredential(scope) { return authorized(scope) ? structuredClone(state.row) : null },
    async tryAcquireRefreshLock(input) {
      if (!authorized(input.scope) || !state.row || state.row.status !== "active"
        || JSON.stringify(state.row) !== JSON.stringify(input.credential)
        || (state.row.refreshing_until && state.row.refreshing_until >= input.now)) return null
      state.row.refreshing_until = input.until
      bump(input.now)
      return { scope: input.scope, credential: structuredClone(state.row) }
    },
    async saveRefreshedToken(input) {
      if (!owns(input.lock) || !state.row?.refreshing_until || state.row.refreshing_until <= input.now) return false
      state.saves++
      state.row.secret = input.secret
      state.row.secret_revision = `ciphertext-refresh-${state.saves}`
      state.row.expires_at = input.expiresAt
      state.row.refreshing_until = null
      state.row.last_refreshed_at = input.now
      state.lastError = null
      bump(input.now)
      return true
    },
    async recordRefreshFailure(input) {
      if (!owns(input.lock) || !state.row?.refreshing_until || state.row.refreshing_until <= input.now) return false
      state.failures++
      state.lastError = input.error
      state.row.refreshing_until = null
      if (input.permanent) state.row.status = "refresh_failed"
      bump(input.now)
      return true
    },
  }
  return { state, store }
}
export function refreshInput(credential = row()) {
  return { credential, token: { accessToken: "old", refreshToken: "rt-1" }, provider: credentialSet, authorization: authorization(credential), subject: credential.subject, now }
}
