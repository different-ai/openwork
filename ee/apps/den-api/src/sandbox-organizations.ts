import { and, count, desc, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ExternalMcpConnectionTable,
  GatewayProviderTable,
  MemberTable,
  OrganizationTable,
  SandboxOrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  SANDBOX_WORKPLACE_APPS,
  type Sandbox,
  type SandboxDefaults,
  type SandboxCreateInput,
  type SandboxJoinPreview,
  type SandboxJoinRole,
  type SandboxState,
} from "@openwork/types/den/sandbox-organizations"
import { customAlphabet } from "nanoid"
import { externalMcpOAuthConfigurationDefaults } from "./capability-sources/external-mcp-auth-policy.js"
import { createExternalMcpConnection } from "./capability-sources/external-mcp-connections.js"
import { assertPublicUrl } from "./capability-sources/url-guard.js"
import { db } from "./db.js"
import { appLogger } from "./observability/logger.js"
import { addSandboxGatewayProvider, sandboxGatewayConfigured } from "./sandbox-gateway.js"
import { updateOrganizationMetadata } from "./organization-metadata.js"
import { env } from "./env.js"
import { updateOrganizationFeatureOverrides } from "./features.js"
import { cache } from "./cache.js"
import { ensureMemberGatewayKey } from "./gateway-keys.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { createOrganizationForUser, isEmailAllowedForOrganization, updateOrganizationMemberRole } from "./orgs.js"
import { getInvitationOrigin } from "./routes/org/shared.js"

type UserId = DenTypeId<"user">
type SandboxRow = typeof SandboxOrganizationTable.$inferSelect

const DAY_MS = 86_400_000
const createJoinToken = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 32)

export class SandboxInputError extends Error {}

/** Organization metadata key holding what joiners become; missing means admin (sandboxes are for trying everything). */
const SANDBOX_JOIN_ROLE_KEY = "sandboxJoinRole"

function readJoinRole(metadata: unknown): SandboxJoinRole {
  let record: unknown = metadata
  if (typeof metadata === "string") {
    try { record = JSON.parse(metadata) } catch { record = null }
  }
  return typeof record === "object" && record !== null && !Array.isArray(record) && Object.entries(record).some(([key, value]) => key === SANDBOX_JOIN_ROLE_KEY && value === "member") ? "member" : "admin"
}

async function writeJoinRole(organizationId: DenTypeId<"organization">, joinRole: SandboxJoinRole) {
  await updateOrganizationMetadata(organizationId, current => ({ ...current, [SANDBOX_JOIN_ROLE_KEY]: joinRole }))
}

/** Makes people who joined as members admins, through the normal role change (audit, caches, key rotation). */
async function promoteJoinedMembers(organizationId: DenTypeId<"organization">, onlyUserId?: DenTypeId<"user">) {
  const members = await db.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, organizationId),
    eq(MemberTable.role, "member"),
    isNull(MemberTable.removedAt),
    isNotNull(MemberTable.joinedAt),
    ...(onlyUserId ? [eq(MemberTable.userId, onlyUserId)] : []),
  ))
  for (const member of members) await updateOrganizationMemberRole({ organizationId, memberId: member.id, nextRole: "admin" })
}

export function sandboxJoinLink(token: string) {
  return new URL(`/join-sandbox?token=${encodeURIComponent(token)}`, getInvitationOrigin()).toString()
}

export function sandboxState(row: Pick<SandboxRow, "closedAt" | "expiresAt">, now = new Date()): SandboxState {
  if (row.closedAt) return "closed"
  return row.expiresAt <= now ? "expired" : "open"
}

export function sandboxConnectorUrls(baseUrl: string) {
  const root = baseUrl.replace(/\/+$/, "")
  return SANDBOX_WORKPLACE_APPS.map(app => ({ ...app, url: `${root}/${app.key}/mcp` }))
}

