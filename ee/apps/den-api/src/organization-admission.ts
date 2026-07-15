import { createHash } from "node:crypto"
import { domainToASCII } from "node:url"
import type {
  AdmissionDecision,
  OrganizationAdmissionMethod,
  OrganizationAdmissionPolicy,
  OrganizationAdmissionSource,
  OrganizationAuthenticationRequirement,
  OrganizationLifecycleAuthority,
} from "@openwork/types/den/organization-admission"
import { metrics } from "@opentelemetry/api"
import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AuthSessionTable,
  AuditEventTable,
  InvitationTable,
  MemberTable,
  OrganizationAdmissionPolicyTable,
  OrganizationRoleTable,
  OrganizationTable,
  ScimProviderTable,
  SsoConnectionTable,
  SsoProviderTable,
  TeamMemberTable,
  TeamTable,
  WorkspaceBootstrapTable,
  WorkspaceClaimTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { buildOrganizationAuditEvent, ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "./audit-events.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { normalizeOrganizationMetadata } from "./organization-limits.js"
import { getOrganizationSeatAddEligibility } from "./stripe-billing.js"

type OrganizationId = DenTypeId<"organization">
type UserId = DenTypeId<"user">
type MemberRow = typeof MemberTable.$inferSelect
type InvitationRow = typeof InvitationTable.$inferSelect
type PolicyRow = typeof OrganizationAdmissionPolicyTable.$inferSelect
type WorkspaceClaimRow = typeof WorkspaceClaimTable.$inferSelect

const admissionMeter = metrics.getMeter("openwork-den-admission")
const admissionEvaluationCounter = admissionMeter.createCounter("openwork.organization_admission.evaluations")
const admissionShadowMismatchCounter = admissionMeter.createCounter("openwork.organization_admission.shadow_mismatches")

export type OrganizationAdmissionEvidence =
  | { kind: "self_join" }
  | { kind: "invitation"; token: string }
  | { kind: "sso"; providerId: string }
  | { kind: "scim"; providerId: string; active: boolean }
  | { kind: "workspace_claim"; token: string }
  | { kind: "admin_restore"; role: string; actorMemberId: string }

export type OrganizationSessionAssurance = {
  providerId: string | null
  organizationId: string | null
}

export type OrganizationAdmissionAttempt = {
  organizationId: OrganizationId
  userId: UserId
  evidence: OrganizationAdmissionEvidence
  assurance?: OrganizationSessionAssurance | null
}

type EvaluatedAdmission = {
  decision: AdmissionDecision
  existingMember: MemberRow | null
  invitation: InvitationRow | null
  workspaceClaim?: WorkspaceClaimRow | null
}

export class OrganizationAdmissionConflictError extends Error {
  constructor() {
    super("organization_admission_state_changed")
    this.name = "OrganizationAdmissionConflictError"
  }
}

export class OrganizationAdmissionPolicyValidationError extends Error {
  readonly code:
    | "admission_methods_required"
    | "domain_allowlist_required"
    | "organization_sso_required"
    | "scim_provider_required"
    | "scim_lifecycle_invalid"

  constructor(code: OrganizationAdmissionPolicyValidationError["code"], message: string) {
    super(message)
    this.name = "OrganizationAdmissionPolicyValidationError"
    this.code = code
  }
}

function isAdmissionMethod(value: unknown): value is OrganizationAdmissionMethod {
  return value === "self_join" || value === "invitation" || value === "sso_jit" || value === "scim"
}

function normalizeAdmissionMethods(methods: readonly unknown[]) {
  return [...new Set(methods.filter(isAdmissionMethod))]
}

export function normalizeAdmissionDomain(input: string) {
  const trimmed = input.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "")
  const ascii = domainToASCII(trimmed)
  if (!ascii || ascii.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(ascii)) {
    return null
  }
  const labels = ascii.split(".")
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return null
  }
  return ascii
}

export function normalizeAdmissionEmail(input: string) {
  const trimmed = input.trim()
  const separator = trimmed.lastIndexOf("@")
  if (separator <= 0 || separator === trimmed.length - 1) return null
  const domain = normalizeAdmissionDomain(trimmed.slice(separator + 1))
  if (!domain) return null
  return `${trimmed.slice(0, separator).toLowerCase()}@${domain}`
}

export function normalizeAdmissionDomains(domains: readonly string[]) {
  const normalized: string[] = []
  const invalid: string[] = []
  for (const domain of domains) {
    const value = normalizeAdmissionDomain(domain)
    if (!value) {
      invalid.push(domain)
    } else if (!normalized.includes(value)) {
      normalized.push(value)
    }
  }
  return { domains: normalized.sort(), invalid }
}

function emailDomain(email: string) {
  const separator = email.lastIndexOf("@")
  return separator > 0 ? normalizeAdmissionDomain(email.slice(separator + 1)) : null
}

function emailAllowed(policy: OrganizationAdmissionPolicy, email: string) {
  if (policy.emailDomainRule.mode === "any") {
    return true
  }
  const domain = emailDomain(email)
  return domain !== null && policy.emailDomainRule.domains.includes(domain)
}

function roleIncludesOwner(role: string) {
  return role.split(",").map((entry) => entry.trim()).includes("owner")
}

function roleIncludes(role: string, expected: string) {
  return role.split(",").map((entry) => entry.trim()).includes(expected)
}

