import { Buffer } from "node:buffer"
import { and, count, desc, eq, isNotNull, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthUserTable, ExternalIdentityTable, MemberTable, ScimProviderTable, ScimSyncEventTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { auth } from "./auth.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { removeOrganizationMember } from "./orgs.js"
import { verifyStoredScimToken } from "./scim-token-storage.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id
type ScimProvider = typeof ScimProviderTable.$inferSelect
type ScimSyncEvent = typeof ScimSyncEventTable.$inferSelect

export type ScimSyncAction = "sync_resource" | "sync_user_id" | "delete_user" | "reconcile_drift"

const SCIM_SYNC_RETRY_BASE_MS = 60_000
const SCIM_SYNC_MAX_ATTEMPTS = 5

type ScimUserResource = {
  id?: unknown
  externalId?: unknown
  userName?: unknown
  displayName?: unknown
  name?: unknown
  emails?: unknown
  active?: unknown
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8")
}

export function buildOrganizationScimProviderId(organizationId: OrganizationId) {
  return `openwork-scim-${organizationId}`
}

function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function stringifyScimError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2_000)
}

function nextScimRetryAt(attempts: number, now = new Date()) {
  const exponent = Math.max(0, Math.min(attempts, SCIM_SYNC_MAX_ATTEMPTS - 1))
  return new Date(now.getTime() + SCIM_SYNC_RETRY_BASE_MS * 2 ** exponent)
}

export async function resolveScimProviderFromBearerToken(bearerToken: string) {
  let decoded: string
  try {
    decoded = decodeBase64Url(bearerToken)
  } catch {
    return null
  }

  const [rawToken, providerId, ...organizationParts] = decoded.split(":")
  const organizationId = organizationParts.join(":")
  if (!rawToken || !providerId || !organizationId) {
    return null
  }

  const providerRows = await db
    .select()
    .from(ScimProviderTable)
    .where(and(eq(ScimProviderTable.providerId, providerId), eq(ScimProviderTable.organizationId, organizationId as OrganizationId)))
    .limit(1)

  const provider = providerRows[0] ?? null
  if (!provider || !verifyStoredScimToken({ storedToken: provider.scimToken, rawToken })) {
    return null
  }

  return provider
}

async function syncExternalIdentityForProvider(input: {
  provider: ScimProvider
  resource: ScimUserResource
}) {
  const userIdRaw = maybeString(input.resource.id)
  if (!userIdRaw) {
    return false
  }

  let userId: UserId
  try {
    userId = normalizeDenTypeId("user", userIdRaw)
  } catch {
    return false
  }

  const existingRows = await db
    .select()
    .from(ExternalIdentityTable)
    .where(and(eq(ExternalIdentityTable.organizationId, input.provider.organizationId), eq(ExternalIdentityTable.userId, userId)))
    .limit(1)

  const existing = existingRows[0] ?? null
  const now = new Date()
  const payload = {
    organizationId: input.provider.organizationId,
    userId,
    source: existing?.ssoProviderId ? "scim+sso" : "scim",
    scimProviderId: input.provider.providerId,
    ssoProviderId: existing?.ssoProviderId ?? null,
    remoteId: existing?.remoteId ?? null,
    externalId: maybeString(input.resource.externalId),
    userName: maybeString(input.resource.userName),
    email: maybeString(asRecord(asArray(input.resource.emails)?.[0])?.value),
    displayName: maybeString(input.resource.displayName) ?? maybeString(asRecord(input.resource.name)?.formatted),
    nameJson: asRecord(input.resource.name),
    emailsJson: asArray(input.resource.emails),
    attributesJson: existing?.attributesJson ?? null,
    active: input.resource.active === false ? false : true,
    lastScimSyncAt: now,
    lastSsoLoginAt: existing?.lastSsoLoginAt ?? null,
  }

  if (existing) {
    await db
      .update(ExternalIdentityTable)
      .set(payload)
      .where(eq(ExternalIdentityTable.id, existing.id))
    return true
  }

  await db.insert(ExternalIdentityTable).values({
    id: createDenTypeId("externalIdentity"),
    ...payload,
  })
  return true
}