async function serialize(rows: SandboxRow[], now = new Date()): Promise<Sandbox[]> {
  if (rows.length === 0) return []
  const ids = rows.map(row => row.organizationId)
  const [orgs, members, connectors] = await Promise.all([
    db.select({ id: OrganizationTable.id, name: OrganizationTable.name, allowedEmailDomains: OrganizationTable.allowedEmailDomains, metadata: OrganizationTable.metadata })
      .from(OrganizationTable).where(inArray(OrganizationTable.id, ids)),
    db.select({ organizationId: MemberTable.organizationId, total: count() }).from(MemberTable)
      .where(and(inArray(MemberTable.organizationId, ids), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt)))
      .groupBy(MemberTable.organizationId),
    db.select({ organizationId: ExternalMcpConnectionTable.organizationId, total: count() }).from(ExternalMcpConnectionTable)
      .where(inArray(ExternalMcpConnectionTable.organizationId, ids))
      .groupBy(ExternalMcpConnectionTable.organizationId),
  ])
  const org = new Map(orgs.map(row => [row.id, row]))
  const memberCount = new Map(members.map(row => [row.organizationId, Number(row.total)]))
  const connectorCount = new Map(connectors.map(row => [row.organizationId, Number(row.total)]))
  const providerRows = await db.select({ organizationId: GatewayProviderTable.organization_id, total: count() }).from(GatewayProviderTable)
    .where(inArray(GatewayProviderTable.organization_id, ids)).groupBy(GatewayProviderTable.organization_id)
  const providerCount = new Map(providerRows.map(row => [row.organizationId, Number(row.total)]))
  return rows.map(row => ({
    id: row.id,
    organizationId: row.organizationId,
    name: org.get(row.organizationId)?.name ?? "Deleted organization",
    state: sandboxState(row, now),
    joinLink: sandboxJoinLink(row.joinToken),
    memberCount: memberCount.get(row.organizationId) ?? 0,
    memberLimit: row.memberLimit,
    connectorBaseUrl: row.connectorBaseUrl,
    connectorCount: connectorCount.get(row.organizationId) ?? 0,
    modelProviderCount: providerCount.get(row.organizationId) ?? 0,
    allowedEmailDomains: org.get(row.organizationId)?.allowedEmailDomains ?? [],
    joinRole: readJoinRole(org.get(row.organizationId)?.metadata),
    expiresAt: row.expiresAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * Records sandboxes whose time ran out as closed. Free Auto already stops at expiry without this (Den API and the
 * Gateway check the sandbox row: sandboxFreeAutoStopped). Membership, connectors and data stay; extending the
 * sandbox reopens it. Runs whenever sandboxes are listed or joined.
 */
export async function closeExpiredSandboxes(now = new Date()) {
  const rows = await db.select().from(SandboxOrganizationTable).where(isNull(SandboxOrganizationTable.closedAt))
  for (const row of rows) {
    if (row.expiresAt > now) continue
    await db.update(SandboxOrganizationTable).set({ closedAt: now }).where(and(eq(SandboxOrganizationTable.id, row.id), isNull(SandboxOrganizationTable.closedAt)))
  }
}

export function sandboxDefaults(): SandboxDefaults {
  const gateway = sandboxGatewayConfigured() ? env.sandbox.gateway : null
  return { workplaceUrl: env.sandbox.workplaceUrl, gatewayModels: gateway?.modelIds ?? [], gatewayProviderId: gateway?.providerId ?? null }
}

export async function listSandboxes(): Promise<Sandbox[]> {
  await closeExpiredSandboxes()
  const rows = await db.select().from(SandboxOrganizationTable).orderBy(desc(SandboxOrganizationTable.createdAt)).limit(200)
  return serialize(rows)
}

export async function getSandbox(id: DenTypeId<"sandboxOrganization">): Promise<Sandbox | null> {
  const rows = await db.select().from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.id, id)).limit(1)
  return (await serialize(rows))[0] ?? null
}

/**
 * Creates an ordinary organization owned by the admin, then makes it a sandbox: included models on (Workbot
 * defaults to them), Free Auto until the sandbox closes or expires, one per-person OAuth
 * connector for each fictional workplace app, and a join link. Every member connects their own account, so
 * each person's workplace data stays separate.
 */
export async function createSandbox(actor: UserId, input: SandboxCreateInput): Promise<Sandbox> {
  const connectors = input.connectorBaseUrl ? sandboxConnectorUrls(input.connectorBaseUrl) : []
  if (!env.allowPrivateMcpUrls) {
    for (const connector of connectors) {
      try { await assertPublicUrl(connector.url) }
      catch (error) { throw new SandboxInputError(error instanceof Error ? error.message : "Connector address not allowed.") }
    }
  }
  if (env.orgMode === "single_org") throw new SandboxInputError("This deployment has one organization; sandboxes need multi-organization mode.")

  const organizationId = await createOrganizationForUser({ userId: actor, name: input.name })
  const expiresAt = new Date(Date.now() + input.days * DAY_MS)
  const id = createDenTypeId("sandboxOrganization")
  // Record the sandbox first so a later failure still leaves it visible (and closable) in /admin.
  await db.insert(SandboxOrganizationTable).values({
    id, organizationId, joinToken: createJoinToken(), connectorBaseUrl: input.connectorBaseUrl,
    memberLimit: input.memberLimit, expiresAt, createdByUserId: actor,
  })
  await writeJoinRole(organizationId, input.joinRole ?? "admin")
  if (input.allowedEmailDomains.length > 0) {
    await db.update(OrganizationTable).set({ allowedEmailDomains: [...new Set(input.allowedEmailDomains)] }).where(eq(OrganizationTable.id, organizationId))
  }

  await updateOrganizationFeatureOverrides({
    organizationId,
    changes: { workbotIncludedModels: true },
    source: "platform",
    setByUserId: actor,
  })

  const [owner] = await db.select({ id: MemberTable.id }).from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, actor), isNull(MemberTable.removedAt))).limit(1)
  if (!owner) throw new Error("sandbox_owner_missing")
  // Models through the AI Gateway for everyone, from the deployment's sandbox key. A failure leaves the sandbox on
  // its included models and is visible as zero model providers in /admin.
  await addSandboxGatewayProvider({ organizationId, ownerMemberId: owner.id }).catch((error: unknown) => {
    appLogger.error("sandbox gateway provider failed", { organization_id: organizationId, error: error instanceof Error ? error.message : "unknown" })
  })
  if (connectors.length > 0) {
    for (const connector of connectors) {
      await createExternalMcpConnection({
        organizationId,
        name: connector.name,
        externalKey: `sandbox-${connector.key}`,
        url: connector.url,
        authType: "oauth",
        credentialMode: "per_member",
        exposeDirectly: true,
        oauthConfiguration: { version: 1, ...externalMcpOAuthConfigurationDefaults({ url: connector.url }) },
        createdByOrgMembershipId: owner.id,
        access: { orgWide: true, memberIds: [], teamIds: [] },
      })
    }
  }

  const created = await getSandbox(id)
  if (!created) throw new Error("sandbox_missing_after_create")
  return created
}