export function hashOrganizationInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function policyFromRow(row: PolicyRow): OrganizationAdmissionPolicy | null {
  const rawMethods = Array.isArray(row.admissionMethods) ? row.admissionMethods : []
  const rawDomains = Array.isArray(row.allowedEmailDomains)
    ? row.allowedEmailDomains.filter((entry): entry is string => typeof entry === "string")
    : []
  const methods = normalizeAdmissionMethods(rawMethods)
  const normalizedDomains = normalizeAdmissionDomains(rawDomains)
  const validScimLifecycle = row.lifecycleAuthority !== "scim" || (methods.length === 1 && methods[0] === "scim")
  if (
    !Number.isInteger(row.version)
    || row.version < 1
    || methods.length === 0
    || rawMethods.length !== methods.length
    || rawDomains.length !== (Array.isArray(row.allowedEmailDomains) ? row.allowedEmailDomains.length : -1)
    || (row.emailDomainMode !== "any" && row.emailDomainMode !== "allowlist")
    || normalizedDomains.invalid.length > 0
    || (row.emailDomainMode === "allowlist" && normalizedDomains.domains.length === 0)
    || (row.authenticationRequirement !== "any" && row.authenticationRequirement !== "organization_sso")
    || (row.lifecycleAuthority !== "local" && row.lifecycleAuthority !== "scim")
    || !validScimLifecycle
  ) {
    return null
  }
  return {
    version: row.version,
    admissionMethods: methods,
    emailDomainRule: row.emailDomainMode === "allowlist"
      ? { mode: "allowlist", domains: normalizedDomains.domains }
      : { mode: "any" },
    authenticationRequirement: row.authenticationRequirement === "organization_sso" ? "organization_sso" : "any",
    lifecycleAuthority: row.lifecycleAuthority === "scim" ? "scim" : "local",
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getOrganizationAdmissionPolicy(organizationId: OrganizationId) {
  const rows = await db
    .select()
    .from(OrganizationAdmissionPolicyTable)
    .where(eq(OrganizationAdmissionPolicyTable.organizationId, organizationId))
    .limit(1)
  return rows[0] ? policyFromRow(rows[0]) : null
}

async function defaultPolicyForOrganization(organizationId: OrganizationId) {
  const [organizationRows, ssoRows, scimRows] = await Promise.all([
    db
      .select({ allowedEmailDomains: OrganizationTable.allowedEmailDomains, metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1),
    db
      .select({ id: SsoConnectionTable.id })
      .from(SsoConnectionTable)
      .where(eq(SsoConnectionTable.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: ScimProviderTable.id })
      .from(ScimProviderTable)
      .where(eq(ScimProviderTable.organizationId, organizationId))
      .limit(1),
  ])
  const organization = organizationRows[0]
  if (!organization) {
    return null
  }

  const admissionMethods: OrganizationAdmissionMethod[] = ["invitation"]
  if (env.orgMode === "single_org") admissionMethods.unshift("self_join")
  if (ssoRows[0]) admissionMethods.push("sso_jit")
  if (scimRows[0]) admissionMethods.push("scim")

  const domains = normalizeAdmissionDomains(organization.allowedEmailDomains ?? []).domains
  const metadata = normalizeOrganizationMetadata(organization.metadata).metadata
  return {
    version: 1,
    admissionMethods,
    emailDomainRule: domains.length > 0
      ? { mode: "allowlist" as const, domains }
      : { mode: "any" as const },
    authenticationRequirement: metadata.requireSso === true || (env.orgMode === "single_org" && Boolean(ssoRows[0]))
      ? "organization_sso" as const
      : "any" as const,
    lifecycleAuthority: "local" as const,
  }
}

export async function ensureOrganizationAdmissionPolicy(organizationId: OrganizationId) {
  const existing = await getOrganizationAdmissionPolicy(organizationId)
  if (existing) {
    if (env.orgMode === "single_org" && existing.version === 1) {
      const defaults = await defaultPolicyForOrganization(organizationId)
      const admissionMethods = existing.admissionMethods.includes("self_join")
        ? existing.admissionMethods
        : ["self_join" as const, ...existing.admissionMethods]
      const authenticationRequirement = defaults?.authenticationRequirement ?? existing.authenticationRequirement
      if (
        admissionMethods.length !== existing.admissionMethods.length
        || authenticationRequirement !== existing.authenticationRequirement
      ) {
        await db
          .update(OrganizationAdmissionPolicyTable)
          .set({
            version: 2,
            admissionMethods,
            authenticationRequirement,
          })
          .where(and(
            eq(OrganizationAdmissionPolicyTable.organizationId, organizationId),
            eq(OrganizationAdmissionPolicyTable.version, 1),
          ))
        return getOrganizationAdmissionPolicy(organizationId)
      }
    }
    return existing
  }

  return initializeOrganizationAdmissionPolicy(organizationId)
}

export async function initializeOrganizationAdmissionPolicy(
  organizationId: OrganizationId,
  override?: Omit<OrganizationAdmissionPolicy, "version" | "updatedAt">,
) {
  const existing = await getOrganizationAdmissionPolicy(organizationId)
  if (existing) return existing
  const defaults = override ? { ...override, version: 1 } : await defaultPolicyForOrganization(organizationId)
  if (!defaults) {
    return null
  }
  try {
    await db.insert(OrganizationAdmissionPolicyTable).values({
      organizationId,
      version: defaults.version,
      admissionMethods: defaults.admissionMethods,
      emailDomainMode: defaults.emailDomainRule.mode,
      allowedEmailDomains: defaults.emailDomainRule.mode === "allowlist" ? defaults.emailDomainRule.domains : [],
      authenticationRequirement: defaults.authenticationRequirement,
      lifecycleAuthority: defaults.lifecycleAuthority,
    })
  } catch {
    // Another request may have initialized the same organization.
  }
  return getOrganizationAdmissionPolicy(organizationId)
}

export async function createOrganizationWithInitialOwner(input: {
  organizationId: OrganizationId
  userId: UserId
  name: string
  slug: string
  logo: string | null
  metadata: typeof OrganizationTable.$inferInsert.metadata
}) {
  const now = new Date()
  const memberId = createDenTypeId("member")
  const admissionMethods: OrganizationAdmissionMethod[] = env.orgMode === "single_org"
    ? ["self_join", "invitation"]
    : ["invitation"]

  await db.transaction(async (tx) => {
    const userRows = await tx
      .select({ emailVerified: AuthUserTable.emailVerified })
      .from(AuthUserTable)
      .where(eq(AuthUserTable.id, input.userId))
      .for("update")
      .limit(1)
    if (!userRows[0]?.emailVerified) throw new OrganizationAdmissionConflictError()

    await tx.insert(OrganizationTable).values({
      id: input.organizationId,
      name: input.name,
      slug: input.slug,
      logo: input.logo,
      metadata: input.metadata,
    })
    await tx.insert(OrganizationAdmissionPolicyTable).values({
      organizationId: input.organizationId,
      version: 1,
      admissionMethods,
      emailDomainMode: "any",
      allowedEmailDomains: [],
      authenticationRequirement: "any",
      lifecycleAuthority: "local",
    })
    await tx.insert(MemberTable).values({
      id: memberId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: "owner",
      joinedAt: now,
      admissionSource: "initial_owner",
      admissionPolicyVersion: 1,
      admittedAt: now,
    })
    await tx.insert(AuditEventTable).values([
      buildOrganizationAuditEvent({
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.admissionEvaluated,
        payload: {
          method: "initial_owner",
          decision: "allow",
          policyVersion: 1,
          enforcementMode: env.organizationAdmissionEnforcement,
          membershipId: memberId,
        },
      }),
      buildOrganizationAuditEvent({
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.admissionAllowed,
        payload: {
          decision: "allow",
          source: "initial_owner",
          policyVersion: 1,
          enforcementMode: env.organizationAdmissionEnforcement,
          membershipId: memberId,
        },
      }),
    ])
  })

  return { organizationId: input.organizationId, memberId }
}

async function hasUsableOrganizationSso(organizationId: OrganizationId) {
  const rows = await db
    .select({ id: SsoConnectionTable.id })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, eq(SsoConnectionTable.providerId, SsoProviderTable.providerId))
    .where(and(
      eq(SsoConnectionTable.organizationId, organizationId),
      eq(SsoConnectionTable.status, "enabled"),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .limit(1)
  return Boolean(rows[0])
}

async function hasOrganizationScim(organizationId: OrganizationId) {
  const rows = await db
    .select({ id: ScimProviderTable.id })
    .from(ScimProviderTable)
    .where(eq(ScimProviderTable.organizationId, organizationId))
    .limit(1)
  return Boolean(rows[0])
}

export async function updateOrganizationAdmissionPolicy(input: {
  organizationId: OrganizationId
  actorUserId: UserId
  expectedVersion: number
  admissionMethods: OrganizationAdmissionMethod[]
  emailDomainRule: OrganizationAdmissionPolicy["emailDomainRule"]
  authenticationRequirement: OrganizationAuthenticationRequirement
  lifecycleAuthority: OrganizationLifecycleAuthority
}) {
  const admissionMethods = normalizeAdmissionMethods(input.admissionMethods)
  if (admissionMethods.length === 0) {
    throw new OrganizationAdmissionPolicyValidationError("admission_methods_required", "Choose at least one way people can join this organization.")
  }
  const normalizedDomains = input.emailDomainRule.mode === "allowlist"
    ? normalizeAdmissionDomains(input.emailDomainRule.domains)
    : { domains: [], invalid: [] }
  if (normalizedDomains.invalid.length > 0 || (input.emailDomainRule.mode === "allowlist" && normalizedDomains.domains.length === 0)) {
    throw new OrganizationAdmissionPolicyValidationError("domain_allowlist_required", "Add at least one valid email domain.")
  }

  if (admissionMethods.includes("sso_jit") || input.authenticationRequirement === "organization_sso") {
    if (!await hasUsableOrganizationSso(input.organizationId)) {
      throw new OrganizationAdmissionPolicyValidationError("organization_sso_required", "Configure and verify organization SSO before enabling this policy.")
    }
  }
  if (admissionMethods.includes("scim") && !await hasOrganizationScim(input.organizationId)) {
    throw new OrganizationAdmissionPolicyValidationError("scim_provider_required", "Configure SCIM before enabling SCIM admission.")
  }
  if (input.lifecycleAuthority === "scim") {
    if (admissionMethods.length !== 1 || admissionMethods[0] !== "scim") {
      throw new OrganizationAdmissionPolicyValidationError("scim_lifecycle_invalid", "SCIM-managed lifecycle requires SCIM as the only admission method.")
    }
  }

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ version: OrganizationAdmissionPolicyTable.version })
      .from(OrganizationAdmissionPolicyTable)
      .where(eq(OrganizationAdmissionPolicyTable.organizationId, input.organizationId))
      .for("update")
      .limit(1)
    if (rows[0]?.version !== input.expectedVersion) {
      throw new OrganizationAdmissionConflictError()
    }
    if (admissionMethods.includes("sso_jit") || input.authenticationRequirement === "organization_sso") {
      const ssoRows = await tx
        .select({ providerId: SsoConnectionTable.providerId })
        .from(SsoConnectionTable)
        .innerJoin(SsoProviderTable, eq(SsoConnectionTable.providerId, SsoProviderTable.providerId))
        .where(and(
          eq(SsoConnectionTable.organizationId, input.organizationId),
          eq(SsoConnectionTable.status, "enabled"),
          eq(SsoProviderTable.domainVerified, true),
        ))
        .for("update")
        .limit(1)
      if (!ssoRows[0]) {
        throw new OrganizationAdmissionPolicyValidationError("organization_sso_required", "Configure and verify organization SSO before enabling this policy.")
      }
    }
    if (admissionMethods.includes("scim")) {
      const scimRows = await tx
        .select({ providerId: ScimProviderTable.providerId })
        .from(ScimProviderTable)
        .where(eq(ScimProviderTable.organizationId, input.organizationId))
        .for("update")
        .limit(1)
      if (!scimRows[0]) {
        throw new OrganizationAdmissionPolicyValidationError("scim_provider_required", "Configure SCIM before enabling SCIM admission.")
      }
    }
    await tx
      .update(OrganizationAdmissionPolicyTable)
      .set({
        version: input.expectedVersion + 1,
        admissionMethods,
        emailDomainMode: input.emailDomainRule.mode,
        allowedEmailDomains: normalizedDomains.domains,
        authenticationRequirement: input.authenticationRequirement,
        lifecycleAuthority: input.lifecycleAuthority,
      })
      .where(eq(OrganizationAdmissionPolicyTable.organizationId, input.organizationId))

    const orgRows = await tx
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId))
      .limit(1)
    const metadata = normalizeOrganizationMetadata(orgRows[0]?.metadata).metadata
    await tx
      .update(OrganizationTable)
      .set({
        allowedEmailDomains: normalizedDomains.domains.length > 0 ? normalizedDomains.domains : null,
        metadata: {
          ...metadata,
          requireSso: input.authenticationRequirement === "organization_sso",
        },
      })
      .where(eq(OrganizationTable.id, input.organizationId))
  })

  await recordOrganizationAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: ORGANIZATION_AUDIT_ACTIONS.admissionPolicyUpdated,
    payload: {
      policyVersion: input.expectedVersion + 1,
      methods: admissionMethods.join(","),
      authenticationRequirement: input.authenticationRequirement,
      lifecycleAuthority: input.lifecycleAuthority,
    },
  })
  return getOrganizationAdmissionPolicy(input.organizationId)
}

