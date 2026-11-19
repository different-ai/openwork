import { emailDomainMatches } from "./account-linking-policy.js"

/**
 * SSO links a sign-in to an existing account only when the email is on the
 * connection's verified domain, so an administrator whose own email is on a
 * different domain can never pass the connection test. Returns the message
 * that tells them which domain to use, or null when the domains match.
 */
export function ssoTestDomainMismatchMessage(email: string, configuredDomain: string) {
  const emailDomain = email.split("@")[1]?.trim().toLowerCase()
  if (!emailDomain || emailDomainMatches(emailDomain, configuredDomain)) return null
  return `Your account (${email}) is not on this connection's domain (${configuredDomain}). SSO only signs in people whose email is on the verified domain. Change the domain to ${emailDomain}, verify it, then test again.`
}