export async function syncExternalIdentityFromScimResource(input: {
  bearerToken: string
  resource: ScimUserResource
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return false
  }

  return syncExternalIdentityForProvider({ provider, resource: input.resource })
}

async function syncExternalIdentityFromScimUserIdForProvider(input: {
  provider: ScimProvider
  userId: UserId
}) {
  const userRows = await db
    .select()
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, input.userId))
    .limit(1)
  const user = userRows[0] ?? null
  if (!user) {
    return false
  }

  const accountRows = await db
    .select()
    .from(AuthAccountTable)
    .where(and(eq(AuthAccountTable.userId, input.userId), eq(AuthAccountTable.providerId, input.provider.providerId)))
    .limit(1)
  const account = accountRows[0] ?? null

  return syncExternalIdentityForProvider({
    provider: input.provider,
    resource: {
      id: user.id,
      externalId: account?.accountId ?? null,
      userName: user.email,
      displayName: user.name,
      name: { formatted: user.name },
      emails: [{ value: user.email, primary: true }],
      active: true,
    },
  })
}

export async function syncExternalIdentityFromScimUserId(input: {
  bearerToken: string
  userId: UserId
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return false
  }

  return syncExternalIdentityFromScimUserIdForProvider({ provider, userId: input.userId })
}

async function deactivateExternalIdentityForScimUserForProvider(input: {
  provider: ScimProvider
  userId: UserId
}) {
  const rows = await db
    .select()
    .from(ExternalIdentityTable)
    .where(and(eq(ExternalIdentityTable.organizationId, input.provider.organizationId), eq(ExternalIdentityTable.userId, input.userId)))
    .limit(1)
  const existing = rows[0] ?? null
  if (!existing) {
    return false
  }

  await db
    .update(ExternalIdentityTable)
    .set({
      active: false,
      source: existing.ssoProviderId ? "scim+sso" : "scim",
      scimProviderId: input.provider.providerId,
      lastScimSyncAt: new Date(),
    })
    .where(eq(ExternalIdentityTable.id, existing.id))
  return true
}

export async function deactivateExternalIdentityForScimUser(input: {
  bearerToken: string
  userId: UserId
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return false
  }

  return deactivateExternalIdentityForScimUserForProvider({ provider, userId: input.userId })
}

export function getScimBaseUrl() {
  return `${env.betterAuthUrl}/api/auth/scim/v2`
}

export async function getOrganizationScimConnection(organizationId: OrganizationId) {
  const rows = await db
    .select()
    .from(ScimProviderTable)
    .where(eq(ScimProviderTable.organizationId, organizationId))
    .limit(1)

  return rows[0] ?? null
}

export async function rotateOrganizationScimToken(input: {
  organizationId: OrganizationId
  headers: Headers
}) {
  const existing = await getOrganizationScimConnection(input.organizationId)
  const providerId = buildOrganizationScimProviderId(input.organizationId)

  if (existing && existing.providerId !== providerId) {
    await db.delete(ScimProviderTable).where(eq(ScimProviderTable.id, existing.id))
  }

  const generated = await auth.api.generateSCIMToken({
    body: {
      providerId,
      organizationId: input.organizationId,
    },
    headers: input.headers,
  })

  const connection = await getOrganizationScimConnection(input.organizationId)
  if (!connection) {
    throw new Error("SCIM connection was created, but could not be loaded.")
  }

  return {
    connection,
    scimToken: generated.scimToken,
  }
}

export async function deleteOrganizationScimConnection(organizationId: OrganizationId) {
  const connection = await getOrganizationScimConnection(organizationId)
  if (!connection) {
    return false
  }

  await cleanupExternalIdentitiesForDeletedScimConnection(connection)
  await db.delete(ScimProviderTable).where(eq(ScimProviderTable.id, connection.id))
  return true
}