async function getSsoConnection(organizationId: OrganizationId) {
  const rows = await db
    .select({
      providerId: SsoConnectionTable.providerId,
      signInPath: SsoConnectionTable.signInPath,
    })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, eq(SsoConnectionTable.providerId, SsoProviderTable.providerId))
    .where(and(
      eq(SsoConnectionTable.organizationId, organizationId),
      eq(SsoConnectionTable.status, "enabled"),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function evaluateAdmission(input: OrganizationAdmissionAttempt): Promise<EvaluatedAdmission> {
  const policyPromise = env.orgMode === "single_org"
    ? ensureOrganizationAdmissionPolicy(input.organizationId)
    : getOrganizationAdmissionPolicy(input.organizationId)
  const [organizationRows, policy, userRows, memberRows] = await Promise.all([
    db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, input.organizationId)).limit(1),
    policyPromise,
    db
      .select({ email: AuthUserTable.email, emailVerified: AuthUserTable.emailVerified })
      .from(AuthUserTable)
      .where(eq(AuthUserTable.id, input.userId))
      .limit(1),
    db
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId)))
      .limit(1),
  ])
  if (!organizationRows[0]) {
    return { decision: { decision: "deny", reason: "organization_unavailable" }, existingMember: null, invitation: null }
  }
  if (!policy) {
    return { decision: { decision: "deny", reason: "policy_unavailable" }, existingMember: memberRows[0] ?? null, invitation: null }
  }
  const user = userRows[0]
  if (!user) {
    return { decision: { decision: "deny", reason: "identity_conflict" }, existingMember: memberRows[0] ?? null, invitation: null }
  }
  const existingMember = memberRows[0] ?? null
  if (existingMember && !existingMember.removedAt) {
    return {
      decision: {
        decision: "allow",
        role: existingMember.role,
        source: existingMember.admissionSource ?? "legacy",
        policyVersion: existingMember.admissionPolicyVersion ?? policy.version,
        membershipId: existingMember.id,
        existing: true,
      },
      existingMember,
      invitation: null,
    }
  }
  if (existingMember?.removedAt) {
    const evidenceKind = input.evidence.kind
    const invitationRestore = evidenceKind === "invitation"
    const adminRestore = evidenceKind === "admin_restore"
    const scimRestore = evidenceKind === "scim" && policy.lifecycleAuthority === "scim"
    const voluntaryRejoin = existingMember.removalSource === "self" && evidenceKind === "self_join"
    if (!invitationRestore && !adminRestore && !scimRestore && !voluntaryRejoin) {
      return { decision: { decision: "deny", reason: "membership_removed" }, existingMember, invitation: null }
    }
  }

  const [ssoAvailable, scimAvailable] = await Promise.all([
    policy.admissionMethods.includes("sso_jit") || policy.authenticationRequirement === "organization_sso"
      ? hasUsableOrganizationSso(input.organizationId)
      : true,
    policy.admissionMethods.includes("scim") || policy.lifecycleAuthority === "scim"
      ? hasOrganizationScim(input.organizationId)
      : true,
  ])
  if (!ssoAvailable || !scimAvailable) {
    return { decision: { decision: "deny", reason: "policy_unavailable" }, existingMember, invitation: null }
  }

  let invitation: InvitationRow | null = null
  let workspaceClaim: WorkspaceClaimRow | null = null
  let source: OrganizationAdmissionSource
  let role: string

  switch (input.evidence.kind) {
    case "invitation": {
      if (!policy.admissionMethods.includes("invitation")) {
        return { decision: { decision: "deny", reason: "admission_method_disabled" }, existingMember, invitation: null }
      }
      const tokenHash = hashOrganizationInvitationToken(input.evidence.token)
      const rows = await db
        .select()
        .from(InvitationTable)
        .where(and(
          eq(InvitationTable.organizationId, input.organizationId),
          eq(InvitationTable.inviteTokenHash, tokenHash),
          eq(InvitationTable.status, "pending"),
          gt(InvitationTable.expiresAt, new Date()),
        ))
        .limit(1)
      invitation = rows[0] ?? null
      if (!invitation || normalizeAdmissionEmail(invitation.email) !== normalizeAdmissionEmail(user.email)) {
        return { decision: { decision: "deny", reason: "invitation_invalid" }, existingMember, invitation: null }
      }
      if (roleIncludesOwner(invitation.role)) {
        return { decision: { decision: "deny", reason: "owner_role_forbidden" }, existingMember, invitation }
      }
      source = "invitation"
      role = invitation.role
      break
    }
    case "self_join":
      if (!policy.admissionMethods.includes("self_join")) {
        if (policy.admissionMethods.length === 1 && policy.admissionMethods[0] === "scim") {
          return { decision: { decision: "require_scim_provisioning" }, existingMember, invitation: null }
        }
        return { decision: { decision: "require_invitation" }, existingMember, invitation: null }
      }
      source = "self_join"
      role = "member"
      break
    case "sso": {
      const connection = await getSsoConnection(input.organizationId)
      if (!connection || connection.providerId !== input.evidence.providerId) {
        return { decision: { decision: "deny", reason: "provider_mismatch" }, existingMember, invitation: null }
      }
      if (policy.admissionMethods.includes("invitation")) {
        const invitationRows = await db
          .select()
          .from(InvitationTable)
          .where(and(
            eq(InvitationTable.organizationId, input.organizationId),
            eq(InvitationTable.email, normalizeAdmissionEmail(user.email) ?? ""),
            eq(InvitationTable.status, "pending"),
            gt(InvitationTable.expiresAt, new Date()),
          ))
          .limit(1)
        invitation = invitationRows[0] ?? null
      }
      if (invitation) {
        source = "invitation"
        role = invitation.role
        break
      }
      if (!policy.admissionMethods.includes("sso_jit")) {
        return { decision: { decision: "require_invitation" }, existingMember, invitation: null }
      }
      source = "sso_jit"
      role = "member"
      break
    }
    case "scim": {
      const rows = await db
        .select({ providerId: ScimProviderTable.providerId })
        .from(ScimProviderTable)
        .where(eq(ScimProviderTable.organizationId, input.organizationId))
        .limit(1)
      if (!rows[0] || rows[0].providerId !== input.evidence.providerId || !input.evidence.active) {
        return { decision: { decision: "deny", reason: "provider_mismatch" }, existingMember, invitation: null }
      }
      if (!policy.admissionMethods.includes("scim")) {
        return { decision: { decision: "deny", reason: "admission_method_disabled" }, existingMember, invitation: null }
      }
      source = "scim"
      role = "member"
      break
    }
    case "workspace_claim": {
      const claimRows = await db
        .select({ claim: WorkspaceClaimTable })
        .from(WorkspaceClaimTable)
        .innerJoin(WorkspaceBootstrapTable, eq(WorkspaceClaimTable.bootstrapId, WorkspaceBootstrapTable.id))
        .where(and(
          eq(WorkspaceClaimTable.organizationId, input.organizationId),
          eq(WorkspaceClaimTable.tokenHash, hashOrganizationInvitationToken(input.evidence.token)),
          eq(WorkspaceClaimTable.status, "pending"),
          gt(WorkspaceClaimTable.expiresAt, new Date()),
          eq(WorkspaceBootstrapTable.status, "provisional"),
          gt(WorkspaceBootstrapTable.expiresAt, new Date()),
        ))
        .limit(1)
      workspaceClaim = claimRows[0]?.claim ?? null
      if (!workspaceClaim) {
        return { decision: { decision: "deny", reason: "identity_conflict" }, existingMember, invitation: null }
      }
      source = "workspace_claim"
      role = workspaceClaim.role
      break
    }
    case "admin_restore":
      {
        const actorRows = await db
          .select({ role: MemberTable.role })
          .from(MemberTable)
          .where(and(
            eq(MemberTable.id, normalizeDenTypeId("member", input.evidence.actorMemberId)),
            eq(MemberTable.organizationId, input.organizationId),
            isNull(MemberTable.removedAt),
          ))
          .limit(1)
        const actorRole = actorRows[0]?.role
        if (!actorRole || (!roleIncludesOwner(actorRole) && !roleIncludes(actorRole, "admin"))) {
          return { decision: { decision: "deny", reason: "identity_conflict" }, existingMember, invitation: null }
        }
      }
      source = "admin_restore"
      role = input.evidence.role
      break
  }

  const providerAuthoritative = input.evidence.kind === "sso" || input.evidence.kind === "scim"
  const emailBased = !providerAuthoritative && (source === "self_join" || source === "invitation" || source === "workspace_claim")
  if (emailBased && !user.emailVerified) {
    return { decision: { decision: "require_email_verification" }, existingMember, invitation }
  }
  if ((input.evidence.kind === "self_join" || input.evidence.kind === "invitation") && !emailAllowed(policy, user.email)) {
    return { decision: { decision: "deny", reason: "domain_not_allowed" }, existingMember, invitation }
  }
  if (roleIncludesOwner(role) && source !== "workspace_claim") {
    return { decision: { decision: "deny", reason: "owner_role_forbidden" }, existingMember, invitation }
  }
  if (source !== "workspace_claim") {
    const requestedRoles = role.split(",").map((entry) => entry.trim()).filter(Boolean)
    const availableRoles = await db
      .select({ role: OrganizationRoleTable.role })
      .from(OrganizationRoleTable)
      .where(eq(OrganizationRoleTable.organizationId, input.organizationId))
    const allowedRoles = new Set(["owner", "admin", "member", ...availableRoles.map((entry) => entry.role)])
    if (requestedRoles.length === 0 || requestedRoles.some((entry) => !allowedRoles.has(entry))) {
      return { decision: { decision: "deny", reason: "identity_conflict" }, existingMember, invitation }
    }
  }

  if (policy.authenticationRequirement === "organization_sso" && source !== "sso_jit" && source !== "scim") {
    const connection = await getSsoConnection(input.organizationId)
    if (!connection) {
      return { decision: { decision: "deny", reason: "policy_unavailable" }, existingMember, invitation }
    }
    const assured = input.assurance?.organizationId === input.organizationId
      && input.assurance.providerId === connection.providerId
    if (!assured) {
      return {
        decision: {
          decision: "require_sso",
          signInUrl: new URL(connection.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
        },
        existingMember,
        invitation,
      }
    }
  }

  const seat = await getOrganizationSeatAddEligibility(input.organizationId)
  if (!seat.allowed) {
    return { decision: { decision: "deny", reason: "seat_limit_reached" }, existingMember, invitation }
  }

  return {
    decision: {
      decision: "allow",
      role,
      source,
      policyVersion: policy.version,
      existing: false,
      ...(existingMember ? { membershipId: existingMember.id } : {}),
    },
    existingMember,
    invitation,
    workspaceClaim,
  }
}

