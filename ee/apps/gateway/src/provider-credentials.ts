// Resolve the upstream secret for a gateway provider (plan §4.3, decision #14).
// `credential_mode = org` → the `subject = "org"` row; `member` → the member's
// own row, never falling back to the org row. Member `oauth_google` tokens are
// refreshed under a lock near expiry (§5.5), `gcp_service_account` secrets are
// minted into a bearer (§5.6) and `aws_keys` are handed to the SigV4 signer.
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderCredentialTable, GatewayProviderTable } from "@openwork-ee/den-db"
import { isInferenceCredentialKindSupported, pickInferenceApiKeyFromMap as pickApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
export { pickInferenceApiKeyFromMap as pickApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
import { parseGatewayProviderSecret } from "@openwork/types/den/gateway"
import type { GatewayAwsKeysSecret, GatewayProviderCredentialKind } from "@openwork/types/den/gateway"
import type { MintGcpAccessToken } from "./credentials/gcp-service-account.js"
import { needsGoogleOauthRefresh } from "./credentials/google-oauth-refresh.js"
import type { RefreshGoogleOauthToken } from "./credentials/google-oauth-refresh.js"
import { loadGatewayAccessFromDb, sameGatewaySelection, selectGatewayGrant } from "./provider-access.js"
import type { GatewayAccessScope, GatewayGrantSelection } from "./provider-access.js"

export type GatewayProvider = Pick<
  typeof GatewayProviderTable.$inferSelect,
  "id" | "organization_id" | "provider_id" | "provider_config" | "settings" | "status"
>

export type GatewayCredential = Pick<
  typeof GatewayProviderCredentialTable.$inferSelect,
  "id" | "kind" | "secret" | "expires_at" | "status"
>

export type GatewayCredentialLookup = {
  scope: GatewayAccessScope
  selection: GatewayGrantSelection
  subject: string
}
export type LoadProviderCredential = (input: GatewayCredentialLookup) => Promise<GatewayCredential | null>

type CredentialId = GatewayCredential["id"]

type MaterializedCredential =
  | { kind: "secret"; credentialId: CredentialId; credentialKind: GatewayProviderCredentialKind; secret: string }
  | { kind: "aws_keys"; credentialId: CredentialId; credentialKind: "aws_keys"; awsKeys: GatewayAwsKeysSecret }
  | { kind: "auth_required"; credentialId: CredentialId | null; reason: "missing" | "expired" | "inactive" | "refresh_failed" }
  | { kind: "org_credential_missing" }
  | { kind: "org_credential_expired"; credentialId: CredentialId }
  | { kind: "invalid_secret"; credentialId: CredentialId; message: string }
  | { kind: "token_mint_failed"; credentialId: CredentialId; message: string }
  | { kind: "retry"; credentialId: CredentialId; reason: "refresh_busy" | "refresh_unavailable" | "credential_changed" }

export type ResolvedUpstreamCredential =
  | (Extract<MaterializedCredential, { kind: "secret" | "aws_keys" }> & { isCurrent: () => Promise<boolean> })
  | Exclude<MaterializedCredential, { kind: "secret" | "aws_keys" }>

export const ORG_CREDENTIAL_SUBJECT = "org"

function isExpired(credential: GatewayCredential, now: Date) {
  return credential.expires_at !== null && credential.expires_at.getTime() <= now.getTime()
}

function parseSecret(credential: GatewayCredential) {
  try {
    return parseGatewayProviderSecret(credential.kind, credential.secret)
  } catch {
    return { kind: "invalid_secret" as const, credentialId: credential.id, message: "Credential secret is invalid" }
  }
}

type ParsedSecret = Exclude<ReturnType<typeof parseSecret>, { kind: "invalid_secret" }>

async function materialize(
  credential: GatewayCredential,
  parsed: ParsedSecret,
  input: { envNames: string[]; now: Date; mintGcpAccessToken?: MintGcpAccessToken },
): Promise<MaterializedCredential> {
  switch (parsed.kind) {
    case "api_key":
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret: parsed.apiKey }
    case "api_key_map": {
      const secret = pickApiKeyFromMap(parsed.apiKeys, input.envNames)
      if (!secret) {
        return { kind: "invalid_secret", credentialId: credential.id, message: "api_key_map has no unambiguous trusted credential field" }
      }
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret }
    }
    case "oauth_google":
    case "oauth_azure":
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret: parsed.token.accessToken }
    case "aws_keys":
      return { kind: "aws_keys", credentialId: credential.id, credentialKind: parsed.kind, awsKeys: parsed.awsKeys }
    case "gcp_service_account": {
      if (!input.mintGcpAccessToken) {
        return { kind: "token_mint_failed", credentialId: credential.id, message: "service-account token minting is not configured" }
      }
      const minted = await input.mintGcpAccessToken({ credentialId: credential.id, serviceAccount: parsed.serviceAccount, now: input.now })
      if (minted.kind === "error") return { kind: "token_mint_failed", credentialId: credential.id, message: minted.message }
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret: minted.accessToken }
    }
  }
}