async function cleanupExternalIdentitiesForDeletedScimConnection(connection: typeof ScimProviderTable.$inferSelect) {
  await db
    .update(ExternalIdentityTable)
    .set({
      source: "sso",
      scimProviderId: null,
      externalId: null,
      nameJson: null,
      emailsJson: null,
      lastScimSyncAt: null,
    })
    .where(and(
      eq(ExternalIdentityTable.organizationId, connection.organizationId),
      eq(ExternalIdentityTable.scimProviderId, connection.providerId),
      isNotNull(ExternalIdentityTable.ssoProviderId),
    ))

  await db
    .update(ExternalIdentityTable)
    .set({
      active: false,
      scimProviderId: null,
      externalId: null,
      nameJson: null,
      emailsJson: null,
      lastScimSyncAt: null,
    })
    .where(and(
      eq(ExternalIdentityTable.organizationId, connection.organizationId),
      eq(ExternalIdentityTable.scimProviderId, connection.providerId),
      isNull(ExternalIdentityTable.ssoProviderId),
    ))

  await db
    .delete(AuthAccountTable)
    .where(eq(AuthAccountTable.providerId, connection.providerId))
}

export async function deleteScimProvisionedAccessForProvider(input: {
  provider: ScimProvider
  userId: UserId
}) {
  const accountRows = await db
    .select()
    .from(AuthAccountTable)
    .where(and(eq(AuthAccountTable.userId, input.userId), eq(AuthAccountTable.providerId, input.provider.providerId)))
    .limit(1)

  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.userId, input.userId), eq(MemberTable.organizationId, input.provider.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)

  const account = accountRows[0] ?? null
  const member = memberRows[0] ?? null

  if (member) {
    const removed = await removeOrganizationMember({
      organizationId: input.provider.organizationId,
      memberId: member.id,
    })
    if (!removed.ok) {
      return { ok: false as const, status: 409, body: { detail: removed.message } }
    }
  }

  await db.transaction(async (tx) => {
    if (account) {
      await tx.delete(AuthAccountTable).where(eq(AuthAccountTable.id, account.id))
    } else {
      await tx
        .delete(AuthAccountTable)
        .where(and(eq(AuthAccountTable.userId, input.userId), eq(AuthAccountTable.providerId, input.provider.providerId)))
    }
    await tx
      .update(ExternalIdentityTable)
      .set({
        active: false,
        source: sql<string>`case when ${ExternalIdentityTable.ssoProviderId} is null then 'scim' else 'scim+sso' end`,
        scimProviderId: input.provider.providerId,
        lastScimSyncAt: new Date(),
      })
      .where(and(eq(ExternalIdentityTable.organizationId, input.provider.organizationId), eq(ExternalIdentityTable.userId, input.userId)))
  })

  return { ok: true as const }
}

export async function deleteScimProvisionedAccess(input: {
  bearerToken: string
  userId: UserId
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return { ok: false as const, status: 401, body: { detail: "Invalid SCIM token" } }
  }

  return deleteScimProvisionedAccessForProvider({ provider, userId: input.userId })
}

export async function recordScimSyncFailure(input: {
  provider: ScimProvider
  action: ScimSyncAction
  userId?: UserId | null
  payloadJson?: Record<string, unknown> | null
  error: unknown
  retryable?: boolean
}) {
  const retryable = input.retryable ?? true
  const attempts = retryable ? 0 : SCIM_SYNC_MAX_ATTEMPTS
  const event = {
    id: createDenTypeId("scimSyncEvent"),
    organizationId: input.provider.organizationId,
    providerId: input.provider.providerId,
    userId: input.userId ?? null,
    action: input.action,
    status: retryable ? "pending" : "failed",
    attempts,
    lastError: stringifyScimError(input.error),
    payloadJson: input.payloadJson ?? null,
    nextRetryAt: retryable ? nextScimRetryAt(attempts) : null,
    resolvedAt: null,
  }

  await db.insert(ScimSyncEventTable).values(event)
  console.error(
    `[scim][sync_failure_recorded] organization=${event.organizationId} provider=${event.providerId} action=${event.action} event=${event.id} retryable=${retryable} reason=${event.lastError}`,
  )
  return event.id
}