export async function evaluateOrganizationAdmission(input: OrganizationAdmissionAttempt) {
  const evaluated = await evaluateAdmission(input)
  await auditAdmissionEvaluation(input, evaluated.decision)
  return evaluated.decision
}

export async function evaluateOrganizationSessionAssurance(input: {
  organizationId: OrganizationId
  sessionId: string | null | undefined
}): Promise<Extract<AdmissionDecision, { decision: "require_sso" | "deny" }> | null> {
  const policy = env.orgMode === "single_org"
    ? await ensureOrganizationAdmissionPolicy(input.organizationId)
    : await getOrganizationAdmissionPolicy(input.organizationId)
  if (!policy || policy.authenticationRequirement !== "organization_sso") {
    return policy ? null : { decision: "deny", reason: "policy_unavailable" }
  }
  const connection = await getSsoConnection(input.organizationId)
  if (!connection) {
    return { decision: "deny", reason: "policy_unavailable" }
  }
  let sessionId
  try {
    sessionId = input.sessionId ? normalizeDenTypeId("session", input.sessionId) : null
  } catch {
    sessionId = null
  }
  const sessionRows = sessionId
    ? await db
        .select({
          providerId: AuthSessionTable.authenticationProviderId,
          organizationId: AuthSessionTable.authenticationOrganizationId,
        })
        .from(AuthSessionTable)
        .where(eq(AuthSessionTable.id, sessionId))
        .limit(1)
    : []
  if (
    sessionRows[0]?.providerId === connection.providerId
    && sessionRows[0].organizationId === input.organizationId
  ) {
    return null
  }
  return {
    decision: "require_sso",
    signInUrl: new URL(connection.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
  }
}

async function auditAdmissionDecision(input: OrganizationAdmissionAttempt, decision: AdmissionDecision) {
  if (decision.decision === "allow") {
    await recordOrganizationAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.admissionAllowed,
      payload: {
        decision: decision.decision,
        source: decision.source,
        policyVersion: decision.policyVersion,
        enforcementMode: env.organizationAdmissionEnforcement,
        membershipId: decision.membershipId ?? null,
      },
    })
    return
  }
  await recordOrganizationAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.admissionDenied,
    payload: {
      decision: decision.decision,
      reason: decision.decision === "deny" ? decision.reason : decision.decision,
      enforcementMode: env.organizationAdmissionEnforcement,
    },
  })
}

