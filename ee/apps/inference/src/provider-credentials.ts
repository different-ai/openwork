// Resolve the upstream secret for a gateway provider (plan §4.3, decision #14).
// `credential_mode = org` → the `subject = "org"` row; `member` → the member's
// own row, never falling back to the org row. OAuth refresh and SigV4 / GCP
// service-account token minting are follow-ups: expired tokens are reported as
// auth_required and the static cloud kinds as unsupported.
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { InferenceProviderCredentialTable, InferenceProviderTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { parseInferenceProviderSecret } from "@openwork/types/den/inference"
import type { InferenceProviderCredentialKind } from "@openwork/types/den/inference"

export type GatewayProvider = Pick<
  typeof InferenceProviderTable.$inferSelect,
  "id" | "organization_id" | "provider_id" | "provider_config" | "settings" | "credential_mode" | "status"
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
  | { kind: "auth_required"; credentialId: CredentialId | null; reason: "missing" | "expired" | "inactive" }
  | { kind: "org_credential_missing" }
  | { kind: "org_credential_expired"; credentialId: CredentialId }
  | { kind: "invalid_secret"; credentialId: CredentialId; message: string }
  | { kind: "unsupported_credential_kind"; credentialId: CredentialId; credentialKind: InferenceProviderCredentialKind }

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

function materialize(credential: GatewayCredential, envNames: string[]): ResolvedUpstreamCredential {
  let parsed: ReturnType<typeof parseInferenceProviderSecret>
  try {
    parsed = parseInferenceProviderSecret(credential.kind, credential.secret)
  } catch (error) {
    return { kind: "invalid_secret", credentialId: credential.id, message: error instanceof Error ? error.message : String(error) }
  }
  switch (parsed.kind) {
    case "api_key":
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret: parsed.apiKey }
    case "api_key_map": {
      const secret = pickApiKeyFromMap(parsed.apiKeys, envNames)
      if (!secret) {
        return { kind: "invalid_secret", credentialId: credential.id, message: "api_key_map has no value for the provider's key env name" }
      }
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret }
    }
    case "oauth_google":
    case "oauth_azure":
      return { kind: "secret", credentialId: credential.id, credentialKind: parsed.kind, secret: parsed.token.accessToken }
    case "aws_keys":
    case "gcp_service_account":
      return { kind: "unsupported_credential_kind", credentialId: credential.id, credentialKind: parsed.kind }
  }
}

export async function resolveUpstreamCredential(input: {
  provider: GatewayProvider
  orgMembershipId: string
  envNames: string[]
  loadProviderCredential: LoadProviderCredential
  now?: Date
}): Promise<ResolvedUpstreamCredential> {
  const now = input.now ?? new Date()
  const subject = input.provider.credential_mode === "member" ? input.orgMembershipId : ORG_CREDENTIAL_SUBJECT
  const credential = await input.loadProviderCredential({ inferenceProviderId: input.provider.id, subject })

  if (input.provider.credential_mode === "member") {
    if (!credential) return { kind: "auth_required", credentialId: null, reason: "missing" }
    if (credential.status !== "active") return { kind: "auth_required", credentialId: credential.id, reason: "inactive" }
    if (isExpired(credential, now)) return { kind: "auth_required", credentialId: credential.id, reason: "expired" }
    return materialize(credential, input.envNames)
  }

  if (!credential || credential.status !== "active") return { kind: "org_credential_missing" }
  if (isExpired(credential, now)) return { kind: "org_credential_expired", credentialId: credential.id }
  return materialize(credential, input.envNames)
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
