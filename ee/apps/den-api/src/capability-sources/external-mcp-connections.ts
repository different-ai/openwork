import { createHash } from "node:crypto"
import { and, eq, inArray, isNull, lt, or } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  ExternalMcpOAuthPendingGrantTable,
  McpDiagnosticAttemptTable,
  McpDiagnosticEventTable,
  OrgOAuthClientTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

/**
 * CRUD for ExternalMcpConnectionTable and its access grants — the "add any
 * MCP server" concept. This is the only module that touches these tables
 * directly; the connector (external-mcp-client.ts) and routes go through
 * these functions.
 */

export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
export type ExternalMcpConnectionAccessGrantRow = typeof ExternalMcpConnectionAccessGrantTable.$inferSelect

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type TeamId = DenTypeId<"team">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">
const EXTERNAL_MCP_PENDING_GRANT_TTL_MS = 10 * 60 * 1000
const EXTERNAL_MCP_PENDING_GRANT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000
let pendingGrantCleanupTimer: ReturnType<typeof setInterval> | null = null

function oauthStateHash(signedState: string): string {
  return createHash("sha256").update(signedState).digest("hex")
}

function pendingGrantMemberCondition(orgMembershipId: OrgMembershipId | null) {
  return orgMembershipId
    ? eq(ExternalMcpOAuthPendingGrantTable.orgMembershipId, orgMembershipId)
    : isNull(ExternalMcpOAuthPendingGrantTable.orgMembershipId)
}

export class ExternalMcpPendingGrantError extends Error {
  constructor() {
    super("The pending MCP OAuth authorization is missing, expired, or already consumed.")
    this.name = "ExternalMcpPendingGrantError"
  }
}

export class McpDiagnosticCredentialFenceError extends Error {
  constructor() {
    super("The MCP diagnostic authorization lease is stale or no longer eligible to write credentials.")
    this.name = "McpDiagnosticCredentialFenceError"
  }
}

export class ExternalMcpOAuthClientRevisionError extends Error {
  constructor() {
    super("The MCP OAuth client registration changed after authorization started.")
    this.name = "ExternalMcpOAuthClientRevisionError"
  }
}

export class ExternalMcpCallbackDeadlineError extends Error {
  readonly code = "MCP_LIFECYCLE_DEADLINE"
  constructor() {
    super("The external MCP lifecycle exceeded its deadline before callback credentials could be committed.")
    this.name = "ExternalMcpCallbackDeadlineError"
  }
}

export async function listExternalMcpConnections(organizationId: OrganizationId): Promise<ExternalMcpConnectionRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.organizationId, organizationId))
}

export async function getExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<ExternalMcpConnectionRow | null> {
  const rows = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      eq(ExternalMcpConnectionTable.id, input.connectionId),
    ))
    .limit(1)
  return rows[0] ?? null
}

/** Unscoped lookup by id only — needed for the public OAuth callback, where identity comes from the signed state token, not an authenticated org context. */
export async function getExternalMcpConnectionById(connectionId: ExternalMcpConnectionId): Promise<ExternalMcpConnectionRow | null> {
  const rows = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.id, connectionId))
    .limit(1)
  return rows[0] ?? null
}

export type ExternalMcpAccessInput = {
  orgWide: boolean
  memberIds: OrgMembershipId[]
  teamIds: TeamId[]
}

export async function createExternalMcpConnection(input: {
  organizationId: OrganizationId
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  apiKey?: string | null
  createdByOrgMembershipId: OrgMembershipId
  access: ExternalMcpAccessInput
}): Promise<ExternalMcpConnectionRow> {
  const id = createDenTypeId("externalMcpConnection")
  await db.insert(ExternalMcpConnectionTable).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    credentialMode: input.credentialMode,
    apiKey: input.apiKey ?? null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  await replaceExternalMcpConnectionAccess({
    organizationId: input.organizationId,
    connectionId: id,
    access: input.access,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  const created = await getExternalMcpConnection({ organizationId: input.organizationId, connectionId: id })
  if (!created) throw new Error("Failed to create external MCP connection.")
  return created
}

export async function listExternalMcpConnectionAccess(connectionId: ExternalMcpConnectionId): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId))
}

