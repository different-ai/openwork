// Exchanges a member's IAM Identity Center access token for short-lived role
// credentials of the set's AWS account and permission set (GetRoleCredentials),
// cached per credential and token until five minutes before they expire. The
// keys then sign Bedrock requests with SigV4 like organization AWS keys.
import { createHash } from "node:crypto"
import { AwsSsoError, getAwsSsoRoleCredentials, type FetchLike } from "@openwork-ee/utils/aws-identity-center"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import type { GatewayAwsKeysSecret, GatewayAwsSsoSecret } from "@openwork/types/den/gateway"

const EXPIRY_MARGIN_MS = 5 * 60_000
export const AWS_ROLE_CREDENTIALS_CACHE_LIMIT = 1024

export type MintAwsRoleCredentialsResult =
  | { kind: "credentials"; awsKeys: GatewayAwsKeysSecret }
  /** The sign-in no longer works (expired or revoked): the person signs in again. */
  | { kind: "auth_required" }
  /** AWS refused this account or permission set for the person: an administrator fixes the assignment. */
  | { kind: "forbidden"; message: string }
  | { kind: "retry" }
  | { kind: "error"; message: string }

export type MintAwsRoleCredentials = (input: {
  credentialId: string
  awsSso: GatewayAwsSsoSecret
  now: Date
}) => Promise<MintAwsRoleCredentialsResult>

export function createAwsSsoRoleCredentialMinter(deps: { fetchImpl?: FetchLike } = {}): MintAwsRoleCredentials {
  const fetchImpl = deps.fetchImpl ?? createInferenceEgressFetch({ allowedOrigins: new Set() })
  const cache = new Map<string, { awsKeys: GatewayAwsKeysSecret; expiresAt: number }>()
  const inflight = new Map<string, Promise<MintAwsRoleCredentialsResult>>()

  async function mint(input: Parameters<MintAwsRoleCredentials>[0], key: string): Promise<MintAwsRoleCredentialsResult> {
    const { sso, accessToken } = input.awsSso
    try {
      const role = await getAwsSsoRoleCredentials({ region: sso.region, accessToken, accountId: sso.accountId, roleName: sso.roleName, fetchImpl })
      const expiresAt = role.expiration.getTime()
      if (!Number.isFinite(expiresAt) || expiresAt - EXPIRY_MARGIN_MS <= input.now.getTime()) {
        // Very short permission-set sessions: use them once rather than caching.
        if (expiresAt <= input.now.getTime()) return { kind: "error", message: "IAM Identity Center returned expired role credentials" }
        return { kind: "credentials", awsKeys: { accessKeyId: role.accessKeyId, secretAccessKey: role.secretAccessKey, sessionToken: role.sessionToken } }
      }
      if (cache.size >= AWS_ROLE_CREDENTIALS_CACHE_LIMIT) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      const awsKeys = { accessKeyId: role.accessKeyId, secretAccessKey: role.secretAccessKey, sessionToken: role.sessionToken }
      cache.set(key, { awsKeys, expiresAt })
      return { kind: "credentials", awsKeys }
    } catch (error) {
      if (!(error instanceof AwsSsoError)) return { kind: "error", message: "role credentials unavailable" }
      if (error.transient) return { kind: "retry" }
      if (error.code === "aws_sso_unauthorized") return { kind: "auth_required" }
      if (error.code === "aws_sso_role_forbidden") return { kind: "forbidden", message: error.message }
      return { kind: "error", message: error.message }
    }
  }

  return async (input) => {
    // The token, account and permission set all key the cache: a renewed token or a
    // reconfigured set never reuses keys minted for another.
    const revision = createHash("sha256").update(JSON.stringify([input.awsSso.accessToken, input.awsSso.sso])).digest("hex")
    const key = `${input.credentialId}:${revision}`
    for (const [id, entry] of cache) {
      if (entry.expiresAt - EXPIRY_MARGIN_MS <= input.now.getTime()) cache.delete(id)
    }
    const cached = cache.get(key)
    if (cached) return { kind: "credentials", awsKeys: cached.awsKeys }
    const pending = inflight.get(key)
    if (pending) return pending
    if (inflight.size >= AWS_ROLE_CREDENTIALS_CACHE_LIMIT) return { kind: "retry" }
    const promise = mint(input, key).finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}