async function auditAdmissionEvaluation(input: OrganizationAdmissionAttempt, decision: AdmissionDecision) {
  admissionEvaluationCounter.add(1, {
    method: input.evidence.kind,
    decision: decision.decision,
    reason: decision.decision === "deny" ? decision.reason : decision.decision,
    policy_version: decision.decision === "allow" ? decision.policyVersion : 0,
    enforcement_mode: env.organizationAdmissionEnforcement,
  })
  await recordOrganizationAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.admissionEvaluated,
    payload: {
      method: input.evidence.kind,
      decision: decision.decision,
      reason: decision.decision === "deny" ? decision.reason : decision.decision,
      policyVersion: decision.decision === "allow" ? decision.policyVersion : null,
      enforcementMode: env.organizationAdmissionEnforcement,
      membershipId: decision.decision === "allow" ? decision.membershipId ?? null : null,
    },
  })
}

export async function admitOrganizationMember(input: OrganizationAdmissionAttempt) {
  const evaluated = await evaluateAdmission(input)
  await auditAdmissionEvaluation(input, evaluated.decision)
  if (evaluated.decision.decision !== "allow") {
    await auditAdmissionDecision(input, evaluated.decision)
    return evaluated.decision
  }
  if (evaluated.decision.existing) return evaluated.decision
  const decision = evaluated.decision
  const now = new Date()

  const commitResult = await db.transaction(async (tx) => {
    const policyRows = await tx
      .select({
        version: OrganizationAdmissionPolicyTable.version,
        emailDomainMode: OrganizationAdmissionPolicyTable.emailDomainMode,
        allowedEmailDomains: OrganizationAdmissionPolicyTable.allowedEmailDomains,
      })
      .from(OrganizationAdmissionPolicyTable)
      .where(eq(OrganizationAdmissionPolicyTable.organizationId, input.organizationId))
      .for("update")
      .limit(1)
    if (policyRows[0]?.version !== decision.policyVersion) {
      throw new OrganizationAdmissionConflictError()
    }
    const lockedPolicy = policyRows[0]

    const userRows = await tx
      .select({ email: AuthUserTable.email, emailVerified: AuthUserTable.emailVerified })
      .from(AuthUserTable)
      .where(eq(AuthUserTable.id, input.userId))
      .for("update")
      .limit(1)
    const lockedUser = userRows[0]
    if (!lockedUser) throw new OrganizationAdmissionConflictError()
    const providerAuthoritative = input.evidence.kind === "sso" || input.evidence.kind === "scim"
    const emailBased = !providerAuthoritative
      && (decision.source === "self_join" || decision.source === "invitation" || decision.source === "initial_owner" || decision.source === "workspace_claim")
    if (emailBased && !lockedUser.emailVerified) throw new OrganizationAdmissionConflictError()
    if (input.evidence.kind === "self_join" || input.evidence.kind === "invitation") {
      const domain = emailDomain(lockedUser.email)
      if (lockedPolicy.emailDomainMode === "allowlist" && (!domain || !lockedPolicy.allowedEmailDomains.includes(domain))) {
        throw new OrganizationAdmissionConflictError()
      }
    }

    if (input.evidence.kind === "sso") {
      const providerRows = await tx
        .select({ providerId: SsoConnectionTable.providerId })
        .from(SsoConnectionTable)
        .innerJoin(SsoProviderTable, eq(SsoConnectionTable.providerId, SsoProviderTable.providerId))
        .where(and(
          eq(SsoConnectionTable.organizationId, input.organizationId),
          eq(SsoConnectionTable.providerId, input.evidence.providerId),
          eq(SsoConnectionTable.status, "enabled"),
          eq(SsoProviderTable.domainVerified, true),
        ))
        .for("update")
        .limit(1)
      if (!providerRows[0]) throw new OrganizationAdmissionConflictError()
    }
    if (input.evidence.kind === "scim") {
      const providerRows = await tx
        .select({ providerId: ScimProviderTable.providerId })
        .from(ScimProviderTable)
        .where(and(
          eq(ScimProviderTable.organizationId, input.organizationId),
          eq(ScimProviderTable.providerId, input.evidence.providerId),
        ))
        .for("update")
        .limit(1)
      if (!providerRows[0] || !input.evidence.active) throw new OrganizationAdmissionConflictError()
    }
    if (input.evidence.kind === "admin_restore") {
      const actorRows = await tx
        .select({ role: MemberTable.role })
        .from(MemberTable)
        .where(and(
          eq(MemberTable.id, normalizeDenTypeId("member", input.evidence.actorMemberId)),
          eq(MemberTable.organizationId, input.organizationId),
          isNull(MemberTable.removedAt),
        ))
        .for("update")
        .limit(1)
      const actorRole = actorRows[0]?.role
      if (!actorRole || (!roleIncludesOwner(actorRole) && !roleIncludes(actorRole, "admin"))) {
        throw new OrganizationAdmissionConflictError()
      }
    }

    const lockedInvitation = evaluated.invitation
      ? (await tx
          .select()
          .from(InvitationTable)
          .where(eq(InvitationTable.id, evaluated.invitation.id))
          .for("update")
          .limit(1))[0] ?? null
      : null
    if (evaluated.invitation && (
      !lockedInvitation
      || lockedInvitation.status !== "pending"
      || lockedInvitation.expiresAt <= now
      || lockedInvitation.organizationId !== input.organizationId
      || normalizeAdmissionEmail(lockedInvitation.email) !== normalizeAdmissionEmail(evaluated.invitation.email)
      || normalizeAdmissionEmail(lockedInvitation.email) !== normalizeAdmissionEmail(lockedUser.email)
      || (input.evidence.kind === "invitation" && lockedInvitation.inviteTokenHash !== hashOrganizationInvitationToken(input.evidence.token))
    )) {
      throw new OrganizationAdmissionConflictError()
    }

    const lockedWorkspaceClaim = evaluated.workspaceClaim
      ? (await tx
          .select()
          .from(WorkspaceClaimTable)
          .where(eq(WorkspaceClaimTable.id, evaluated.workspaceClaim.id))
          .for("update")
          .limit(1))[0] ?? null
      : null
    const lockedWorkspaceBootstrap = lockedWorkspaceClaim
      ? (await tx
          .select()
          .from(WorkspaceBootstrapTable)
          .where(eq(WorkspaceBootstrapTable.id, lockedWorkspaceClaim.bootstrapId))
          .for("update")
          .limit(1))[0] ?? null
      : null
    if (evaluated.workspaceClaim && (
      !lockedWorkspaceClaim
      || !lockedWorkspaceBootstrap
      || lockedWorkspaceClaim.organizationId !== input.organizationId
      || lockedWorkspaceClaim.status !== "pending"
      || lockedWorkspaceClaim.expiresAt <= now
      || lockedWorkspaceClaim.tokenHash !== hashOrganizationInvitationToken(
        input.evidence.kind === "workspace_claim" ? input.evidence.token : "",
      )
      || lockedWorkspaceBootstrap.organizationId !== input.organizationId
      || lockedWorkspaceBootstrap.status !== "provisional"
      || lockedWorkspaceBootstrap.expiresAt <= now
    )) {
      throw new OrganizationAdmissionConflictError()
    }

    const memberRows = await tx
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId)))
      .for("update")
      .limit(1)
    const existingMember = memberRows[0] ?? null
    if (existingMember && !existingMember.removedAt) {
      return { outcome: "existing" as const, member: existingMember }
    }

    // The policy row lock serializes membership commits for this organization.
    // Rechecking capacity here makes concurrent admissions observe the member
    // committed by the preceding transaction before consuming evidence.
    const seat = await getOrganizationSeatAddEligibility(input.organizationId)
    if (!seat.allowed) {
      return { outcome: "seat_limit" as const }
    }

    if (decision.source !== "initial_owner" && decision.source !== "workspace_claim") {
      const requestedRoles = decision.role.split(",").map((entry) => entry.trim()).filter(Boolean)
      const availableRoles = await tx
        .select({ role: OrganizationRoleTable.role })
        .from(OrganizationRoleTable)
        .where(eq(OrganizationRoleTable.organizationId, input.organizationId))
        .for("update")
      const allowedRoles = new Set(["owner", "admin", "member", ...availableRoles.map((entry) => entry.role)])
      if (requestedRoles.length === 0 || requestedRoles.some((entry) => !allowedRoles.has(entry))) {
        throw new OrganizationAdmissionConflictError()
      }
    }

    let memberId = existingMember?.id ?? createDenTypeId("member")

    if (existingMember) {
      await tx
        .update(MemberTable)
        .set({
          role: decision.role,
          joinedAt: now,
          admissionSource: decision.source,
          admissionPolicyVersion: decision.policyVersion,
          admittedAt: now,
          removedAt: null,
          removedByOrgMember: null,
          removalSource: null,
        })
        .where(eq(MemberTable.id, existingMember.id))
    } else {
      const invitedMemberRows = lockedInvitation
        ? await tx
            .select()
            .from(MemberTable)
            .where(and(
              eq(MemberTable.organizationId, input.organizationId),
              eq(MemberTable.inviteId, lockedInvitation.id),
              isNull(MemberTable.userId),
              isNull(MemberTable.removedAt),
            ))
            .for("update")
            .limit(1)
        : []
      const invitedMember = invitedMemberRows[0] ?? null
      if (invitedMember) {
        memberId = invitedMember.id
        await tx
          .update(MemberTable)
          .set({
            userId: input.userId,
            role: decision.role,
            joinedAt: now,
            admissionSource: decision.source,
            admissionPolicyVersion: decision.policyVersion,
            admittedAt: now,
          })
          .where(eq(MemberTable.id, invitedMember.id))
      } else {
        await tx.insert(MemberTable).values({
          id: memberId,
          organizationId: input.organizationId,
          userId: input.userId,
          role: decision.role,
          joinedAt: now,
          admissionSource: decision.source,
          admissionPolicyVersion: decision.policyVersion,
          admittedAt: now,
        })
      }
    }

    if (lockedInvitation) {
      // Reactivating a retained subject membership supersedes the invitation's
      // user-less placeholder; one organization/subject pair keeps one row.
      await tx
        .delete(MemberTable)
        .where(and(
          eq(MemberTable.organizationId, input.organizationId),
          eq(MemberTable.inviteId, lockedInvitation.id),
          isNull(MemberTable.userId),
        ))
      if (lockedInvitation.teamId) {
        const teamRows = await tx
          .select({ id: TeamTable.id })
          .from(TeamTable)
          .where(and(
            eq(TeamTable.id, lockedInvitation.teamId),
            eq(TeamTable.organizationId, input.organizationId),
          ))
          .limit(1)
        if (teamRows[0]) {
          const teamMemberRows = await tx
            .select({ id: TeamMemberTable.id })
            .from(TeamMemberTable)
            .where(and(
              eq(TeamMemberTable.teamId, lockedInvitation.teamId),
              eq(TeamMemberTable.orgMembershipId, memberId),
            ))
            .limit(1)
          if (!teamMemberRows[0]) {
            await tx.insert(TeamMemberTable).values({
              id: createDenTypeId("teamMember"),
              teamId: lockedInvitation.teamId,
              orgMembershipId: memberId,
            })
          }
        }
      }
      await tx
        .update(InvitationTable)
        .set({ status: "accepted", inviteTokenHash: null })
        .where(and(
          eq(InvitationTable.id, lockedInvitation.id),
          eq(InvitationTable.status, "pending"),
        ))
    }

    if (lockedWorkspaceClaim && lockedWorkspaceBootstrap) {
      await tx
        .update(MemberTable)
        .set({ removedAt: now, removalSource: "system" })
        .where(eq(MemberTable.id, lockedWorkspaceBootstrap.setupMemberId))
      await tx
        .update(WorkspaceClaimTable)
        .set({ status: "canceled" })
        .where(and(
          eq(WorkspaceClaimTable.bootstrapId, lockedWorkspaceClaim.bootstrapId),
          eq(WorkspaceClaimTable.status, "pending"),
        ))
      await tx
        .update(WorkspaceClaimTable)
        .set({ status: "claimed", claimedByUserId: input.userId, claimedAt: now })
        .where(eq(WorkspaceClaimTable.id, lockedWorkspaceClaim.id))
      await tx
        .update(WorkspaceBootstrapTable)
        .set({ status: "claimed", claimedAt: now })
        .where(eq(WorkspaceBootstrapTable.id, lockedWorkspaceBootstrap.id))
      const organizationRows = await tx
        .select({ metadata: OrganizationTable.metadata })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, input.organizationId))
        .for("update")
        .limit(1)
      await tx
        .update(OrganizationTable)
        .set({
          metadata: {
            ...(organizationRows[0]?.metadata ?? {}),
            bootstrap: { provisional: false, claimedAt: now.toISOString(), claimedByUserId: input.userId },
          },
        })
        .where(eq(OrganizationTable.id, input.organizationId))
    }

    await tx.insert(AuditEventTable).values(buildOrganizationAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.admissionAllowed,
      payload: {
        decision: "allow",
        source: decision.source,
        policyVersion: decision.policyVersion,
        enforcementMode: env.organizationAdmissionEnforcement,
        membershipId: memberId,
      },
    }))
    if (existingMember?.removedAt) {
      await tx.insert(AuditEventTable).values(buildOrganizationAuditEvent({
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.memberReactivated,
        payload: { membershipId: memberId, source: decision.source, policyVersion: decision.policyVersion },
      }))
    }
    return { outcome: "created" as const, membershipId: memberId }
  })

  if (commitResult.outcome === "existing") {
    return {
      decision: "allow" as const,
      role: commitResult.member.role,
      source: commitResult.member.admissionSource ?? "legacy",
      policyVersion: commitResult.member.admissionPolicyVersion ?? decision.policyVersion,
      membershipId: commitResult.member.id,
      existing: true,
    }
  }
  if (commitResult.outcome === "seat_limit") {
    const denied = { decision: "deny" as const, reason: "seat_limit_reached" as const }
    await auditAdmissionDecision(input, denied)
    return denied
  }

  const membershipId = commitResult.membershipId
  await runPostOrganizationMemberChangeHooks({
    organizationId: input.organizationId,
    memberId: membershipId,
    change: "added",
  })
  const committed: AdmissionDecision = { ...decision, membershipId }
  return committed
}

