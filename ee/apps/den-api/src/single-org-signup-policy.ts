import type { DenOrgMode } from "./env.js"
import { env } from "./env.js"
import {
  getSingletonOrganization,
  isEmailAllowedForOrganization,
  normalizeAllowedEmailDomains,
  OrganizationEmailDomainRestrictionError,
  type AllowedEmailDomains,
} from "./orgs.js"

export type SingleOrgEmailSignupPolicyViolation = {
  error: "single_org_signup_disabled" | "email_domain_restricted"
  message: string
  allowedEmailDomains?: string[]
}

type SingletonOrganizationForSignup = {
  allowedEmailDomains: readonly string[] | null | undefined
}

export function getAuthBodyEmail(body: unknown) {
  if (!body || typeof body !== "object") {
    return null
  }

  const value = Object.getOwnPropertyDescriptor(body, "email")?.value
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export async function getAuthRequestEmail(request: Request) {
  try {
    return getAuthBodyEmail(await request.clone().json())
  } catch {
    return null
  }
}

function disabledSignupViolation(): SingleOrgEmailSignupPolicyViolation {
  return {
    error: "single_org_signup_disabled",
    message: "Email signup is disabled for this deployment. Use your organization's SSO or a pre-provisioned account to sign in.",
  }
}

function domainSignupViolation(email: string, allowedEmailDomains: string[]): SingleOrgEmailSignupPolicyViolation {
  const error = new OrganizationEmailDomainRestrictionError(email, allowedEmailDomains)
  return {
    error: "email_domain_restricted",
    message: error.message,
    allowedEmailDomains,
  }
}

function evaluateAllowedDomains(input: {
  email: string | null
  allowedEmailDomains: AllowedEmailDomains
}) {
  if (!input.allowedEmailDomains || input.allowedEmailDomains.length === 0 || !input.email) {
    return null
  }

  return isEmailAllowedForOrganization(input.allowedEmailDomains, input.email)
    ? null
    : domainSignupViolation(input.email, input.allowedEmailDomains)
}

export async function resolveSingleOrgEmailSignupPolicyViolation(input: {
  orgMode: DenOrgMode
  allowPublicSignup: boolean
  email: string | null
  getSingletonOrganization: () => Promise<SingletonOrganizationForSignup | null>
}): Promise<SingleOrgEmailSignupPolicyViolation | null> {
  if (input.orgMode !== "single_org") {
    return null
  }

  if (!input.allowPublicSignup) {
    return disabledSignupViolation()
  }

  if (!input.email) {
    return null
  }

  const organization = await input.getSingletonOrganization()
  const allowedEmailDomains = normalizeAllowedEmailDomains(organization?.allowedEmailDomains).domains
  return evaluateAllowedDomains({ email: input.email, allowedEmailDomains })
}

export async function getSingleOrgEmailSignupPolicyViolation(email: string | null) {
  return resolveSingleOrgEmailSignupPolicyViolation({
    orgMode: env.orgMode,
    allowPublicSignup: env.singleOrg.allowPublicSignup,
    email,
    getSingletonOrganization,
  })
}