/** Changes what people who join become. Choosing admin also makes everyone who already joined an admin; choosing member demotes nobody. */
export async function setSandboxJoinRole(id: DenTypeId<"sandboxOrganization">, joinRole: SandboxJoinRole) {
  const [row] = await db.select({ organizationId: SandboxOrganizationTable.organizationId }).from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.id, id)).limit(1)
  if (!row) return null
  await writeJoinRole(row.organizationId, joinRole)
  if (joinRole === "admin") await promoteJoinedMembers(row.organizationId)
  return getSandbox(id)
}

export async function rotateSandboxLink(id: DenTypeId<"sandboxOrganization">) {
  const [row] = await db.select({ id: SandboxOrganizationTable.id }).from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.id, id)).limit(1)
  if (!row) return null
  await db.update(SandboxOrganizationTable).set({ joinToken: createJoinToken() }).where(eq(SandboxOrganizationTable.id, id))
  return getSandbox(id)
}

/** Adds days from now, or from the current end if it is later, and reopens a closed or expired sandbox. */
export async function extendSandbox(id: DenTypeId<"sandboxOrganization">, days: number) {
  const [row] = await db.select().from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.id, id)).limit(1)
  if (!row) return null
  const start = Math.max(Date.now(), row.expiresAt.getTime())
  await db.update(SandboxOrganizationTable).set({ expiresAt: new Date(start + days * DAY_MS), closedAt: null }).where(eq(SandboxOrganizationTable.id, id))
  return getSandbox(id)
}

/** Stops new joins and Free Auto now (sandboxFreeAutoStopped). The organization, its members and their data are kept. */
export async function closeSandbox(id: DenTypeId<"sandboxOrganization">) {
  const [row] = await db.select().from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.id, id)).limit(1)
  if (!row) return null
  if (!row.closedAt) await db.update(SandboxOrganizationTable).set({ closedAt: new Date() }).where(eq(SandboxOrganizationTable.id, id))
  return getSandbox(id)
}

async function findByToken(token: string) {
  if (!/^[0-9A-Za-z]{32}$/.test(token)) return null
  const [row] = await db.select().from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.joinToken, token)).limit(1)
  return row ?? null
}

async function joinedMemberCount(organizationId: DenTypeId<"organization">) {
  const [row] = await db.select({ total: count() }).from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt)))
  return Number(row?.total ?? 0)
}