export async function resolveUpstreamCredential(input: {
  provider: GatewayProvider
  scope: GatewayAccessScope
  selection: GatewayGrantSelection
  /** From ProviderCatalog, not provider_config.env or member input. */
  envNames: string[]
  loadProviderCredential: LoadProviderCredential
  refreshGoogleOauthToken?: RefreshGoogleOauthToken
  mintGcpAccessToken?: MintGcpAccessToken
  now?: Date
}): Promise<ResolvedUpstreamCredential> {
  const now = input.now ?? new Date()
  const started = performance.now()
  const materializeInput = { envNames: input.envNames, now, mintGcpAccessToken: input.mintGcpAccessToken }
  const set = input.selection.row.credentialSet
  const subject = set.credential_mode === "member" ? input.scope.orgMembershipId : ORG_CREDENTIAL_SUBJECT
  const inactive = (credentialId: CredentialId | null): ResolvedUpstreamCredential => set.credential_mode === "member"
    ? { kind: "auth_required", credentialId, reason: "inactive" } : { kind: "org_credential_missing" }
  if (input.provider.status !== "active" || set.status !== "active") return inactive(null)
  const lookup = { scope: input.scope, selection: input.selection, subject }
  let credential = await input.loadProviderCredential(lookup)
  if (!credential) return set.credential_mode === "member" ? { kind: "auth_required", credentialId: null, reason: "missing" } : { kind: "org_credential_missing" }
  if (credential.status !== "active") return inactive(credential.id)
  let parsed = parseSecret(credential)
  if (parsed.kind === "invalid_secret") return parsed

  if (!isInferenceCredentialKindSupported(parsed.kind, input.provider.provider_id)) {
    return { kind: "invalid_secret", credentialId: credential.id, message: "Credential kind is not supported by this provider" }
  }

  if (set.credential_mode === "member" && parsed.kind === "oauth_google" && credential.kind === "oauth_google" && input.refreshGoogleOauthToken && needsGoogleOauthRefresh(credential, parsed.token, now)) {
    const outcome = await input.refreshGoogleOauthToken({ credential: { ...credential, kind: "oauth_google" }, token: parsed.token, provider: set, authorization: lookup, subject, now })
    if (outcome.kind === "auth_required") return { kind: "auth_required", credentialId: credential.id, reason: "refresh_failed" }
    if (outcome.kind === "refreshed") {
      credential = outcome.credential
      parsed = parseSecret(credential)
      if (parsed.kind === "invalid_secret") return parsed
    } else {
      return { ...outcome, credentialId: credential.id }
    }
  }

  if (isExpired(credential, now)) return set.credential_mode === "member"
    ? { kind: "auth_required", credentialId: credential.id, reason: "expired" }
    : { kind: "org_credential_expired", credentialId: credential.id }
  const result = await materialize(credential, parsed, materializeInput)
  // The minter's cache is not authorization. Recheck after mint/refresh/cache
  // awaits so concurrent revocation or replacement never returns that token.
  const snapshot = credential
  const isCurrent = async () => {
    const current = await input.loadProviderCredential(lookup)
    return current !== null && current.status === "active" && current.id === snapshot.id && current.kind === snapshot.kind
      && current.secret === snapshot.secret && current.expires_at?.getTime() === snapshot.expires_at?.getTime()
      && !isExpired(current, new Date(now.getTime() + Math.floor(performance.now() - started)))
  }
  if (!await isCurrent()) {
    return { kind: "retry", credentialId: credential.id, reason: "credential_changed" }
  }
  return result.kind === "secret" || result.kind === "aws_keys" ? { ...result, isCurrent } : result
}

export const loadProviderCredentialFromDb: LoadProviderCredential = async (input) => {
  const { db } = await import("./db.js")
  // Cache hits still require a live member, provider and grant. This runs both
  // before and after token work, including for a shared org credential.
  const authorized = selectGatewayGrant(await loadGatewayAccessFromDb(input.scope), input.selection.requestedModel, input.selection.row.grant.id)
  if (authorized.kind !== "selected" || !sameGatewaySelection(input.selection, authorized.selection)) return null
  const set = authorized.selection.row.credentialSet
  if (input.subject !== (set.credential_mode === "member" ? input.scope.orgMembershipId : ORG_CREDENTIAL_SUBJECT)) return null
  const table = GatewayProviderCredentialTable
  const [row] = await db
    .select({
      id: table.id,
      kind: table.kind,
      secret: table.secret,
      expires_at: table.expires_at,
      status: table.status,
    })
    .from(table)
    .where(and(
      eq(table.gateway_provider_id, input.scope.gatewayProviderId), eq(table.credential_set_id, set.id),
      eq(table.organization_id, input.scope.organizationId), eq(table.subject, input.subject),
      set.credential_mode === "member" ? eq(table.org_membership_id, input.scope.orgMembershipId) : isNull(table.org_membership_id),
    ))
    .limit(1)
  return row ?? null
}
