import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  SessionSsoAuthenticationTable,
  SsoConnectionTable,
  SsoProviderTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { organizationFeatureEnabled } from "./features.js"
import {
  blocksNonSsoSignIn,
  organizationRequiresSsoSession,
  readOrganizationSsoPolicy,
  type DomainSsoRequirement,
  type SignInSsoCandidate,
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
  const rows = await readSsoOrganizations(and(eq(SsoConnectionTable.domain, domain), eq(SsoProviderTable.domain, domain)))
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
    ? await readSsoOrganizations(and(eq(SsoConnectionTable.domain, domain), eq(SsoProviderTable.domain, domain)))
    : []
  const rows = [...memberRows, ...domainRows.filter((row) => !memberRows.some((member) => member.organizationId === row.organizationId))]
  if (rows.length === 0) return null

  const perOrganization = await readSsoPerOrganization(rows.map((row) => row.organizationId))
  for (const row of rows) {
    const candidate: SignInSsoCandidate = {
      organizationId: row.organizationId,
      policy: readOrganizationSsoPolicy(row.metadata),
      perOrganization: perOrganization.get(row.organizationId) === true,
      emailOnVerifiedDomain: domain !== null && row.domain === domain,
      member: memberOrganizationIds.includes(row.organizationId),
    }
    if (blocksNonSsoSignIn(candidate)) {
      return { organizationSlug: row.organizationSlug, signInPath: row.signInPath || defaultSignInPath(row.organizationSlug) }
    }
  }
  return null
}

/**
 * Organizations among `organizationIds` that only a session signed in through
 * their own SSO may open: `ssoPerOrganization` on, SSO enabled on a verified
 * domain, and "Require SSO" (or a restricted domain) set.
 */
export async function findSsoRequiredOrganizations(organizationIds: readonly string[]): Promise<Map<string, SsoAccessBlock>> {
  const result = new Map<string, SsoAccessBlock>()
  const ids = [...new Set(organizationIds.map((id) => normalizeDenTypeId("organization", id)))]
  if (ids.length === 0 || env.orgMode === "single_org") return result
  // The flag first (cached), so organizations without it cost no extra query.
  const perOrganization = await readSsoPerOrganization(ids)
  const enabledIds = ids.filter((id) => perOrganization.get(id) === true)
  if (enabledIds.length === 0) return result
  const rows = await readSsoOrganizations(inArray(OrganizationTable.id, enabledIds))
  for (const row of rows) {
    if (!organizationRequiresSsoSession(readOrganizationSsoPolicy(row.metadata))) continue
    result.set(row.organizationId, {
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      organizationName: row.organizationName,
      signInPath: row.signInPath || defaultSignInPath(row.organizationSlug),
    })
  }
  return result
}

/** The organizations this session signed in to through SSO. */
async function readSessionSsoOrganizationIds(sessionId: string): Promise<Set<string>> {
  // primary: the row is written by the SSO callback that created the session.
  const rows = await db.$primary
    .select({ organizationId: SessionSsoAuthenticationTable.organizationId })
    .from(SessionSsoAuthenticationTable)
    .where(eq(SessionSsoAuthenticationTable.sessionId, normalizeDenTypeId("session", sessionId)))
  return new Set(rows.map((row) => row.organizationId))
}

/**
 * Organizations among `organizationIds` this session may not open until it
 * signs in through their SSO. A request without a session (an API key, an
 * MCP token) is checked where that credential was issued instead.
 */
export async function findSsoBlockedOrganizations(input: { sessionId: string | null; organizationIds: readonly string[] }): Promise<Map<string, SsoAccessBlock>> {
  const required = await findSsoRequiredOrganizations(input.organizationIds)
  if (required.size === 0) return required
  const signedIn = input.sessionId ? await readSessionSsoOrganizationIds(input.sessionId) : new Set<string>()
  for (const organizationId of signedIn) required.delete(organizationId)
  return required
}

/**
 * Whether this session may turn on "Require SSO" (or restrict the domain) for
 * the organization without losing access to it: the organization has no
 * enabled SSO on a verified domain yet (nothing is enforced), or the session
 * signed in through it.
 */
export async function sessionCanRequireOrganizationSso(input: { sessionId: string | null; organizationId: string }) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!(await readSsoPerOrganization([organizationId])).get(organizationId)) return true
  const rows = await readSsoOrganizations(eq(OrganizationTable.id, organizationId))
  if (rows.length === 0) return true
  if (!input.sessionId) return false
  return (await readSessionSsoOrganizationIds(input.sessionId)).has(organizationId)
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
export async function recordSessionSsoAuthentication(input: { sessionId: string; userId: string; providerId: string | null }) {
  // A historical account link is not evidence for this session. A callback
  // without an authenticated provider reference must fail closed.
  const provider = input.providerId ? await providerOrganization(input.providerId) : null
  if (!provider) return
  await db.insert(SessionSsoAuthenticationTable).values({
    sessionId: normalizeDenTypeId("session", input.sessionId),
    userId: normalizeDenTypeId("user", input.userId),
    organizationId: provider.organizationId,
    ssoProviderId: provider.providerId,
  }).onDuplicateKeyUpdate({ set: { organizationId: provider.organizationId, ssoProviderId: provider.providerId } })
}

/** Copy only the provider proof captured by the approving browser. */
export async function recordDeviceSessionSsoAuthentication(input: { sessionId: string; userId: string; organizationId: OrgId | string; providerId: string }) {
  const provider = await providerOrganization(input.providerId)
  if (!provider || provider.organizationId !== normalizeDenTypeId("organization", input.organizationId)) return
  await recordSessionSsoAuthentication(input)
}

export async function deleteSessionSsoAuthentication(sessionId: string) {
  await db.delete(SessionSsoAuthenticationTable).where(eq(SessionSsoAuthenticationTable.sessionId, normalizeDenTypeId("session", sessionId)))
}