export async function previewSandboxJoin(token: string): Promise<(SandboxJoinPreview & { organizationId: DenTypeId<"organization"> }) | null> {
  const row = await findByToken(token)
  if (!row) return null
  const [org] = await db.select({ name: OrganizationTable.name, metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, row.organizationId)).limit(1)
  if (!org) return null
  const state = sandboxState(row)
  const full = state === "open" && await joinedMemberCount(row.organizationId) >= row.memberLimit
  return {
    organizationId: row.organizationId,
    organizationName: org.name,
    state: full ? "full" : state,
    joinRole: readJoinRole(org.metadata),
    expiresAt: row.expiresAt.toISOString(),
    connectors: row.connectorBaseUrl ? SANDBOX_WORKPLACE_APPS.map(app => app.name) : [],
  }
}

export type SandboxJoinResult =
  | { status: "joined"; organizationId: DenTypeId<"organization">; alreadyMember: boolean }
  | { status: "not_found" | "closed" | "expired" | "full" | "removed" | "email_verification_required" }
  | { status: "domain_not_allowed"; allowedEmailDomains: string[] }

/**
 * Joins the signed-in person with the sandbox's join role (member unless an admin chose admin; never owner). Idempotent for existing members. The sandbox row is
 * locked while seats are counted and the membership is written, so concurrent joins cannot exceed the seat limit.
 */
export async function joinSandbox(input: { token: string; userId: string; email: string; emailVerified: boolean }): Promise<SandboxJoinResult> {
  const found = await findByToken(input.token)
  if (!found) return { status: "not_found" }
  const userId = normalizeDenTypeId("user", input.userId)
  const result = await db.transaction(async (tx): Promise<SandboxJoinResult | { status: "added"; organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }> => {
    const [row] = await tx.select().from(SandboxOrganizationTable).where(eq(SandboxOrganizationTable.id, found.id)).limit(1).for("update")
    if (!row || row.joinToken !== input.token) return { status: "not_found" }
    const members = await tx.select({ userId: MemberTable.userId, removedAt: MemberTable.removedAt }).from(MemberTable)
      .where(and(eq(MemberTable.organizationId, row.organizationId), isNotNull(MemberTable.joinedAt)))
    const mine = members.filter(member => member.userId === userId)
    if (mine.some(member => member.removedAt === null)) return { status: "joined", organizationId: row.organizationId, alreadyMember: true }
    if (mine.length > 0) return { status: "removed" }

    const state = sandboxState(row)
    if (state !== "open") return { status: state }
    const [org] = await tx.select({ allowedEmailDomains: OrganizationTable.allowedEmailDomains, metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, row.organizationId)).limit(1)
    if (!org) return { status: "not_found" }
    if (!isEmailAllowedForOrganization(org.allowedEmailDomains, input.email)) return { status: "domain_not_allowed", allowedEmailDomains: org.allowedEmailDomains ?? [] }
    // A domain limit is only as strong as the email proof behind it.
    if ((org.allowedEmailDomains?.length ?? 0) > 0 && !input.emailVerified) return { status: "email_verification_required" }
    if (members.filter(member => member.removedAt === null).length >= row.memberLimit) return { status: "full" }

    const memberId = createDenTypeId("member")
    // Members by default; an admin chose "admin" for this sandbox. Never owner.
    await tx.insert(MemberTable).values({ id: memberId, organizationId: row.organizationId, userId, role: readJoinRole(org.metadata), joinedAt: new Date() })
    return { status: "added", organizationId: row.organizationId, memberId }
  })
  if (result.status === "expired") await closeExpiredSandboxes()
  if (result.status === "joined" && result.alreadyMember) {
    // Someone who joined as a member before the sandbox became admin-joining is promoted when they open the link again.
    const [org] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, result.organizationId)).limit(1)
    if (org && readJoinRole(org.metadata) === "admin") await promoteJoinedMembers(result.organizationId, userId)
  }
  if (result.status !== "added") return result
  // Same effects as any other join, after the membership commits: caches, billing quantities and the member's gateway key.
  await cache.org.deleteMemberList(result.organizationId)
  await cache.org.deleteMembership({ organizationId: result.organizationId, userId })
  await runPostOrganizationMemberChangeHooks({ organizationId: result.organizationId, memberId: result.memberId, change: "added" })
  await ensureMemberGatewayKey({ organizationId: result.organizationId, memberId: result.memberId })
  return { status: "joined", organizationId: result.organizationId, alreadyMember: false }
}
