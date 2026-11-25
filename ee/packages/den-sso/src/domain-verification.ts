export const SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX = "better-auth-token"

export function getSsoDomainVerificationHost(providerId: string) {
  return `_${SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX}-${providerId}`
}

export function getSsoDomainVerificationDnsName(providerId: string, domain: string) {
  return `${getSsoDomainVerificationHost(providerId)}.${domain}`
}
