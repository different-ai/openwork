import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  SessionSsoAuthenticationTable,
  SessionSsoProofTable,
  SsoConnectionTable,
  SsoProviderTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { organizationFeatureEnabled } from "./features.js"
import { ssoConnectionDisplayName, ssoDomainColumnCovers, ssoDomainsCover } from "./sso-domains.js"
import {
  blocksNonSsoSignIn,
  organizationRequiresSsoSession,
  readOrganizationSsoPolicy,
  ssoProofIsCurrent,
  type DomainSsoRequirement,
  type SignInSsoCandidate,
  type SsoSessionMaxAgeHours,
} from "./sso-routing.js"

/**
 * Den side of `ssoPerOrganization` (rules in sso-routing.ts): which
 * organizations a session may open, and which sign-ins an organization's SSO
 * still refuses. Every check reads the SSO organization's own flag, so turning
 * it on for one organization changes only that organization.
 */

type OrgId = typeof OrganizationTable.$inferSelect.id

export type SsoAccessBlock = {
  organizationId: string
  organizationSlug: string
  organizationName: string
  signInPath: string
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function emailDomain(email: string) {
  const normalized = normalizeEmail(email)
  const at = normalized.lastIndexOf("@")
  if (at <= 0 || at === normalized.length - 1) return null
  const domain = normalized.slice(at + 1)
  return domain.includes(".") ? domain : null
}

function defaultSignInPath(organizationSlug: string) {
  return `/sso/${encodeURIComponent(organizationSlug)}`
}

export function ssoSignInUrl(signInPath: string) {
  return new URL(signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString()
}

/** Per organization: is `ssoPerOrganization` on? Always off on single-organization deployments. Cached reads. */
export async function readSsoPerOrganization(organizationIds: readonly string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()
  for (const id of new Set(organizationIds)) {
    result.set(id, env.orgMode !== "single_org" && await organizationFeatureEnabled(id, "ssoPerOrganization"))
  }
  return result
}

/** SSO organizations (enabled connection, verified domain) among the given ones, or that own the email's domain. */
async function readSsoOrganizations(where: ReturnType<typeof and>) {
  return db
    .select({
      organizationId: OrganizationTable.id,
      organizationSlug: OrganizationTable.slug,
      organizationName: OrganizationTable.name,
      metadata: OrganizationTable.metadata,
      signInPath: SsoConnectionTable.signInPath,
      domain: SsoConnectionTable.domain,
    })
    .from(OrganizationTable)
    .innerJoin(SsoConnectionTable, and(
      eq(OrganizationTable.id, SsoConnectionTable.organizationId),
      eq(SsoConnectionTable.status, "enabled"),
    ))
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(OrganizationTable.id, SsoProviderTable.organizationId),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .where(where)
}

/**
 * The SSO organization that owns this email's verified domain, with its
 * policy and flag, or null. Same match as findEnterpriseAuthRequirementForEmailDomain.
 */
export async function findDomainSsoRequirement(email: string): Promise<DomainSsoRequirement | null> {
  const domain = emailDomain(email)
  if (!domain) return null
  const rows = await readSsoOrganizations(and(ssoDomainColumnCovers(SsoConnectionTable.domain, domain), ssoDomainColumnCovers(SsoProviderTable.domain, domain)))
  const row = rows[0]
  if (!row) return null
  const perOrganization = (await readSsoPerOrganization([row.organizationId])).get(row.organizationId) === true
  return {
    organizationId: row.organizationId,
    organizationSlug: row.organizationSlug,
    organizationName: row.organizationName,
    signInPath: row.signInPath || defaultSignInPath(row.organizationSlug),
    policy: readOrganizationSsoPolicy(row.metadata),
    perOrganization,
  }
}

/** One identity provider a person can sign in with: a ready connection (enabled, domain verified). */
export type SsoSignInOption = {
  providerId: string
  name: string
  kind: "oidc" | "saml"
}

/**
 * The organization's ready SSO connections, oldest first, for sign-in to
 * show one button each. With an email domain, only those covering it: a
 * provider only signs in people on its own domains.
 */
export async function listOrganizationSsoSignInOptions(input: { organizationSlug: string; emailDomain?: string | null }): Promise<{ organizationName: string; options: SsoSignInOption[] } | null> {
  const [organization] = await db
    .select({ id: OrganizationTable.id, name: OrganizationTable.name })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.slug, input.organizationSlug))
    .limit(1)
  if (!organization) return null
  const rows = await db
    .select({ providerId: SsoConnectionTable.providerId, name: SsoConnectionTable.name, issuer: SsoConnectionTable.issuer, kind: SsoConnectionTable.kind, domain: SsoConnectionTable.domain })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(SsoConnectionTable.organizationId, SsoProviderTable.organizationId),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .where(and(eq(SsoConnectionTable.organizationId, organization.id), eq(SsoConnectionTable.status, "enabled")))
    .orderBy(asc(SsoConnectionTable.createdAt), asc(SsoConnectionTable.id))
  const emailDomain = input.emailDomain?.trim().toLowerCase() || null
  return {
    organizationName: organization.name,
    options: rows
      .filter((row) => !emailDomain || ssoDomainsCover(row.domain, emailDomain))
      .map((row) => ({ providerId: row.providerId, name: ssoConnectionDisplayName(row), kind: row.kind === "saml" ? "saml" : "oidc" })),
  }
}