export async function finalizeGrantedOrganizationMembership(input: {
  organizationId: OrganizationId
  userId: UserId
  decision: Extract<AdmissionDecision, { decision: "allow" }>
}) {
  const now = new Date()
  await db
    .update(MemberTable)
    .set({
      admissionSource: input.decision.source,
      admissionPolicyVersion: input.decision.policyVersion,
      admittedAt: now,
      removalSource: null,
    })
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      eq(MemberTable.userId, input.userId),
      isNull(MemberTable.removedAt),
    ))
  const memberRows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      eq(MemberTable.userId, input.userId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const member = memberRows[0]
  if (!member) return
  await recordOrganizationAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.admissionAllowed,
    payload: {
      decision: "allow",
      source: input.decision.source,
      policyVersion: input.decision.policyVersion,
      enforcementMode: env.organizationAdmissionEnforcement,
      membershipId: member.id,
    },
  })
  await runPostOrganizationMemberChangeHooks({
    organizationId: input.organizationId,
    memberId: member.id,
    change: "added",
  })
}

export async function retainRemovedOrganizationMembership(input: {
  id: MemberRow["id"]
  organizationId: OrganizationId
  userId: UserId
  inviteId?: MemberRow["inviteId"]
  invitedByOrgMember?: MemberRow["invitedByOrgMember"]
  role: string
  joinedAt?: Date | null
  admissionSource?: MemberRow["admissionSource"]
  admissionPolicyVersion?: number | null
  admittedAt?: Date | null
  removedAt?: Date
  removalSource: "admin" | "self" | "scim" | "system"
  createdAt?: Date
}) {
  await db.insert(MemberTable).values({
    id: input.id,
    organizationId: input.organizationId,
    userId: input.userId,
    inviteId: input.inviteId ?? null,
    invitedByOrgMember: input.invitedByOrgMember ?? null,
    role: input.role,
    joinedAt: input.joinedAt ?? null,
    admissionSource: input.admissionSource ?? "legacy",
    admissionPolicyVersion: input.admissionPolicyVersion ?? 1,
    admittedAt: input.admittedAt ?? input.createdAt ?? new Date(),
    removedAt: input.removedAt ?? new Date(),
    removedByOrgMember: null,
    removalSource: input.removalSource,
    createdAt: input.createdAt ?? new Date(),
  })
}

