export const ORGANIZATION_ADMISSION_METHODS = [
  "self_join",
  "invitation",
  "sso_jit",
  "scim",
] as const

export type OrganizationAdmissionMethod = typeof ORGANIZATION_ADMISSION_METHODS[number]

export type OrganizationAuthenticationRequirement = "any" | "organization_sso"

export type OrganizationLifecycleAuthority = "local" | "scim"

export type OrganizationMembershipRemovalSource = "admin" | "self" | "scim" | "system"

export type OrganizationAdmissionPolicy = {
  version: number
  admissionMethods: OrganizationAdmissionMethod[]
  emailDomainRule:
    | { mode: "any" }
    | { mode: "allowlist"; domains: string[] }
  authenticationRequirement: OrganizationAuthenticationRequirement
  lifecycleAuthority: OrganizationLifecycleAuthority
  updatedAt: string
}

export const ORGANIZATION_ADMISSION_SOURCES = [
  "self_join",
  "invitation",
  "sso_jit",
  "scim",
  "initial_owner",
  "workspace_claim",
  "admin_restore",
  "legacy",
] as const

export type OrganizationAdmissionSource = typeof ORGANIZATION_ADMISSION_SOURCES[number]

export const ORGANIZATION_ADMISSION_DENY_REASONS = [
  "organization_unavailable",
  "policy_unavailable",
  "membership_removed",
  "domain_not_allowed",
  "invitation_invalid",
  "identity_conflict",
  "provider_mismatch",
  "seat_limit_reached",
  "owner_role_forbidden",
  "admission_method_disabled",
] as const

export type OrganizationAdmissionDenyReason = typeof ORGANIZATION_ADMISSION_DENY_REASONS[number]

export type AdmissionDecision =
  | {
      decision: "allow"
      role: string
      source: OrganizationAdmissionSource
      policyVersion: number
      membershipId?: string
      existing: boolean
    }
  | { decision: "require_invitation" }
  | { decision: "require_email_verification" }
  | { decision: "require_sso"; signInUrl: string }
  | { decision: "require_scim_provisioning" }
  | { decision: "deny"; reason: OrganizationAdmissionDenyReason }

export const ORGANIZATION_ADMISSION_PRESETS = {
  open: {
    admissionMethods: ["self_join", "invitation"],
    emailDomainRule: { mode: "any" },
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  },
  domain_restricted: {
    admissionMethods: ["self_join", "invitation"],
    emailDomainRule: { mode: "allowlist", domains: [] },
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  },
  invite_only: {
    admissionMethods: ["invitation"],
    emailDomainRule: { mode: "any" },
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  },
  sso_only: {
    admissionMethods: ["sso_jit"],
    emailDomainRule: { mode: "any" },
    authenticationRequirement: "organization_sso",
    lifecycleAuthority: "local",
  },
  scim_managed: {
    admissionMethods: ["scim"],
    emailDomainRule: { mode: "any" },
    authenticationRequirement: "organization_sso",
    lifecycleAuthority: "scim",
  },
  invite_or_sso: {
    admissionMethods: ["invitation", "sso_jit"],
    emailDomainRule: { mode: "any" },
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  },
} as const satisfies Record<string, Omit<OrganizationAdmissionPolicy, "version" | "updatedAt">>