/**
 * The organization whose SSO refuses this password, Google or other non-SSO
 * sign-in, or null when the sign-in may go ahead. Flag off for an
 * organization: its members must use SSO (unchanged). Flag on: only a
 * restricted domain refuses sign-in.
 */
export async function findNonSsoSignInBlock(input: { email: string | null; userId?: string | null }): Promise<{ organizationSlug: string; signInPath: string } | null> {
  const email = input.email ? normalizeEmail(input.email) : null
  const domain = email ? emailDomain(email) : null
  let userId = input.userId ? normalizeDenTypeId("user", input.userId) : null
  if (!userId && email) {
    const [user] = await db.select({ id: AuthUserTable.id }).from(AuthUserTable).where(eq(AuthUserTable.email, email)).limit(1)
    userId = user?.id ?? null
  }

  const memberOrganizationIds = userId
    ? (await db
      .select({ organizationId: MemberTable.organizationId })
      .from(MemberTable)
      .where(and(eq(MemberTable.userId, userId), isNull(MemberTable.removedAt))))
      .map((row) => row.organizationId)
    : []

  const memberRows = memberOrganizationIds.length > 0
    ? await readSsoOrganizations(inArray(OrganizationTable.id, memberOrganizationIds))
    : []
  const domainRows = domain
    ? await readSsoOrganizations(and(ssoDomainColumnCovers(SsoConnectionTable.domain, domain), ssoDomainColumnCovers(SsoProviderTable.domain, domain)))
    : []
  const rows = [...memberRows, ...domainRows.filter((row) => !memberRows.some((member) => member.organizationId === row.organizationId))]
  if (rows.length === 0) return null

  const perOrganization = await readSsoPerOrganization(rows.map((row) => row.organizationId))
  for (const row of rows) {
    const candidate: SignInSsoCandidate = {
      organizationId: row.organizationId,
      policy: readOrganizationSsoPolicy(row.metadata),
      perOrganization: perOrganization.get(row.organizationId) === true,
      emailOnVerifiedDomain: domain !== null && ssoDomainsCover(row.domain, domain),
      member: memberOrganizationIds.includes(row.organizationId),
    }
    if (blocksNonSsoSignIn(candidate)) {
      return { organizationSlug: row.organizationSlug, signInPath: row.signInPath || defaultSignInPath(row.organizationSlug) }
    }
  }
  return null
}

type SsoRequiredOrganization = SsoAccessBlock & { maxAgeHours: SsoSessionMaxAgeHours | null }

/**
 * Organizations among `organizationIds` that only a session signed in through
 * their own SSO may open: `ssoPerOrganization` on, SSO enabled on a verified
 * domain, and "Require SSO" (or a restricted domain) set.
 */
async function readSsoRequiredOrganizations(organizationIds: readonly string[]): Promise<Map<string, SsoRequiredOrganization>> {
  const result = new Map<string, SsoRequiredOrganization>()
  const ids = [...new Set(organizationIds.map((id) => normalizeDenTypeId("organization", id)))]
  if (ids.length === 0 || env.orgMode === "single_org") return result
  // The flag first (cached), so organizations without it cost no extra query.
  const perOrganization = await readSsoPerOrganization(ids)
  const enabledIds = ids.filter((id) => perOrganization.get(id) === true)
  if (enabledIds.length === 0) return result
  const rows = await readSsoOrganizations(inArray(OrganizationTable.id, enabledIds))
  for (const row of rows) {
    const policy = readOrganizationSsoPolicy(row.metadata)
    if (!organizationRequiresSsoSession(policy)) continue
    result.set(row.organizationId, {
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      organizationName: row.organizationName,
      signInPath: row.signInPath || defaultSignInPath(row.organizationSlug),
      maxAgeHours: policy.ssoSessionMaxAgeHours,
    })
  }
  return result
}

