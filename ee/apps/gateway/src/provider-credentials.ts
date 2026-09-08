// Resolve the upstream secret for a gateway provider (plan §4.3, decision #14).
// `credential_mode = org` → the `subject = "org"` row; `member` → the member's
// own row, never falling back to the org row. Member `oauth_google` tokens are
// refreshed under a lock near expiry (§5.5), `gcp_service_account` secrets are
// minted into a bearer (§5.6) and `aws_keys` are handed to the SigV4 signer.
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { InferenceProviderCredentialTable, InferenceProviderTable, MemberTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { isInferenceCredentialKindSupported, pickInferenceApiKeyFromMap as pickApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
export { pickInferenceApiKeyFromMap as pickApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
import { parseInferenceProviderSecret } from "@openwork/types/den/inference"
import type { InferenceAwsKeysSecret, InferenceProviderCredentialKind } from "@openwork/types/den/inference"
import type { MintGcpAccessToken } from "./credentials/gcp-service-account.js"
import { needsGoogleOauthRefresh } from "./credentials/google-oauth-refresh.js"
import type { RefreshGoogleOauthToken } from "./credentials/google-oauth-refresh.js"
import { hasProviderAccessFromDb } from "./provider-access.js"

export type GatewayProvider = Pick<
  typeof InferenceProviderTable.$inferSelect,
  "id" | "organization_id" | "provider_id" | "provider_config" | "settings" | "credential_mode" | "status" | "oauth_client_id" | "oauth_client_secret"
>

export type GatewayCredential = Pick<
  typeof InferenceProviderCredentialTable.$inferSelect,
  "id" | "kind" | "secret" | "expires_at" | "status"
>

export type LoadProviderCredential = (input: {
  inferenceProviderId: string
  subject: string
  orgMembershipId: string
}) => Promise<GatewayCredential | null>

type CredentialId = GatewayCredential["id"]

export type ResolvedUpstreamCredential =
  | { kind: "secret"; credentialId: CredentialId; credentialKind: InferenceProviderCredentialKind; secret: string }
  | { kind: "aws_keys"; credentialId: CredentialId; credentialKind: "aws_keys"; awsKeys: InferenceAwsKeysSecret }
  | { kind: "auth_required"; credentialId: CredentialId | null; reason: "missing" | "expired" | "inactive" | "refresh_failed" }
  | { kind: "org_credential_missing" }
  | { kind: "org_credential_expired"; credentialId: CredentialId }
  | { kind: "invalid_secret"; credentialId: CredentialId; message: string }
  | { kind: "token_mint_failed"; credentialId: CredentialId; message: string }
  | { kind: "retry"; credentialId: CredentialId; reason: "refresh_busy" | "refresh_unavailable" | "credential_changed" }

export const ORG_CREDENTIAL_SUBJECT = "org"

function isExpired(credential: GatewayCredential, now: Date) {
  return credential.expires_at !== null && credential.expires_at.getTime() <= now.getTime()
}

function parseSecret(credential: GatewayCredential) {
  try {
    return parseInferenceProviderSecret(credential.kind, credential.secret)
  } catch {
    return { kind: "invalid_secret" as const, credentialId: credential.id, message: "Credential secret is invalid" }
  }
}

type ParsedSecret = Exclude<ReturnType<typeof parseSecret>, { kind: "invalid_secret" }>

async function materialize(
  credential: GatewayCredential,
  parsed: ParsedSecret,
  input: { envNames: string[]; now: Date; mintGcpAccessToken?: MintGcpAccessToken },
): Promise<ResolvedUpstreamCredential> {
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
  orgMembershipId: string
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
  const subject = input.provider.credential_mode === "member" ? input.orgMembershipId : ORG_CREDENTIAL_SUBJECT
  const inactive = (credentialId: CredentialId | null): ResolvedUpstreamCredential => input.provider.credential_mode === "member"
    ? { kind: "auth_required", credentialId, reason: "inactive" } : { kind: "org_credential_missing" }
  if (input.provider.status !== "active") return inactive(null)
  const lookup = { inferenceProviderId: input.provider.id, subject, orgMembershipId: input.orgMembershipId }
  let credential = await input.loadProviderCredential(lookup)
  if (!credential) return input.provider.credential_mode === "member" ? { kind: "auth_required", credentialId: null, reason: "missing" } : { kind: "org_credential_missing" }
  if (credential.status !== "active") return inactive(credential.id)
  let parsed = parseSecret(credential)
  if (parsed.kind === "invalid_secret") return parsed

  if (!isInferenceCredentialKindSupported(parsed.kind, input.provider.provider_id)) {
    return { kind: "invalid_secret", credentialId: credential.id, message: "Credential kind is not supported by this provider" }
  }

  if (input.provider.credential_mode === "member" && parsed.kind === "oauth_google" && credential.kind === "oauth_google" && input.refreshGoogleOauthToken && needsGoogleOauthRefresh(credential, parsed.token, now)) {
    const outcome = await input.refreshGoogleOauthToken({ credential: { ...credential, kind: "oauth_google" }, token: parsed.token, provider: input.provider, subject, now })
    if (outcome.kind === "auth_required") return { kind: "auth_required", credentialId: credential.id, reason: "refresh_failed" }
    if (outcome.kind === "refreshed") {
      credential = outcome.credential
      parsed = parseSecret(credential)
      if (parsed.kind === "invalid_secret") return parsed
    } else {
      return { ...outcome, credentialId: credential.id }
    }
  }

  if (isExpired(credential, now)) return input.provider.credential_mode === "member"
    ? { kind: "auth_required", credentialId: credential.id, reason: "expired" }
    : { kind: "org_credential_expired", credentialId: credential.id }
  const result = await materialize(credential, parsed, materializeInput)
  // The minter's cache is not authorization. Recheck after mint/refresh/cache
  // awaits so concurrent revocation or replacement never returns that token.
  const current = await input.loadProviderCredential(lookup)
  if (!current || current.status !== "active") return inactive(credential.id)
  if (current.id !== credential.id || current.kind !== credential.kind || current.secret !== credential.secret
    || current.expires_at?.getTime() !== credential.expires_at?.getTime()) {
    return { kind: "retry", credentialId: credential.id, reason: "credential_changed" }
  }
  if (isExpired(current, new Date(now.getTime() + Math.floor(performance.now() - started)))) {
    return { kind: "retry", credentialId: credential.id, reason: "credential_changed" }
  }
  return result
}

export const loadProviderCredentialFromDb: LoadProviderCredential = async (input) => {
  const { db } = await import("./db.js")
  // Cache hits still require a live member, provider and grant. This runs both
  // before and after token work, including for a shared org credential.
  const [authorized] = await db.select({ organizationId: MemberTable.organizationId, mode: InferenceProviderTable.credential_mode }).from(MemberTable)
    .innerJoin(InferenceProviderTable, eq(InferenceProviderTable.organization_id, MemberTable.organizationId))
    .where(and(eq(MemberTable.id, normalizeDenTypeId("member", input.orgMembershipId)), isNull(MemberTable.removedAt), isNotNull(MemberTable.userId),
      eq(InferenceProviderTable.id, normalizeDenTypeId("inferenceProvider", input.inferenceProviderId)), eq(InferenceProviderTable.status, "active")))
    .limit(1)
  if (!authorized || !(await hasProviderAccessFromDb(input))) return null
  if (input.subject !== (authorized.mode === "member" ? input.orgMembershipId : ORG_CREDENTIAL_SUBJECT)) return null
  const [row] = await db
    .select({
      id: InferenceProviderCredentialTable.id,
      kind: InferenceProviderCredentialTable.kind,
      secret: InferenceProviderCredentialTable.secret,
      expires_at: InferenceProviderCredentialTable.expires_at,
      status: InferenceProviderCredentialTable.status,
    })
    .from(InferenceProviderCredentialTable)
    .where(and(
      eq(InferenceProviderCredentialTable.inference_provider_id, normalizeDenTypeId("inferenceProvider", input.inferenceProviderId)),
      eq(InferenceProviderCredentialTable.organization_id, authorized.organizationId),
      eq(InferenceProviderCredentialTable.subject, input.subject),
    ))
    .limit(1)
  return row ?? null
}
