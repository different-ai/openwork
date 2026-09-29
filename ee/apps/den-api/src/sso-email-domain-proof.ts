export type SsoEmailDomainProvider = {
  issuer: string
  domain: string
  providerId: string
  organizationId?: string | null
  domainVerified?: boolean | null
  oidcConfig?: unknown
  samlConfig?: unknown
}

export type SsoEmailDomainProof = {
  version: 1
  organizationId: string
  providerId: string
  domain: string
  method: "dns-txt" | "development"
  verifiedAt: string
}

export type SsoEmailDomainProofOptions = {
  protocol: "oidc" | "saml"
  allowDevelopment: boolean
}

export const SSO_EMAIL_DOMAIN_PROOF_KEY = "openworkEmailDomainProof"

export function canonicalSsoEmailDomain(value: string): string | null {
  const domain = value.trim().toLowerCase()
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) return null
  return domain
}

export function isSsoLoopbackIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer)
    return (url.protocol === "http:" || url.protocol === "https:")
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function configObject(config: unknown): Record<string, unknown> | null {
  if (typeof config === "string") {
    try {
      const parsed: unknown = JSON.parse(config)
      return configObject(parsed)
    } catch {
      return null
    }
  }
  return isRecord(config) ? config : null
}

export function readSsoEmailDomainProof(provider: SsoEmailDomainProvider, options: SsoEmailDomainProofOptions): SsoEmailDomainProof | null {
  if (provider.domainVerified !== true || !provider.organizationId || (options.protocol !== "oidc" && options.protocol !== "saml")) return null
  const domain = canonicalSsoEmailDomain(provider.domain)
  const config = configObject(options.protocol === "oidc" ? provider.oidcConfig : provider.samlConfig)
  const value = config?.[SSO_EMAIL_DOMAIN_PROOF_KEY]
  const proof = isRecord(value) ? value : null
  if (!domain || !proof || proof.version !== 1 || proof.organizationId !== provider.organizationId
    || proof.providerId !== provider.providerId || proof.domain !== domain
    || typeof proof.verifiedAt !== "string" || !Number.isFinite(Date.parse(proof.verifiedAt))
    || (proof.method !== "dns-txt" && proof.method !== "development")) return null
  // Den's SAML provider.issuer identifies the SP; the current IdP issuer is
  // stored in idpMetadata.entityID. Never mistake a local SP for a local IdP.
  const idpMetadata = configObject(config?.idpMetadata)
  const issuer = options.protocol === "saml" && typeof idpMetadata?.entityID === "string" ? idpMetadata.entityID : provider.issuer
  if (proof.method === "development" && (options.allowDevelopment !== true || !isSsoLoopbackIssuer(issuer))) return null
  return {
    version: 1, organizationId: provider.organizationId, providerId: provider.providerId,
    domain, method: proof.method, verifiedAt: proof.verifiedAt,
  }
}

// Email proof is deliberately narrower than the SDK's legacy linking authority:
// no subdomains, domain lists, wildcard domains, or inferred issuer ownership.
export function isSsoEmailDomainTrusted(provider: SsoEmailDomainProvider, email: string, options: SsoEmailDomainProofOptions): boolean {
  const proof = readSsoEmailDomainProof(provider, options)
  const match = /^[^@\s]+@([^@\s]+)$/.exec(email.trim())
  return !!proof && !!match?.[1] && match[1].toLowerCase() === proof.domain
}

// Writers are server-only. Public registration schemas must never expose this key.
export function withSsoEmailDomainProof(config: unknown, proof: SsoEmailDomainProof | null): string {
  const parsed = configObject(config)
  if (!parsed) throw new Error("Invalid SSO configuration.")
  const { [SSO_EMAIL_DOMAIN_PROOF_KEY]: _ignored, ...settings } = parsed
  return JSON.stringify(proof ? { ...settings, [SSO_EMAIL_DOMAIN_PROOF_KEY]: proof } : settings)
}

export function stripSsoEmailDomainProof(config: string | null): string | null {
  if (!config) return config
  const parsed = configObject(config)
  return parsed ? withSsoEmailDomainProof(parsed, null) : config
}
