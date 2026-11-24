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
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { ssoConnectionDisplayName, ssoDomainColumnCovers, ssoDomainsCover } from "./sso-domains.js"
import {
  blocksNonSsoSignIn,
  organizationRequiresSsoSession,
  readOrganizationSsoPolicy,
  type DomainSsoRequirement,
  type SignInSsoCandidate,
} from "@openwork-ee/den-sso"

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

export async function readSsoPerOrganization(organizationIds: readonly string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()
  for (const id of new Set(organizationIds)) {
    result.set(id, env.orgMode !== "single_org")
  }
  return result
}

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

export type MemberSsoSignIn = {
  organizationId: string
  organizationSlug: string
  organizationName: string
  signInPath: string
  ssoOnly: boolean
}

export async function listMemberSsoSignIns(userId: string): Promise<MemberSsoSignIn[]> {
  const organizationIds = (await db
    .select({ organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(and(eq(MemberTable.userId, normalizeDenTypeId("user", userId)), isNull(MemberTable.removedAt))))
    .map((row) => row.organizationId)
  if (organizationIds.length === 0) return []

  const rows = await readSsoOrganizations(inArray(OrganizationTable.id, organizationIds))
  const perOrganization = await readSsoPerOrganization(rows.map((row) => row.organizationId))
  const result = new Map<string, MemberSsoSignIn>()
  for (const row of rows) {
    if (result.has(row.organizationId)) continue
    const policy = readOrganizationSsoPolicy(row.metadata)
    result.set(row.organizationId, {
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      organizationName: row.organizationName,
      signInPath: defaultSignInPath(row.organizationSlug),
      ssoOnly: perOrganization.get(row.organizationId) !== true || organizationRequiresSsoSession(policy),
    })
  }
  return [...result.values()]
}

export type SsoSignInOption = {
  providerId: string
  name: string
  kind: "oidc" | "saml"
}

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

async function readSsoRequiredOrganizations(organizationIds: readonly string[]): Promise<Map<string, SsoAccessBlock>> {
  const result = new Map<string, SsoAccessBlock>()
  const ids = [...new Set(organizationIds.map((id) => normalizeDenTypeId("organization", id)))]
  if (ids.length === 0 || env.orgMode === "single_org") return result
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
    })
  }
  return result
}

async function readSessionSsoProofs(sessionId: DenTypeId<"session">): Promise<Map<string, Date>> {
  const rows = await db.$primary
    .select({ organizationId: SessionSsoProofTable.organizationId, authenticatedAt: SessionSsoProofTable.authenticatedAt })
    .from(SessionSsoProofTable)
    .where(eq(SessionSsoProofTable.sessionId, sessionId))
  return new Map(rows.map((row) => [row.organizationId, row.authenticatedAt]))
}

export async function findSsoBlockedOrganizations(input: { sessionId: DenTypeId<"session"> | null; organizationIds: readonly string[] }): Promise<Map<string, SsoAccessBlock>> {
  const required = await readSsoRequiredOrganizations(input.organizationIds)
  const result = new Map<string, SsoAccessBlock>()
  if (required.size === 0) return result
  const proofs = input.sessionId ? await readSessionSsoProofs(input.sessionId) : new Map<string, Date>()
  for (const [organizationId, block] of required) {
    if (proofs.has(organizationId)) continue
    result.set(organizationId, block)
  }
  return result
}

export async function sessionCanRequireOrganizationSso(input: { sessionId: DenTypeId<"session"> | null; organizationId: string }) {
  if (!input.sessionId) return false
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!(await readSsoPerOrganization([organizationId])).get(organizationId)) return true
  const rows = await readSsoOrganizations(eq(OrganizationTable.id, organizationId))
  const row = rows[0]
  if (!row) return true
  return (await readSessionSsoProofs(input.sessionId)).has(organizationId)
}

export async function findSsoAccessBlock(input: { sessionId: DenTypeId<"session"> | null; organizationId: string | null | undefined }): Promise<SsoAccessBlock | null> {
  if (!input.organizationId) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const blocked = await findSsoBlockedOrganizations({ sessionId: input.sessionId, organizationIds: [organizationId] })
  return blocked.get(organizationId) ?? null
}

export const SSO_REQUIRED_MESSAGE = "This organization requires single sign-on. Sign in with its SSO to continue."

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

export async function recordSessionSsoAuthentication(input: { sessionId: string; userId: string; providerId: string | null; authenticatedAt?: Date }) {
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
  await db.insert(SessionSsoAuthenticationTable).values({
    sessionId,
    userId,
    organizationId: provider.organizationId,
    ssoProviderId: provider.providerId,
  }).onDuplicateKeyUpdate({ set: { organizationId: provider.organizationId, ssoProviderId: provider.providerId } })
}

export async function recordDeviceSessionSsoAuthentication(input: { sessionId: string; userId: string; organizationId: OrgId | string; providerId: string; authenticatedAt: Date | null }) {
  const provider = await providerOrganization(input.providerId)
  if (!provider || provider.organizationId !== normalizeDenTypeId("organization", input.organizationId)) return
  await recordSessionSsoAuthentication({ ...input, authenticatedAt: input.authenticatedAt ?? undefined })
}

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