export async function recordScimSyncFailureFromBearerToken(input: {
  bearerToken: string
  action: ScimSyncAction
  userId?: UserId | null
  payloadJson?: Record<string, unknown> | null
  error: unknown
  retryable?: boolean
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return null
  }

  return recordScimSyncFailure({
    provider,
    action: input.action,
    userId: input.userId,
    payloadJson: input.payloadJson,
    error: input.error,
    retryable: input.retryable,
  })
}

export async function getOrganizationScimHealth(organizationId: OrganizationId) {
  const unresolvedRows = await db
    .select({ value: count() })
    .from(ScimSyncEventTable)
    .where(and(eq(ScimSyncEventTable.organizationId, organizationId), isNull(ScimSyncEventTable.resolvedAt)))

  const lastFailureRows = await db
    .select()
    .from(ScimSyncEventTable)
    .where(and(eq(ScimSyncEventTable.organizationId, organizationId), isNull(ScimSyncEventTable.resolvedAt)))
    .orderBy(desc(ScimSyncEventTable.createdAt))
    .limit(1)

  const lastSuccessRows = await db
    .select({ lastScimSyncAt: ExternalIdentityTable.lastScimSyncAt })
    .from(ExternalIdentityTable)
    .where(and(eq(ExternalIdentityTable.organizationId, organizationId), isNotNull(ExternalIdentityTable.lastScimSyncAt)))
    .orderBy(desc(ExternalIdentityTable.lastScimSyncAt))
    .limit(1)

  const lastFailure = lastFailureRows[0] ?? null
  return {
    unresolvedFailureCount: Number(unresolvedRows[0]?.value ?? 0),
    lastFailureAt: lastFailure?.createdAt ?? null,
    lastFailureAction: lastFailure?.action ?? null,
    lastFailureMessage: lastFailure?.lastError ?? null,
    nextRetryAt: lastFailure?.nextRetryAt ?? null,
    lastSuccessfulSyncAt: lastSuccessRows[0]?.lastScimSyncAt ?? null,
  }
}

async function getProviderForScimSyncEvent(event: ScimSyncEvent) {
  const rows = await db
    .select()
    .from(ScimProviderTable)
    .where(and(eq(ScimProviderTable.organizationId, event.organizationId), eq(ScimProviderTable.providerId, event.providerId)))
    .limit(1)

  return rows[0] ?? null
}

async function retryScimSyncEvent(event: ScimSyncEvent) {
  const provider = await getProviderForScimSyncEvent(event)
  if (!provider) {
    return { ok: false as const, error: "SCIM provider no longer exists." }
  }

  if (event.action === "sync_resource") {
    const synced = event.payloadJson
      ? await syncExternalIdentityForProvider({ provider, resource: event.payloadJson })
      : false
    return synced
      ? { ok: true as const }
      : { ok: false as const, error: "SCIM resource payload could not be synced." }
  }

  if (event.action === "sync_user_id") {
    if (!event.userId) {
      return { ok: false as const, error: "SCIM sync event is missing a user id." }
    }

    const synced = await syncExternalIdentityFromScimUserIdForProvider({ provider, userId: event.userId })
    return synced
      ? { ok: true as const }
      : { ok: false as const, error: "SCIM user id could not be synced." }
  }

  if (event.action === "delete_user") {
    if (!event.userId) {
      return { ok: false as const, error: "SCIM deprovision event is missing a user id." }
    }

    const deleted = await deleteScimProvisionedAccessForProvider({ provider, userId: event.userId })
    return deleted.ok
      ? { ok: true as const }
      : { ok: false as const, error: deleted.body.detail }
  }

  return { ok: false as const, error: "SCIM drift event requires manual review." }
}

async function markScimSyncEventResolved(event: ScimSyncEvent) {
  await db
    .update(ScimSyncEventTable)
    .set({
      status: "resolved",
      attempts: event.attempts + 1,
      lastError: null,
      nextRetryAt: null,
      resolvedAt: new Date(),
    })
    .where(eq(ScimSyncEventTable.id, event.id))
}