/** Full-replace semantics (mirrors the LLM-provider access pattern): the caller sends the complete desired access set. */
export async function replaceExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db
    .delete(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId))

  const rows: (typeof ExternalMcpConnectionAccessGrantTable.$inferInsert)[] = []
  if (input.access.orgWide) {
    rows.push({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      orgWide: true,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
  } else {
    for (const memberId of new Set(input.access.memberIds)) {
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        orgMembershipId: memberId,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
    for (const teamId of new Set(input.access.teamIds)) {
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        teamId,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
  }
  if (rows.length > 0) {
    await db.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  }
}

/**
 * The one access predicate: a member can USE a connection when a grant is
 * org-wide, names them directly, or names one of their teams. Access is
 * never implicit — zero grants means zero non-admin access.
 */
export async function listUsableExternalMcpConnections(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}): Promise<ExternalMcpConnectionRow[]> {
  const grantFilter = input.teamIds.length > 0
    ? or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, input.orgMembershipId),
        inArray(ExternalMcpConnectionAccessGrantTable.teamId, input.teamIds),
      )
    : or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, input.orgMembershipId),
      )

  const rows = await db
    .selectDistinct({ connection: ExternalMcpConnectionTable })
    .from(ExternalMcpConnectionTable)
    .innerJoin(
      ExternalMcpConnectionAccessGrantTable,
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, ExternalMcpConnectionTable.id),
    )
    .where(and(eq(ExternalMcpConnectionTable.organizationId, input.organizationId), grantFilter))
  return rows.map((row) => row.connection)
}

export async function memberCanUseExternalMcpConnection(input: {
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}): Promise<boolean> {
  const grants = await listExternalMcpConnectionAccess(input.connectionId)
  const teamIds = new Set<string>(input.teamIds)
  return grants.some((grant) =>
    grant.orgWide
    || grant.orgMembershipId === input.orgMembershipId
    || (grant.teamId ? teamIds.has(grant.teamId) : false))
}

export async function deleteExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (!existing) return false

    // Connection removal is intentionally destructive for its 24-hour
    // diagnostic detail. Audit rows remain in the organization log, while
    // attempt/event rows are removed transactionally so no evidence record
    // points at a connection that no longer exists.
    const diagnosticAttempts = await tx
      .select({ id: McpDiagnosticAttemptTable.id })
      .from(McpDiagnosticAttemptTable)
      .where(and(
        eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
        eq(McpDiagnosticAttemptTable.externalMcpConnectionId, existing.id),
      ))
    const diagnosticAttemptIds = diagnosticAttempts.map((attempt) => attempt.id)
    if (diagnosticAttemptIds.length > 0) {
      await tx.delete(McpDiagnosticEventTable).where(inArray(McpDiagnosticEventTable.attemptId, diagnosticAttemptIds))
      await tx.delete(McpDiagnosticAttemptTable).where(inArray(McpDiagnosticAttemptTable.id, diagnosticAttemptIds))
    }

    // No FK cascades on these tables — clean up everything that hangs off the
    // connection: pending grants, access, every member credential, and the
    // dynamically-registered OAuth client.
    await tx.delete(ExternalMcpOAuthPendingGrantTable).where(eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, existing.id))
    await tx.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, existing.id))
    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, existing.id),
    ))
    await tx.delete(OrgOAuthClientTable).where(and(
      eq(OrgOAuthClientTable.organizationId, input.organizationId),
      eq(OrgOAuthClientTable.providerId, existing.id),
    ))
    await tx.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, existing.id))
    return true
  })
  if (!removed) return false

  // The runner imports this store, so resolve its cancellation hook lazily
  // after the transaction rather than introducing a static module cycle.
  const { cancelExternalMcpDiagnosticExecutionsForConnection } = await import("./external-mcp-diagnostic-runner.js")
  await cancelExternalMcpDiagnosticExecutionsForConnection(input.connectionId)
  return true
}

