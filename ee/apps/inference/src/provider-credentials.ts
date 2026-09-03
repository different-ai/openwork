// Resolve the upstream secret for a gateway provider (plan §4.3, decision #14).
// `credential_mode = org` → the `subject = "org"` row; `member` → the member's
// own row, never falling back to the org row. Member `oauth_google` tokens are
// refreshed under a lock near expiry (§5.5), `gcp_service_account` secrets are
// minted into a bearer (§5.6) and `aws_keys` are handed to the SigV4 signer.
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { InferenceProviderCredentialTable, InferenceProviderTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { parseInferenceProviderSecret } from "@openwork/types/den/inference"
import type { InferenceAwsKeysSecret, InferenceProviderCredentialKind } from "@openwork/types/den/inference"
import type { MintGcpAccessToken } from "./credentials/gcp-service-account.js"
import { needsGoogleOauthRefresh } from "./credentials/google-oauth-refresh.js"
import type { RefreshGoogleOauthToken } from "./credentials/google-oauth-refresh.js"

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

export const ORG_CREDENTIAL_SUBJECT = "org"

const keyLikeEnvName = /(API_KEY|_KEY|TOKEN)$/

export function pickApiKeyFromMap(apiKeys: Record<string, string>, envNames: string[]) {
  const keyLike = envNames.find((name) => keyLikeEnvName.test(name) && apiKeys[name])
  if (keyLike) return apiKeys[keyLike]
  const primary = envNames[0]
  if (primary && apiKeys[primary]) return apiKeys[primary]
  const values = Object.values(apiKeys)
  return values.length === 1 ? values[0] : null
}

function isExpired(credential: GatewayCredential, now: Date) {
  return credential.expires_at !== null && credential.expires_at.getTime() <= now.getTime()
}

function parseSecret(credential: GatewayCredential) {
  try {
    return parseInferenceProviderSecret(credential.kind, credential.secret)
  } catch (error) {
    return { kind: "invalid_secret" as const, credentialId: credential.id, message: error instanceof Error ? error.message : String(error) }
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
        return { kind: "invalid_secret", credentialId: credential.id, message: "api_key_map has no value for the provider's key env name" }
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
  envNames: string[]
  loadProviderCredential: LoadProviderCredential
  refreshGoogleOauthToken?: RefreshGoogleOauthToken
  mintGcpAccessToken?: MintGcpAccessToken
  now?: Date
}): Promise<ResolvedUpstreamCredential> {
  const now = input.now ?? new Date()
  const materializeInput = { envNames: input.envNames, now, mintGcpAccessToken: input.mintGcpAccessToken }
  const subject = input.provider.credential_mode === "member" ? input.orgMembershipId : ORG_CREDENTIAL_SUBJECT
  let credential = await input.loadProviderCredential({ inferenceProviderId: input.provider.id, subject })

  if (input.provider.credential_mode !== "member") {
    if (!credential || credential.status !== "active") return { kind: "org_credential_missing" }
    if (isExpired(credential, now)) return { kind: "org_credential_expired", credentialId: credential.id }
    const parsed = parseSecret(credential)
    return parsed.kind === "invalid_secret" ? parsed : materialize(credential, parsed, materializeInput)
  }

  if (!credential) return { kind: "auth_required", credentialId: null, reason: "missing" }
  if (credential.status !== "active") return { kind: "auth_required", credentialId: credential.id, reason: "inactive" }
  let parsed = parseSecret(credential)
  if (parsed.kind === "invalid_secret") return parsed

  if (parsed.kind === "oauth_google" && credential.kind === "oauth_google" && input.refreshGoogleOauthToken && needsGoogleOauthRefresh(credential, parsed.token, now)) {
    const outcome = await input.refreshGoogleOauthToken({ credential: { ...credential, kind: "oauth_google" }, token: parsed.token, provider: input.provider, now })
    if (outcome.kind === "auth_required") return { kind: "auth_required", credentialId: credential.id, reason: "refresh_failed" }
    if (outcome.kind === "refreshed") {
      credential = outcome.credential
      parsed = parseSecret(credential)
      if (parsed.kind === "invalid_secret") return parsed
    } else {
      // Lock held elsewhere or a transient token-endpoint failure: send the
      // stale token and let the upstream 401 pass through.
      return materialize(credential, parsed, materializeInput)
    }
  }

  if (isExpired(credential, now)) return { kind: "auth_required", credentialId: credential.id, reason: "expired" }
  return materialize(credential, parsed, materializeInput)
}

export const loadProviderCredentialFromDb: LoadProviderCredential = async (input) => {
  const { db } = await import("./db.js")
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
      eq(InferenceProviderCredentialTable.subject, input.subject),
    ))
    .limit(1)
  return row ?? null
}
