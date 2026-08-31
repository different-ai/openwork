import { createHash, createHmac } from "node:crypto"
import type {
  ExternalMcpAuthType,
  ExternalMcpConnectionKind,
  ExternalMcpCredentialMode,
} from "@openwork-ee/den-db/schema"

export type ExternalMcpOAuthStateIdentitySource = {
  id: string
  kind: ExternalMcpConnectionKind
  url: string
  authType: ExternalMcpAuthType
  credentialMode: ExternalMcpCredentialMode
}

type NonSecretExternalMcpOAuthStateIdentity =
  | readonly [url: string, authType: ExternalMcpAuthType, credentialMode: ExternalMcpCredentialMode]
  | readonly [nativeProviderId: string, url: string, authType: ExternalMcpAuthType, credentialMode: ExternalMcpCredentialMode]

export function normalizeExternalMcpIdentityUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.hash = ""
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol}//${url.host}${pathname}${url.search}`
  } catch {
    return value.trim().replace(/\/+$/, "")
  }
}

function connectionIdentityFields(source: ExternalMcpOAuthStateIdentitySource): NonSecretExternalMcpOAuthStateIdentity {
  const url = normalizeExternalMcpIdentityUrl(source.url)
  const authType: ExternalMcpAuthType = source.authType === "oauth"
    ? "oauth"
    : source.authType === "apikey"
      ? "apikey"
      : "none"
  const credentialMode: ExternalMcpCredentialMode = source.credentialMode === "shared" ? "shared" : "per_member"
  if (source.kind === "native_provider") {
    return [source.id, url, authType, credentialMode]
  }
  return [url, authType, credentialMode]
}

/**
 * Binds signed OAuth state to connection identity fields without embedding
 * them in the state. The deployment-stable state-signing secret makes URL
 * query values opaque even when they have low entropy.
 */
export function createExternalMcpIdentityBinding(
  source: ExternalMcpOAuthStateIdentitySource,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update("openwork:external-mcp-identity:v2\0")
    .update(JSON.stringify(connectionIdentityFields(source)))
    .digest("base64url")
}

/**
 * Accepts the SHA-256 and reversible bindings emitted before keyed binding.
 * Call only after the containing OAuth state token's signature is verified.
 */
export function matchesLegacyExternalMcpOAuthStateIdentityBinding(
  source: ExternalMcpOAuthStateIdentitySource,
  signedStateBinding: string,
): boolean {
  const serializedIdentity = JSON.stringify(connectionIdentityFields(source))
  const previousDigest = createHash("sha256").update(serializedIdentity).digest("base64url")
  if (signedStateBinding === previousDigest) return true

  const decoded = Buffer.from(signedStateBinding, "base64url")
  return decoded.toString("base64url") === signedStateBinding
    && decoded.toString("utf8") === serializedIdentity
}