/** When this session proved each organization's SSO (the identity provider's authentication time). */
async function readSessionSsoProofs(sessionId: string): Promise<Map<string, Date>> {
  // primary: the rows are written by the SSO callback that created the session.
  const rows = await db.$primary
    .select({ organizationId: SessionSsoProofTable.organizationId, authenticatedAt: SessionSsoProofTable.authenticatedAt })
    .from(SessionSsoProofTable)
    .where(eq(SessionSsoProofTable.sessionId, normalizeDenTypeId("session", sessionId)))
  return new Map(rows.map((row) => [row.organizationId, row.authenticatedAt]))
}

/**
 * Organizations among `organizationIds` this session may not open until it
 * signs in through their SSO: it never did, or the organization asks for SSO
 * again and that time has passed. A request without a session (an API key,
 * an MCP token) is checked where that credential was issued instead.
 */
export async function findSsoBlockedOrganizations(input: { sessionId: string | null; organizationIds: readonly string[]; now?: Date }): Promise<Map<string, SsoAccessBlock>> {
  const required = await readSsoRequiredOrganizations(input.organizationIds)
  const result = new Map<string, SsoAccessBlock>()
  if (required.size === 0) return result
  const proofs = input.sessionId ? await readSessionSsoProofs(input.sessionId) : new Map<string, Date>()
  const now = input.now ?? new Date()
  for (const [organizationId, { maxAgeHours, ...block }] of required) {
    const authenticatedAt = proofs.get(organizationId)
    if (authenticatedAt && ssoProofIsCurrent({ authenticatedAt, maxAgeHours, now })) continue
    result.set(organizationId, block)
  }
  return result
}

/**
 * Whether this session may turn on "Require SSO" (or restrict the domain) for
 * the organization without losing access to it: the organization has no
 * enabled SSO on a verified domain yet (nothing is enforced), or the session
 * has a current sign-in through it.
 */
export async function sessionCanRequireOrganizationSso(input: { sessionId: string | null; organizationId: string }) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!(await readSsoPerOrganization([organizationId])).get(organizationId)) return true
  const rows = await readSsoOrganizations(eq(OrganizationTable.id, organizationId))
  const row = rows[0]
  if (!row) return true
  if (!input.sessionId) return false
  const authenticatedAt = (await readSessionSsoProofs(input.sessionId)).get(organizationId)
  if (!authenticatedAt) return false
  return ssoProofIsCurrent({ authenticatedAt, maxAgeHours: readOrganizationSsoPolicy(row.metadata).ssoSessionMaxAgeHours, now: new Date() })
}

export async function findSsoAccessBlock(input: { sessionId: string | null; organizationId: string | null | undefined }): Promise<SsoAccessBlock | null> {
  if (!input.organizationId) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const blocked = await findSsoBlockedOrganizations({ sessionId: input.sessionId, organizationIds: [organizationId] })
  return blocked.get(organizationId) ?? null
}

export const SSO_REQUIRED_MESSAGE = "This organization requires single sign-on. Sign in with its SSO to continue."

/** The 403 body every refusal uses, so clients can send the person to the organization's SSO. */
export function ssoRequiredErrorBody(block: SsoAccessBlock) {
  return {
    error: "sso_required" as const,
    message: SSO_REQUIRED_MESSAGE,
    organizationId: block.organizationId,
    organizationSlug: block.organizationSlug,
    organizationName: block.organizationName,
    signInPath: block.signInPath,
    signInUrl: ssoSignInUrl(block.signInPath),
  }
}

async function providerOrganization(providerId: string) {
  const [provider] = await db
    .select({ organizationId: SsoProviderTable.organizationId, providerId: SsoProviderTable.providerId })
    .from(SsoProviderTable)
    .where(eq(SsoProviderTable.providerId, providerId))
    .limit(1)
  return provider ?? null
}

/**
 * Remember that an SSO callback created this session, in the provider's
 * organization. Written for every SSO sign-in, whether or not the flag is on,
 * so turning it on does not send people who just used SSO through it again.
 */