export async function cleanupExpiredExternalMcpOAuthPendingGrants(now = new Date()): Promise<number> {
  let deleted = 0
  while (true) {
    const expired = await db
      .select({ stateHash: ExternalMcpOAuthPendingGrantTable.stateHash })
      .from(ExternalMcpOAuthPendingGrantTable)
      .where(lt(ExternalMcpOAuthPendingGrantTable.expiresAt, now))
      .limit(200)
    if (expired.length === 0) return deleted
    await db
      .delete(ExternalMcpOAuthPendingGrantTable)
      .where(inArray(ExternalMcpOAuthPendingGrantTable.stateHash, expired.map((row) => row.stateHash)))
    deleted += expired.length
    if (expired.length < 200) return deleted
  }
}

export function startExternalMcpOAuthPendingGrantCleanupLoop(): void {
  if (pendingGrantCleanupTimer) return
  const run = () => {
    void cleanupExpiredExternalMcpOAuthPendingGrants().catch((error) => {
      console.error("external_mcp_pending_oauth_grant_cleanup_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    })
  }
  run()
  pendingGrantCleanupTimer = setInterval(run, EXTERNAL_MCP_PENDING_GRANT_CLEANUP_INTERVAL_MS)
  pendingGrantCleanupTimer.unref()
}

export async function saveExternalMcpOAuthPendingGrant(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId | null
  signedState: string
  codeVerifier: string
  orgOAuthClientId: DenTypeId<"orgOAuthClient">
  clientRevision: number
  diagnosticAttemptId?: DenTypeId<"mcpDiagnosticAttempt"> | null
  diagnosticGeneration?: number | null
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  await cleanupExpiredExternalMcpOAuthPendingGrants(now)
  await db.insert(ExternalMcpOAuthPendingGrantTable).values({
    stateHash: oauthStateHash(input.signedState),
    organizationId: input.organizationId,
    externalMcpConnectionId: input.connectionId,
    orgMembershipId: input.orgMembershipId,
    codeVerifier: input.codeVerifier,
    orgOAuthClientId: input.orgOAuthClientId,
    clientRevision: input.clientRevision,
    diagnosticAttemptId: input.diagnosticAttemptId ?? null,
    diagnosticGeneration: input.diagnosticGeneration ?? null,
    expiresAt: new Date(now.getTime() + EXTERNAL_MCP_PENDING_GRANT_TTL_MS),
    createdAt: now,
  })
}

export type ExternalMcpOAuthPendingGrantBinding = {
  orgOAuthClientId: DenTypeId<"orgOAuthClient">
  clientRevision: number
  diagnosticAttemptId: DenTypeId<"mcpDiagnosticAttempt"> | null
  diagnosticGeneration: number | null
}

export async function getExternalMcpOAuthPendingGrantBinding(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId | null
  signedState: string
  diagnosticAttemptId?: DenTypeId<"mcpDiagnosticAttempt"> | null
  diagnosticGeneration?: number | null
  now?: Date
}): Promise<ExternalMcpOAuthPendingGrantBinding> {
  const now = input.now ?? new Date()
  const rows = await db
    .select()
    .from(ExternalMcpOAuthPendingGrantTable)
    .where(and(
      eq(ExternalMcpOAuthPendingGrantTable.stateHash, oauthStateHash(input.signedState)),
      eq(ExternalMcpOAuthPendingGrantTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, input.connectionId),
      pendingGrantMemberCondition(input.orgMembershipId),
      input.diagnosticAttemptId
        ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId, input.diagnosticAttemptId)
        : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId),
      input.diagnosticGeneration !== undefined && input.diagnosticGeneration !== null
        ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration, input.diagnosticGeneration)
        : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration),
    ))
    .limit(1)
  const grant = rows[0]
  if (!grant || grant.expiresAt.getTime() <= now.getTime()) throw new ExternalMcpPendingGrantError()
  return {
    orgOAuthClientId: grant.orgOAuthClientId,
    clientRevision: grant.clientRevision,
    diagnosticAttemptId: grant.diagnosticAttemptId,
    diagnosticGeneration: grant.diagnosticGeneration,
  }
}

/**
 * Reads the callback's PKCE verifier without consuming it. The grant is locked,
 * validated, and deleted later in the same transaction that persists tokens, so
 * a failed or timed-out token exchange leaves every durable callback artifact
 * unchanged while concurrent successful callbacks still have one CAS winner.
 */
