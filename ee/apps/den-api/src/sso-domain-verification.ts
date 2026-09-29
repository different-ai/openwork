import { createHash } from "node:crypto"

export const SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX = "better-auth-token"

export function getSsoDomainVerificationHost(providerId: string) {
  const legacyHost = `_${SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX}-${providerId}`
  // TXT service labels can contain underscores, including Den's existing IDs.
  // Preserve every valid short name so already-published records keep working.
  if (legacyHost.length <= 63 && !/[^a-z0-9_-]/i.test(legacyHost)) return legacyHost

  // Base 36 retains the entire SHA-256 value in at most 50 DNS-safe characters.
  // This is not a truncated provider ID or digest; the label is at most 58 chars.
  const digest = createHash("sha256").update(providerId).digest("hex")
  return `_ow-sso-${BigInt(`0x${digest}`).toString(36)}`
}

export function getSsoDomainVerificationDnsName(providerId: string, domain: string) {
  return `${getSsoDomainVerificationHost(providerId)}.${domain}`
}