export async function preserveLegacyOrganizationAdmissionInShadow(input: {
  organizationId: OrganizationId
  userId: UserId
  method: OrganizationAdmissionMethod
  role?: string
  evaluatedDecision: AdmissionDecision
}) {
  if (env.organizationAdmissionEnforcement !== "shadow") return null
  const policy = await getOrganizationAdmissionPolicy(input.organizationId)
  if (!policy) return null
  const rows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId)))
    .limit(1)
  const existing = rows[0] ?? null
  if (existing?.removedAt) return null
  if (existing) {
    await db
      .update(MemberTable)
      .set({
        admissionSource: existing.admissionSource ?? "legacy",
        admissionPolicyVersion: existing.admissionPolicyVersion ?? policy.version,
        admittedAt: existing.admittedAt ?? new Date(),
      })
      .where(eq(MemberTable.id, existing.id))
    await recordOrganizationAuditEvent({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.admissionShadowMismatch,
      payload: {
        method: input.method,
        evaluatedDecision: input.evaluatedDecision.decision,
        reason: input.evaluatedDecision.decision === "deny" ? input.evaluatedDecision.reason : input.evaluatedDecision.decision,
        policyVersion: policy.version,
        effectiveDecision: "allow",
        membershipId: existing.id,
      },
    })
    admissionShadowMismatchCounter.add(1, {
      method: input.method,
      evaluated_decision: input.evaluatedDecision.decision,
      reason: input.evaluatedDecision.decision === "deny" ? input.evaluatedDecision.reason : input.evaluatedDecision.decision,
      policy_version: policy.version,
      effective_decision: "allow",
    })
    return existing.id
  }

  const membershipId = createDenTypeId("member")
  try {
    await db.insert(MemberTable).values({
      id: membershipId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role ?? "member",
      joinedAt: new Date(),
      admissionSource: "legacy",
      admissionPolicyVersion: policy.version,
      admittedAt: new Date(),
    })
  } catch {
    const concurrent = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
      .limit(1)
    if (!concurrent[0]) throw new OrganizationAdmissionConflictError()
    return concurrent[0].id
  }
  await recordOrganizationAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.admissionShadowMismatch,
    payload: {
      method: input.method,
      evaluatedDecision: input.evaluatedDecision.decision,
      reason: input.evaluatedDecision.decision === "deny" ? input.evaluatedDecision.reason : input.evaluatedDecision.decision,
      policyVersion: policy.version,
      effectiveDecision: "allow",
      membershipId,
    },
  })
  admissionShadowMismatchCounter.add(1, {
    method: input.method,
    evaluated_decision: input.evaluatedDecision.decision,
    reason: input.evaluatedDecision.decision === "deny" ? input.evaluatedDecision.reason : input.evaluatedDecision.decision,
    policy_version: policy.version,
    effective_decision: "allow",
  })
  return membershipId
}

export function normalizeOrganizationId(value: string) {
  return normalizeDenTypeId("organization", value)
}

export function normalizeOrganizationUserId(value: string) {
  return normalizeDenTypeId("user", value)
}