export async function getExternalMcpOAuthPendingGrantForCallback(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId | null
  signedState: string
  diagnosticAttemptId?: DenTypeId<"mcpDiagnosticAttempt"> | null
  diagnosticGeneration?: number | null
  now?: Date
}): Promise<ExternalMcpOAuthPendingGrantBinding & { codeVerifier: string }> {
  const now = input.now ?? new Date()
  const rows = await db
    .select()
    .from(ExternalMcpOAuthPendingGrantTable)
    .where(and(
      eq(ExternalMcpOAuthPendingGrantTable.stateHash, oauthStateHash(input.signedState)),
      eq(ExternalMcpOAuthPendingGrantTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, input.connectionId),
      pendingGrantMemberCondition(input.orgMembershipId),
      input.diagnosticAttemptId
        ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId, input.diagnosticAttemptId)
        : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId),
      input.diagnosticGeneration !== undefined && input.diagnosticGeneration !== null
        ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration, input.diagnosticGeneration)
        : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration),
    ))
    .limit(1)
  const grant = rows[0]
  if (!grant || grant.expiresAt.getTime() <= now.getTime()) throw new ExternalMcpPendingGrantError()
  return {
    codeVerifier: grant.codeVerifier,
    orgOAuthClientId: grant.orgOAuthClientId,
    clientRevision: grant.clientRevision,
    diagnosticAttemptId: grant.diagnosticAttemptId,
    diagnosticGeneration: grant.diagnosticGeneration,
  }
}

export async function consumeExternalMcpOAuthPendingGrant(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId | null
  signedState: string
  diagnosticAttemptId?: DenTypeId<"mcpDiagnosticAttempt"> | null
  diagnosticGeneration?: number | null
  now?: Date
}): Promise<ExternalMcpOAuthPendingGrantBinding & { codeVerifier: string }> {
  const stateHash = oauthStateHash(input.signedState)
  const now = input.now ?? new Date()
  const grant = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ExternalMcpOAuthPendingGrantTable)
      .where(and(
        eq(ExternalMcpOAuthPendingGrantTable.stateHash, stateHash),
        eq(ExternalMcpOAuthPendingGrantTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, input.connectionId),
        pendingGrantMemberCondition(input.orgMembershipId),
        input.diagnosticAttemptId
          ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId, input.diagnosticAttemptId)
          : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId),
        input.diagnosticGeneration !== undefined && input.diagnosticGeneration !== null
          ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration, input.diagnosticGeneration)
          : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration),
      ))
      .limit(1)
      .for("update")
    const grant = rows[0]
    if (!grant) throw new ExternalMcpPendingGrantError()

    await tx
      .delete(ExternalMcpOAuthPendingGrantTable)
      .where(eq(ExternalMcpOAuthPendingGrantTable.stateHash, stateHash))
    if (grant.expiresAt.getTime() <= now.getTime()) return null
    return {
      codeVerifier: grant.codeVerifier,
      orgOAuthClientId: grant.orgOAuthClientId,
      clientRevision: grant.clientRevision,
      diagnosticAttemptId: grant.diagnosticAttemptId,
      diagnosticGeneration: grant.diagnosticGeneration,
    }
  })
  if (!grant) throw new ExternalMcpPendingGrantError()
  return grant
}

export async function deleteExternalMcpOAuthPendingGrant(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId | null
  signedState: string
}): Promise<void> {
  await db
    .delete(ExternalMcpOAuthPendingGrantTable)
    .where(and(
      eq(ExternalMcpOAuthPendingGrantTable.stateHash, oauthStateHash(input.signedState)),
      eq(ExternalMcpOAuthPendingGrantTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, input.connectionId),
      pendingGrantMemberCondition(input.orgMembershipId),
    ))
}