async function markScimSyncEventFailed(event: ScimSyncEvent, error: unknown) {
  const attempts = event.attempts + 1
  const retryable = attempts < SCIM_SYNC_MAX_ATTEMPTS
  await db
    .update(ScimSyncEventTable)
    .set({
      status: retryable ? "retrying" : "failed",
      attempts,
      lastError: stringifyScimError(error),
      nextRetryAt: retryable ? nextScimRetryAt(attempts) : null,
    })
    .where(eq(ScimSyncEventTable.id, event.id))
}

export async function retryPendingScimSyncEvents(input: {
  limit?: number
  now?: Date
} = {}) {
  const now = input.now ?? new Date()
  const rows = await db
    .select()
    .from(ScimSyncEventTable)
    .where(and(
      isNull(ScimSyncEventTable.resolvedAt),
      lt(ScimSyncEventTable.attempts, SCIM_SYNC_MAX_ATTEMPTS),
      or(isNull(ScimSyncEventTable.nextRetryAt), lte(ScimSyncEventTable.nextRetryAt, now)),
    ))
    .orderBy(ScimSyncEventTable.createdAt)
    .limit(input.limit ?? 25)

  let resolved = 0
  let failed = 0
  for (const event of rows) {
    try {
      const result = await retryScimSyncEvent(event)
      if (result.ok) {
        await markScimSyncEventResolved(event)
        resolved += 1
      } else {
        await markScimSyncEventFailed(event, result.error)
        failed += 1
      }
    } catch (error) {
      await markScimSyncEventFailed(event, error)
      failed += 1
    }
  }

  return {
    checked: rows.length,
    resolved,
    failed,
  }
}

export async function reconcileOrganizationScimDrift(organizationId: OrganizationId) {
  const connection = await getOrganizationScimConnection(organizationId)
  if (!connection) {
    return { checked: 0, repaired: 0, failures: 0 }
  }

  const identities = await db
    .select()
    .from(ExternalIdentityTable)
    .where(and(
      eq(ExternalIdentityTable.organizationId, organizationId),
      eq(ExternalIdentityTable.scimProviderId, connection.providerId),
      eq(ExternalIdentityTable.active, true),
    ))

  let repaired = 0
  let failures = 0
  for (const identity of identities) {
    const [memberRows, accountRows] = await Promise.all([
      db
        .select({ id: MemberTable.id })
        .from(MemberTable)
        .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, identity.userId), isNull(MemberTable.removedAt)))
        .limit(1),
      db
        .select({ id: AuthAccountTable.id })
        .from(AuthAccountTable)
        .where(and(eq(AuthAccountTable.userId, identity.userId), eq(AuthAccountTable.providerId, connection.providerId)))
        .limit(1),
    ])

    if (!memberRows[0]) {
      await deactivateExternalIdentityForScimUserForProvider({ provider: connection, userId: identity.userId })
      repaired += 1
      continue
    }

    if (!accountRows[0]) {
      failures += 1
      const existingFailureRows = await db
        .select({ id: ScimSyncEventTable.id })
        .from(ScimSyncEventTable)
        .where(and(
          eq(ScimSyncEventTable.organizationId, organizationId),
          eq(ScimSyncEventTable.providerId, connection.providerId),
          eq(ScimSyncEventTable.userId, identity.userId),
          eq(ScimSyncEventTable.action, "reconcile_drift"),
          isNull(ScimSyncEventTable.resolvedAt),
        ))
        .limit(1)
      if (!existingFailureRows[0]) {
        await recordScimSyncFailure({
          provider: connection,
          action: "reconcile_drift",
          userId: identity.userId,
          payloadJson: {
            issue: "active_scim_identity_missing_provider_account",
            externalIdentityId: identity.id,
          },
          error: "Active SCIM identity has org access but no SCIM provider account.",
          retryable: false,
        })
      }
    }
  }

  return {
    checked: identities.length,
    repaired,
    failures,
  }
}

export async function listScimProviders() {
  return db.select().from(ScimProviderTable)
}
