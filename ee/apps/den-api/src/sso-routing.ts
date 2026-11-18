/**
 * Pure rules for how an organization's SSO applies at sign-in and when
 * someone opens the organization. No database access, so they are unit tested
 * directly (test/sso-routing.test.ts).
 *
 * On single-organization deployments an enabled SSO connection on a verified
 * domain behaves as it
 * always has: every email on that domain is sent to the organization's SSO,
 * and members cannot sign in any other way.
 *
 * On multi-organization deployments, the organization's own settings decide:
 * - SSO set up, nothing required: SSO is offered first, the usual methods stay
 *   available, and people on the domain can join other organizations.
 * - "Require SSO" (`requireSso`): the organization itself can only be opened
 *   from a session signed in through its SSO. Sign-in is not blocked, so the
 *   same person can still use other organizations.
 * - "Restrict this domain to our SSO" (`restrictDomainToSso`): the strict
 *   behavior again, for every email on the verified domain, invitation or not.
 */

export type OrganizationSsoPolicy = {
  requireSso: boolean
  restrictDomainToSso: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (isRecord(metadata)) return metadata
  if (typeof metadata !== "string" || !metadata.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function readOrganizationSsoPolicy(metadata: unknown): OrganizationSsoPolicy {
  const parsed = parseMetadata(metadata)
  return {
    requireSso: parsed.requireSso === true,
    restrictDomainToSso: parsed.restrictDomainToSso === true,
  }
}

/** Whether opening the organization needs a session signed in through its SSO (per-organization mode). */
export function organizationRequiresSsoSession(policy: OrganizationSsoPolicy) {
  return policy.requireSso || policy.restrictDomainToSso
}

/** The SSO organization that owns an email's verified domain, as login routing sees it. */
export type DomainSsoRequirement = {
  organizationId: string
  organizationSlug: string
  organizationName: string
  signInPath: string
  policy: OrganizationSsoPolicy
  /** Multi-organization routing; false on single-organization deployments. */
  perOrganization: boolean
}

export type LoginSsoRouting =
  /** No SSO applies: the usual sign-in step. */
  | { kind: "none" }
  /** SSO is the only way in (today's behavior, single-organization SSO, or a restricted domain). */
  | { kind: "sso_only" }
  /** SSO is offered first; the usual methods stay available. */
  | { kind: "sso_preferred"; ssoRequired: boolean }

export function resolveLoginSsoRouting(input: {
  /** Single-organization deployment with SSO configured: unchanged, always SSO. */
  singletonSso: boolean
  requirement: DomainSsoRequirement | null
  /** Organization of a valid pending invitation addressed to this email, when the sign-in names one. */
  invitationOrganizationId: string | null
}): LoginSsoRouting {
  if (input.singletonSso) return { kind: "sso_only" }
  const requirement = input.requirement
  if (!requirement) return { kind: "none" }
  if (!requirement.perOrganization) return { kind: "sso_only" }
  if (requirement.policy.restrictDomainToSso) return { kind: "sso_only" }
  // An invitation to another organization is the person's way in there; the
  // domain's SSO organization does not get to redirect it.
  if (input.invitationOrganizationId && input.invitationOrganizationId !== requirement.organizationId) {
    return { kind: "none" }
  }
  return { kind: "sso_preferred", ssoRequired: requirement.policy.requireSso }
}

/** An SSO organization the person belongs to (or whose domain their email is on), for sign-in enforcement. */
export type SignInSsoCandidate = {
  organizationId: string
  policy: OrganizationSsoPolicy
  perOrganization: boolean
  /** The email's domain is this organization's verified SSO domain. */
  emailOnVerifiedDomain: boolean
  /** The person is an active member of the organization. */
  member: boolean
}

/**
 * Whether a password, Google or other non-SSO sign-in is refused because of
 * this organization. Off: members of an SSO organization must use SSO.
 * On: only a restricted domain refuses sign-in; everything else is enforced
 * when the organization is opened.
 */
export function blocksNonSsoSignIn(candidate: SignInSsoCandidate) {
  if (!candidate.perOrganization) return candidate.member
  return candidate.policy.restrictDomainToSso && candidate.emailOnVerifiedDomain
}

/** Whether signing in with a verified email on the domain still joins the organization automatically. */
export function allowsVerifiedDomainAutoJoin(input: { policy: OrganizationSsoPolicy; perOrganization: boolean }) {
  // An organization that requires SSO gets its members through SSO sign-up,
  // so a password or Google session never lands in it as a fresh member.
  return !input.perOrganization || !organizationRequiresSsoSession(input.policy)
}
