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

// SSO sign-in creates users under the organization's identity-provider policy
// (authorizeOrganizationSsoSignIn), not the self-service signup policy.
const SSO_USER_CREATION_PATH_PREFIXES = ["/sso/", "/sign-in/sso"]

export function isSsoUserCreationPath(path: string | null | undefined) {
  return typeof path === "string" && SSO_USER_CREATION_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export type UserCreationSignupGuardInput = {
  /** Better Auth endpoint path that is creating the user; null for programmatic creation. */
  path: string | null | undefined
  email: string | null
  /** True only after validating the bootstrap grant's signature, email, expiry, and availability. */
  hasBootstrapGrant: boolean
  hasPendingInvitation: (email: string) => Promise<boolean>
  getViolation: (email: string | null) => Promise<SingleOrgEmailSignupPolicyViolation | null>
}

/**
 * Signup policy for every Better Auth path that creates a user (email signup,
 * email OTP sign-in, social callbacks, ...). Enforced from the user-creation
 * database hook so a single route cannot bypass it. Pending invitations and
 * the initial-admin bootstrap grant are the only self-service exceptions.
 */
export async function resolveUserCreationSignupPolicyViolation(
  input: UserCreationSignupGuardInput,
): Promise<SingleOrgEmailSignupPolicyViolation | null> {
  // Programmatic creation (SCIM provisioning, seeds, admin tooling) carries no
  // request path and is authorized by its own caller.
  if (!input.path) {
    return null
  }

  if (isSsoUserCreationPath(input.path)) {
    return null
  }

  if (input.path === "/sign-up/email" && input.hasBootstrapGrant) {
    return null
  }

  const violation = await input.getViolation(input.email)
  if (!violation) {
    return null
  }

  if (input.email && (await input.hasPendingInvitation(input.email))) {
    return null
  }

  return violation
}
