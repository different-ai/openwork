import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthUserTable, ExternalIdentityTable, MemberTable, ScimProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { auth } from "./auth.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { removeOrganizationMember } from "./orgs.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id

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

function safeEqualSecret(left: string, right: string) {
  const leftBytes = Uint8Array.from(Buffer.from(left))
  const rightBytes = Uint8Array.from(Buffer.from(right))
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function resolveScimProviderFromBearerToken(bearerToken: string) {
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
  if (!provider || !safeEqualSecret(provider.scimToken, rawToken)) {
    return null
  }

  return provider
}

export async function syncExternalIdentityFromScimResource(input: {
  bearerToken: string
  resource: ScimUserResource
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return false
  }

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
    .where(and(eq(ExternalIdentityTable.organizationId, provider.organizationId), eq(ExternalIdentityTable.userId, userId)))
    .limit(1)

  const existing = existingRows[0] ?? null
  const now = new Date()
  const payload = {
    organizationId: provider.organizationId,
    userId,
    source: existing?.ssoProviderId ? "scim+sso" : "scim",
    scimProviderId: provider.providerId,
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

export async function syncExternalIdentityFromScimUserId(input: {
  bearerToken: string
  userId: UserId
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return false
  }

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
    .where(and(eq(AuthAccountTable.userId, input.userId), eq(AuthAccountTable.providerId, provider.providerId)))
    .limit(1)
  const account = accountRows[0] ?? null

  return syncExternalIdentityFromScimResource({
    bearerToken: input.bearerToken,
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

export async function deactivateExternalIdentityForScimUser(input: {
  bearerToken: string
  userId: UserId
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return false
  }

  const rows = await db
    .select()
    .from(ExternalIdentityTable)
    .where(and(eq(ExternalIdentityTable.organizationId, provider.organizationId), eq(ExternalIdentityTable.userId, input.userId)))
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
      scimProviderId: provider.providerId,
      lastScimSyncAt: new Date(),
    })
    .where(eq(ExternalIdentityTable.id, existing.id))
  return true
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

export async function deleteScimProvisionedAccess(input: {
  bearerToken: string
  userId: UserId
}) {
  const provider = await resolveScimProviderFromBearerToken(input.bearerToken)
  if (!provider) {
    return { ok: false as const, status: 401, body: { detail: "Invalid SCIM token" } }
  }

  const accountRows = await db
    .select()
    .from(AuthAccountTable)
    .where(and(eq(AuthAccountTable.userId, input.userId), eq(AuthAccountTable.providerId, provider.providerId)))
    .limit(1)

  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.userId, input.userId), eq(MemberTable.organizationId, provider.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)

  const account = accountRows[0] ?? null
  const member = memberRows[0] ?? null
  if (!account || !member) {
    return { ok: false as const, status: 404, body: { detail: "User not found" } }
  }

  await removeOrganizationMember({
    organizationId: provider.organizationId,
    memberId: member.id,
  })

  await db.delete(AuthAccountTable).where(eq(AuthAccountTable.id, account.id))
  await deactivateExternalIdentityForScimUser({ bearerToken: input.bearerToken, userId: input.userId })

  return { ok: true as const }
}
