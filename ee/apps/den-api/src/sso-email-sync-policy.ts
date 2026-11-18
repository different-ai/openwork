import { normalizeLoginEmail } from "./auth-login-options.js"

// ENG-815: when an identity provider renames a member, decide whether Den may
// follow the rename. Pure so it can be unit tested without a database.

export type SsoEmailSyncDecision =
  | { action: "update"; email: string }
  | { action: "skip"; reason: "unchanged" | "missing_email" | "domain_unverified" | "outside_provider_domain" }

function emailDomain(email: string) {
  const at = email.lastIndexOf("@")
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : ""
}

/** Same rule as @better-auth/sso: exact domain or a subdomain of any listed provider domain. */
export function emailMatchesProviderDomain(email: string, providerDomain: string) {
  const domain = emailDomain(email)
  if (!domain) return false
  return providerDomain
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some((entry) => domain === entry || domain.endsWith(`.${entry}`))
}

/**
 * Only an organization's verified-domain SSO provider may move a user's email,
 * and only to an address inside that verified domain. Anything else keeps the
 * current email, so a provider cannot claim an address it does not own.
 */
export function decideSsoEmailSync(input: Readonly<{
  currentEmail: string
  idpEmail: string | null
  providerDomain: string
  providerDomainVerified: boolean
}>): SsoEmailSyncDecision {
  if (!input.idpEmail) return { action: "skip", reason: "missing_email" }
  const email = normalizeLoginEmail(input.idpEmail)
  if (!email.includes("@")) return { action: "skip", reason: "missing_email" }
  if (email === normalizeLoginEmail(input.currentEmail)) return { action: "skip", reason: "unchanged" }
  if (!input.providerDomainVerified) return { action: "skip", reason: "domain_unverified" }
  if (!emailMatchesProviderDomain(email, input.providerDomain)) return { action: "skip", reason: "outside_provider_domain" }
  return { action: "update", email }
}