export async function saveExternalMcpPendingCodeVerifier(input: {
  connectionId: ExternalMcpConnectionId
  codeVerifier: string
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ pendingCodeVerifier: input.codeVerifier })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function saveExternalMcpTokens(input: {
  connectionId: ExternalMcpConnectionId
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: Date | null
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      accessToken: input.accessToken,
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      pendingCodeVerifier: null,
      connectedAt: new Date(),
    })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function saveExternalMcpCallbackTokens(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId | null
  orgOAuthClientId: DenTypeId<"orgOAuthClient">
  clientRevision: number
  diagnosticFence?: {
    attemptId: DenTypeId<"mcpDiagnosticAttempt">
    generation: number
    leaseId: string
  }
  pendingGrant: {
    signedState: string
    diagnosticAttemptId?: DenTypeId<"mcpDiagnosticAttempt"> | null
    diagnosticGeneration?: number | null
  }
  lifecycleDeadlineAt?: Date
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: Date | null
  now?: Date
}): Promise<void> {
  const stateHash = oauthStateHash(input.pendingGrant.signedState)
  await db.transaction(async (tx) => {
    const grants = await tx
      .select()
      .from(ExternalMcpOAuthPendingGrantTable)
      .where(and(
        eq(ExternalMcpOAuthPendingGrantTable.stateHash, stateHash),
        eq(ExternalMcpOAuthPendingGrantTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, input.connectionId),
        pendingGrantMemberCondition(input.orgMembershipId),
        input.pendingGrant.diagnosticAttemptId
          ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId, input.pendingGrant.diagnosticAttemptId)
          : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticAttemptId),
        input.pendingGrant.diagnosticGeneration !== undefined && input.pendingGrant.diagnosticGeneration !== null
          ? eq(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration, input.pendingGrant.diagnosticGeneration)
          : isNull(ExternalMcpOAuthPendingGrantTable.diagnosticGeneration),
      ))
      .limit(1)
      .for("update")
    const grant = grants[0]
    if (
      !grant
      || grant.orgOAuthClientId !== input.orgOAuthClientId
      || grant.clientRevision !== input.clientRevision
    ) throw new ExternalMcpPendingGrantError()
    if (input.diagnosticFence) {
      if (
        grant.diagnosticAttemptId !== input.diagnosticFence.attemptId
        || grant.diagnosticGeneration !== input.diagnosticFence.generation
      ) throw new McpDiagnosticCredentialFenceError()
    } else if (grant.diagnosticAttemptId !== null || grant.diagnosticGeneration !== null) {
      throw new McpDiagnosticCredentialFenceError()
    }

    const clients = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.id, input.orgOAuthClientId),
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connectionId),
        eq(OrgOAuthClientTable.revision, input.clientRevision),
      ))
      .limit(1)
      .for("update")
    if (!clients[0]) throw new ExternalMcpOAuthClientRevisionError()

    let diagnosticAttempt: typeof McpDiagnosticAttemptTable.$inferSelect | undefined
    if (input.diagnosticFence) {
      const attempts = await tx
        .select()
        .from(McpDiagnosticAttemptTable)
        .where(and(
          eq(McpDiagnosticAttemptTable.id, input.diagnosticFence.attemptId),
          eq(McpDiagnosticAttemptTable.organizationId, input.organizationId),
          eq(McpDiagnosticAttemptTable.externalMcpConnectionId, input.connectionId),
          eq(McpDiagnosticAttemptTable.authorizationGeneration, input.diagnosticFence.generation),
          eq(McpDiagnosticAttemptTable.authorizationClaimId, input.diagnosticFence.leaseId),
        ))
        .limit(1)
        .for("update")
      diagnosticAttempt = attempts[0]
    }

    const connections = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.id, input.connectionId),
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("update")
    const connection = connections[0]
    if (!connection) throw new ExternalMcpOAuthClientRevisionError()

    // Evaluate all time fences only after every row that can block this callback
    // is locked. A callback that lost its absolute deadline or diagnostic lease
    // must roll back before credentials or the one-time grant are mutated.
    const now = input.now ?? new Date()
    if (grant.expiresAt.getTime() <= now.getTime()) throw new ExternalMcpPendingGrantError()
    if (input.lifecycleDeadlineAt && input.lifecycleDeadlineAt.getTime() <= now.getTime()) {
      throw new ExternalMcpCallbackDeadlineError()
    }
    if (
      input.diagnosticFence
      && (
        !diagnosticAttempt
        || diagnosticAttempt.status !== "waiting_for_authorization"
        || !diagnosticAttempt.authorizationLeaseExpiresAt
        || diagnosticAttempt.authorizationLeaseExpiresAt.getTime() <= now.getTime()
        || (input.orgMembershipId !== null && diagnosticAttempt.createdByOrgMembershipId !== input.orgMembershipId)
      )
    ) throw new McpDiagnosticCredentialFenceError()

    if (connection.credentialMode === "per_member") {
      if (!input.orgMembershipId) throw new ExternalMcpOAuthClientRevisionError()
      const accounts = await tx
        .select()
        .from(ConnectedAccountTable)
        .where(and(
          eq(ConnectedAccountTable.organizationId, input.organizationId),
          eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
          eq(ConnectedAccountTable.providerId, input.connectionId),
        ))
        .limit(1)
        .for("update")
      const existing = accounts[0]
      if (existing) {
        await tx
          .update(ConnectedAccountTable)
          .set({
            accessToken: input.accessToken,
            refreshToken: input.refreshToken ?? existing.refreshToken ?? null,
            tokenType: input.tokenType ?? null,
            scopes: input.scope ? input.scope.split(" ") : null,
            expiresAt: input.expiresAt ?? null,
            pendingCodeVerifier: null,
          })
          .where(eq(ConnectedAccountTable.id, existing.id))
      } else {
        await tx.insert(ConnectedAccountTable).values({
          id: createDenTypeId("connectedAccount"),
          organizationId: input.organizationId,
          orgMembershipId: input.orgMembershipId,
          providerId: input.connectionId,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? null,
          tokenType: input.tokenType ?? null,
          scopes: input.scope ? input.scope.split(" ") : null,
          expiresAt: input.expiresAt ?? null,
          pendingCodeVerifier: null,
        })
      }
    } else {
      await tx
        .update(ExternalMcpConnectionTable)
        .set({
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? connection.refreshToken ?? null,
          tokenType: input.tokenType ?? null,
          scope: input.scope ?? null,
          expiresAt: input.expiresAt ?? null,
          pendingCodeVerifier: null,
          connectedAt: now,
        })
        .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
    }

    if (input.diagnosticFence) {
      // This update is the callback's transactional CAS win. The diagnostic
      // leaves the timeout-eligible waiting state in the same transaction as
      // its credential write, so timeout and callback cannot both win.
      await tx
        .update(McpDiagnosticAttemptTable)
        .set({
          status: "running",
          authorizationClaimId: null,
          authorizationLeaseExpiresAt: null,
        })
        .where(and(
          eq(McpDiagnosticAttemptTable.id, input.diagnosticFence.attemptId),
          eq(McpDiagnosticAttemptTable.authorizationGeneration, input.diagnosticFence.generation),
          eq(McpDiagnosticAttemptTable.authorizationClaimId, input.diagnosticFence.leaseId),
        ))
    }

    await tx
      .delete(ExternalMcpOAuthPendingGrantTable)
      .where(eq(ExternalMcpOAuthPendingGrantTable.stateHash, stateHash))

    // Recheck immediately before the transaction callback returns. If token
    // persistence itself crossed either absolute boundary, throwing here rolls
    // back the credential update, diagnostic CAS, and grant deletion together.
    const commitNow = input.now ?? new Date()
    if (input.lifecycleDeadlineAt && input.lifecycleDeadlineAt.getTime() <= commitNow.getTime()) {
      throw new ExternalMcpCallbackDeadlineError()
    }
    if (
      diagnosticAttempt?.authorizationLeaseExpiresAt
      && diagnosticAttempt.authorizationLeaseExpiresAt.getTime() <= commitNow.getTime()
    ) throw new McpDiagnosticCredentialFenceError()
  })
}

export async function disconnectExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  const existing = await getExternalMcpConnection(input)
  if (!existing) return false
  await db.delete(ExternalMcpOAuthPendingGrantTable).where(eq(ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId, existing.id))
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      scope: null,
      expiresAt: null,
      pendingCodeVerifier: null,
      oauthRegistrationLeaseHash: null,
      oauthRegistrationLeaseExpiresAt: null,
      connectedAt: null,
    })
    .where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
}
