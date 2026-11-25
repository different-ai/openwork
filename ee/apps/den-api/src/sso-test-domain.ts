import { emailDomainMatches } from "./account-linking-policy.js"

export function ssoTestDomainMismatchMessage(email: string, configuredDomain: string) {
  const emailDomain = email.split("@")[1]?.trim().toLowerCase()
  if (!emailDomain || emailDomainMatches(emailDomain, configuredDomain)) return null
  return `Your account (${email}) is not on this connection's domain (${configuredDomain}). SSO only signs in people whose email is on the verified domain. Change the domain to ${emailDomain}, verify it, then test again.`
}
