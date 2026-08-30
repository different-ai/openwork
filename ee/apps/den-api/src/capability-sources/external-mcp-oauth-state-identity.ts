import { createHash } from "node:crypto"
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

function nonSecretOAuthStateIdentity(source: ExternalMcpOAuthStateIdentitySource): NonSecretExternalMcpOAuthStateIdentity {
  const url = normalizeExternalMcpIdentityUrl(source.url)
  if (source.kind === "native_provider") {
    return [source.id, url, source.authType, source.credentialMode]
  }
  return [url, source.authType, source.credentialMode]
}

/**
 * Binds signed OAuth state to connection identity fields without embedding
 * them in the state. Credential values are deliberately outside this input
 * type, while hashing also protects sensitive values present in URL queries.
 */
export function externalMcpIdentityBinding(source: ExternalMcpOAuthStateIdentitySource): string {
  return createHash("sha256")
    .update(JSON.stringify(nonSecretOAuthStateIdentity(source)))
    .digest("base64url")
}

/**
 * Accepts the reversible binding emitted before identity hashing. Call only
 * after the containing OAuth state token's signature has been verified.
 */
export function matchesLegacyExternalMcpOAuthStateIdentityBinding(
  source: ExternalMcpOAuthStateIdentitySource,
  signedStateBinding: string,
): boolean {
  const decoded = Buffer.from(signedStateBinding, "base64url")
  return decoded.toString("base64url") === signedStateBinding
    && decoded.toString("utf8") === JSON.stringify(nonSecretOAuthStateIdentity(source))
}