export async function recordSessionSsoAuthentication(input: { sessionId: string; userId: string; providerId: string | null; authenticatedAt?: Date }) {
  // A historical account link is not evidence for this session. A callback
  // without an authenticated provider reference must fail closed.
  const provider = input.providerId ? await providerOrganization(input.providerId) : null
  if (!provider) return
  const sessionId = normalizeDenTypeId("session", input.sessionId)
  const userId = normalizeDenTypeId("user", input.userId)
  const authenticatedAt = input.authenticatedAt ?? new Date()
  await db.insert(SessionSsoProofTable).values({
    sessionId,
    organizationId: provider.organizationId,
    userId,
    ssoProviderId: provider.providerId,
    authenticatedAt,
  }).onDuplicateKeyUpdate({ set: { ssoProviderId: provider.providerId, authenticatedAt } })
  // Replicas from before session_sso_proof read this table (one row per
  // session). Remove once every replica reads session_sso_proof.
  await db.insert(SessionSsoAuthenticationTable).values({
    sessionId,
    userId,
    organizationId: provider.organizationId,
    ssoProviderId: provider.providerId,
  }).onDuplicateKeyUpdate({ set: { organizationId: provider.organizationId, ssoProviderId: provider.providerId } })
}

/** Copy only the provider proof captured by the approving browser, keeping when it was earned. */
export async function recordDeviceSessionSsoAuthentication(input: { sessionId: string; userId: string; organizationId: OrgId | string; providerId: string; authenticatedAt: Date | null }) {
  const provider = await providerOrganization(input.providerId)
  if (!provider || provider.organizationId !== normalizeDenTypeId("organization", input.organizationId)) return
  await recordSessionSsoAuthentication({ ...input, authenticatedAt: input.authenticatedAt ?? undefined })
}

/** The approving session's proof for one organization, for a device approval to snapshot. */
export async function readSessionSsoProof(input: { sessionId: string; userId: string; organizationId: string }) {
  const [proof] = await db.$primary
    .select({ providerId: SessionSsoProofTable.ssoProviderId, authenticatedAt: SessionSsoProofTable.authenticatedAt })
    .from(SessionSsoProofTable)
    .where(and(
      eq(SessionSsoProofTable.sessionId, normalizeDenTypeId("session", input.sessionId)),
      eq(SessionSsoProofTable.userId, normalizeDenTypeId("user", input.userId)),
      eq(SessionSsoProofTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
    ))
    .limit(1)
  return proof ?? null
}

/**
 * The same browser signed in through another organization's SSO: the new
 * session keeps the proofs the session it replaces had earned, with their
 * original times, so the person is not sent through every other
 * organization's SSO again. Only between two live sessions of the same user;
 * a proof the new session already holds is never overwritten.
 */
export async function carrySessionSsoProofs(input: { fromSessionId: string; toSessionId: string; userId: string }) {
  const fromSessionId = normalizeDenTypeId("session", input.fromSessionId)
  const toSessionId = normalizeDenTypeId("session", input.toSessionId)
  const userId = normalizeDenTypeId("user", input.userId)
  if (fromSessionId === toSessionId) return 0
  const [from] = await db.$primary
    .select({ userId: AuthSessionTable.userId, expiresAt: AuthSessionTable.expiresAt })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.id, fromSessionId))
    .limit(1)
  if (!from || from.userId !== userId || from.expiresAt.getTime() <= Date.now()) return 0
  const proofs = await db.$primary
    .select()
    .from(SessionSsoProofTable)
    .where(and(eq(SessionSsoProofTable.sessionId, fromSessionId), eq(SessionSsoProofTable.userId, userId)))
  if (proofs.length === 0) return 0
  await db.insert(SessionSsoProofTable)
    .ignore()
    .values(proofs.map((proof) => ({
      sessionId: toSessionId,
      organizationId: proof.organizationId,
      userId,
      ssoProviderId: proof.ssoProviderId,
      authenticatedAt: proof.authenticatedAt,
    })))
  return proofs.length
}

export async function deleteSessionSsoAuthentication(sessionId: string) {
  const id = normalizeDenTypeId("session", sessionId)
  await db.delete(SessionSsoProofTable).where(eq(SessionSsoProofTable.sessionId, id))
  await db.delete(SessionSsoAuthenticationTable).where(eq(SessionSsoAuthenticationTable.sessionId, id))
}
