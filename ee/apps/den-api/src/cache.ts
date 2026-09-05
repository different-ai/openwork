import { asc, and, eq, gt, isNull, lt, lte } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable, InvitationTable, MemberTable, OAuthConsentTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"
import { createHash } from "node:crypto"
import Redis from "ioredis"
import { db } from "./db.js"
import { env } from "./env.js"
import { roleIncludesOwner } from "./organization-member-guards.js"
import { getDenSessionExpiresAt, getDenSessionRefreshCutoff } from "./session-lifetime.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type UserId = typeof AuthUserTable.$inferSelect.id
type OAuthConsentId = typeof OAuthConsentTable.$inferSelect.id

type CacheParent = "auth" | "org"
type CacheChild = "grant" | "grant-revoked" | "member" | "members" | "session" | "session-id" | "session-revoked" | "session-id-revoked"

type CacheKeyInput = {
  parent: CacheParent
  child: CacheChild
  id: string
}

type CacheRedisClient = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  eval?(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
  scan?(cursor: string, mode: "MATCH", pattern: string, countMode: "COUNT", count: number): Promise<[string, string[]]>
}

type CacheResult<T> = {
  value: T
  source: "cache" | "loader"
}

export type CachedAuthSession = {
  session: {
    id: DenTypeId<"session">
    token: string
    userId: DenTypeId<"user">
    activeOrganizationId: DenTypeId<"organization"> | null
    activeTeamId: DenTypeId<"team"> | null
    expiresAt: Date
    createdAt: Date
    updatedAt: Date
    ipAddress: string | null
    userAgent: string | null
  }
  user: {
    id: DenTypeId<"user">
    name: string
    email: string
    emailVerified: boolean
    image: string | null
    createdAt: Date
    updatedAt: Date
  }
}

export type CachedOrgMembership = {
  id: MemberId
  role: string
  isOwner: boolean
}

export type CachedOrgMember = {
  id: MemberId
  userId: UserId | null
  inviteId: typeof InvitationTable.$inferSelect.id | null
  role: string
  createdAt: Date
  joinedAt: Date | null
  isOwner: boolean
  user: {
    id: UserId | MemberId
    email: string
    name: string
    image: string | null
  }
}

const DEFAULT_CACHE_TTL_SECONDS = 60
const ORG_CACHE_TTL_SECONDS = 5 * 60
const AUTH_SESSION_MAX_TTL_SECONDS = 60 * 60
const redisClient = env.databaseRedisUrl
  ? new Redis(env.databaseRedisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    })
  : null

redisClient?.on("error", (error) => {
  console.error("openwork_cache_redis_error", error)
})

let activeRedisClient: CacheRedisClient | null = redisClient
let activeOrgMembersLoader = loadOrgMembers
let activeOrgMembershipLoader = loadOrgMembership
let activeAuthSessionLoader = loadAuthSession
let activeAuthSessionIdLoader = loadActiveSessionId
let activeAuthGrantLoader = loadActiveGrant

function cacheKey(input: CacheKeyInput) {
  return `cache:${input.parent}:${input.child}:${input.id}`
}

function hashCacheId(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 12)
}

function cacheLogDetails(input: CacheKeyInput) {
  return input.parent === "auth" && (input.child === "session" || input.child === "session-revoked")
    ? { cacheParent: input.parent, cacheChild: input.child, idHash: hashCacheId(input.id) }
    : { cacheParent: input.parent, cacheChild: input.child, id: input.id }
}

async function setUnlessRevoked(input: {
  redis: CacheRedisClient
  key: string
  revokedKey: string
  value: string
  ttlSeconds: number
}) {
  if (input.redis.eval) {
    const result = await input.redis.eval(
      "if redis.call('exists', KEYS[2]) == 1 then return 0 else redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 end",
      2,
      input.key,
      input.revokedKey,
      input.value,
      input.ttlSeconds,
    )
    return result === 1
  }

  if (await input.redis.get(input.revokedKey)) {
    return false
  }
  await input.redis.set(input.key, input.value, "EX", input.ttlSeconds)
  if (await input.redis.get(input.revokedKey)) {
    await input.redis.del(input.key)
    return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null
}

function readNullableString(value: unknown) {
  return value === null || value === undefined ? null : readString(value)
}

function readDate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return null
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function readDenId<TName extends DenTypeIdName>(name: TName, value: unknown) {
  const id = readString(value)
  if (!id) {
    return null
  }
  try {
    return normalizeDenTypeId(name, id)
  } catch {
    return null
  }
}

function readNullableDenId<TName extends DenTypeIdName>(name: TName, value: unknown) {
  return value === null || value === undefined ? null : readDenId(name, value)
}

function getInvitedMemberName(email: string) {
  return email.slice(0, email.indexOf("@")) || "Invited member"
}

function parseCachedOrgMember(value: unknown): CachedOrgMember | null {
  if (!isRecord(value) || !isRecord(value.user)) {
    return null
  }

  const id = readDenId("member", value.id)
  const userId = readNullableDenId("user", value.userId)
  const inviteId = readNullableDenId("invitation", value.inviteId)
  const role = readString(value.role)
  const createdAt = readDate(value.createdAt)
  const joinedAt = value.joinedAt === null || value.joinedAt === undefined ? null : readDate(value.joinedAt)
  const userIdValue = readDenId("user", value.user.id) ?? readDenId("member", value.user.id)
  const email = readString(value.user.email)
  const name = readString(value.user.name)
  if (!id || !role || !createdAt || joinedAt === undefined || !userIdValue || !email || !name) {
    return null
  }

  return {
    id,
    userId,
    inviteId,
    role,
    createdAt,
    joinedAt,
    isOwner: typeof value.isOwner === "boolean" ? value.isOwner : roleIncludesOwner(role),
    user: {
      id: userIdValue,
      email,
      name,
      image: readNullableString(value.user.image),
    },
  }
}

function parseCachedOrgMembers(raw: string | null) {
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) {
    return null
  }

  const members = parsed.map(parseCachedOrgMember)
  return members.every((member) => member !== null) ? members : null
}

function parseCachedOrgMembership(raw: string | null): CachedOrgMembership | null {
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }

  const id = readDenId("member", parsed.id)
  const role = readString(parsed.role)
  const isOwner = typeof parsed.isOwner === "boolean" ? parsed.isOwner : null
  return id && role && isOwner !== null ? { id, role, isOwner } : null
}

function parseCachedActiveSessionId(raw: string | null) {
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }

  const id = readDenId("session", parsed.id)
  const expiresAt = readDate(parsed.expiresAt)
  return id && expiresAt && expiresAt > new Date() ? { id, expiresAt } : null
}

function parseCachedActiveGrant(raw: string | null) {
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }

  const id = readDenId("oauthConsent", parsed.id)
  return id ? { id } : null
}

function parseCachedAuthSession(raw: string | null, now: Date): CachedAuthSession | null {
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.session) || !isRecord(parsed.user)) {
    return null
  }

  const session = parsed.session
  const user = parsed.user
  const id = readDenId("session", session.id)
  const token = readString(session.token)
  const userId = readDenId("user", session.userId)
  const expiresAt = readDate(session.expiresAt)
  const createdAt = readDate(session.createdAt)
  const updatedAt = readDate(session.updatedAt)
  const normalizedUserId = readDenId("user", user.id)
  const name = readString(user.name)
  const email = readString(user.email)
  const emailVerified = typeof user.emailVerified === "boolean" ? user.emailVerified : null
  const userCreatedAt = readDate(user.createdAt)
  const userUpdatedAt = readDate(user.updatedAt)
  if (!id || !token || !userId || !expiresAt || expiresAt <= now || !createdAt || !updatedAt
    || !normalizedUserId || !name || !email || emailVerified === null || !userCreatedAt || !userUpdatedAt) {
    return null
  }

  return {
    session: {
      id,
      token,
      userId,
      activeOrganizationId: readNullableDenId("organization", session.activeOrganizationId),
      activeTeamId: readNullableDenId("team", session.activeTeamId),
      expiresAt,
      createdAt,
      updatedAt,
      ipAddress: readNullableString(session.ipAddress),
      userAgent: readNullableString(session.userAgent),
    },
    user: {
      id: normalizedUserId,
      name,
      email,
      emailVerified,
      image: readNullableString(user.image),
      createdAt: userCreatedAt,
      updatedAt: userUpdatedAt,
    },
  }
}

async function getOrSet<T>(input: {
  parent: CacheParent
  child: CacheChild
  id: string
  ttlSeconds?: number
  parse: (raw: string | null) => T | null
  load: () => Promise<T>
}) {
  const redis = activeRedisClient
  if (!redis) {
    return input.load()
  }

  const key = cacheKey(input)
  try {
    const cached = input.parse(await redis.get(key))
    if (cached) {
      return cached
    }
  } catch (error) {
    console.error("openwork_cache_get_failed", { key, error })
  }

  const loaded = await input.load()
  try {
    await redis.set(key, JSON.stringify(loaded), "EX", input.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS)
  } catch (error) {
    console.error("openwork_cache_set_failed", { key, error })
  }
  return loaded
}

async function loadOrgMembers(organizationId: OrgId): Promise<CachedOrgMember[]> {
  const members = await db
    .select({
      id: MemberTable.id,
      userId: MemberTable.userId,
      inviteId: MemberTable.inviteId,
      role: MemberTable.role,
      createdAt: MemberTable.createdAt,
      joinedAt: MemberTable.joinedAt,
      user: {
        id: AuthUserTable.id,
        email: AuthUserTable.email,
        name: AuthUserTable.name,
        image: AuthUserTable.image,
      },
      invitation: {
        email: InvitationTable.email,
      },
    })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
    .orderBy(asc(MemberTable.createdAt))

  return members.map((member) => {
    const email = member.user?.email ?? member.invitation?.email ?? "invited@example.com"
    const name = member.user?.name ?? getInvitedMemberName(email)
    return {
      id: member.id,
      userId: member.userId,
      inviteId: member.inviteId,
      role: member.role,
      createdAt: member.createdAt,
      joinedAt: member.joinedAt,
      isOwner: roleIncludesOwner(member.role),
      user: {
        id: member.user?.id ?? member.id,
        email,
        name,
        image: member.user?.image ?? null,
      },
    }
  })
}

async function loadAuthSession(token: string, now: Date): Promise<CachedAuthSession | null> {
  const rows = await db
    .select({
      session: {
        id: AuthSessionTable.id,
        token: AuthSessionTable.token,
        userId: AuthSessionTable.userId,
        activeOrganizationId: AuthSessionTable.activeOrganizationId,
        activeTeamId: AuthSessionTable.activeTeamId,
        expiresAt: AuthSessionTable.expiresAt,
        createdAt: AuthSessionTable.createdAt,
        updatedAt: AuthSessionTable.updatedAt,
        ipAddress: AuthSessionTable.ipAddress,
        userAgent: AuthSessionTable.userAgent,
      },
      user: {
        id: AuthUserTable.id,
        name: AuthUserTable.name,
        email: AuthUserTable.email,
        emailVerified: AuthUserTable.emailVerified,
        image: AuthUserTable.image,
        createdAt: AuthUserTable.createdAt,
        updatedAt: AuthUserTable.updatedAt,
      },
    })
    .from(AuthSessionTable)
    .innerJoin(AuthUserTable, eq(AuthSessionTable.userId, AuthUserTable.id))
    .where(and(eq(AuthSessionTable.token, token), gt(AuthSessionTable.expiresAt, now)))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    session: {
      ...row.session,
      id: normalizeDenTypeId("session", row.session.id),
      userId: normalizeDenTypeId("user", row.session.userId),
      activeOrganizationId: row.session.activeOrganizationId
        ? normalizeDenTypeId("organization", row.session.activeOrganizationId)
        : null,
      activeTeamId: row.session.activeTeamId ? normalizeDenTypeId("team", row.session.activeTeamId) : null,
    },
    user: {
      ...row.user,
      id: normalizeDenTypeId("user", row.user.id),
    },
  }
}

async function loadActiveSessionId(sessionId: DenTypeId<"session">, now: Date) {
  const nextExpiresAt = getDenSessionExpiresAt(now)
  await db
    .update(AuthSessionTable)
    .set({
      expiresAt: nextExpiresAt,
      updatedAt: now,
    })
    .where(and(
      eq(AuthSessionTable.id, sessionId),
      gt(AuthSessionTable.expiresAt, now),
      lte(AuthSessionTable.expiresAt, getDenSessionRefreshCutoff(now)),
      lt(AuthSessionTable.expiresAt, nextExpiresAt),
    ))

  const rows = await db
    .select({
      id: AuthSessionTable.id,
      expiresAt: AuthSessionTable.expiresAt,
    })
    .from(AuthSessionTable)
    .where(and(eq(AuthSessionTable.id, sessionId), gt(AuthSessionTable.expiresAt, now)))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    id: normalizeDenTypeId("session", row.id),
    expiresAt: row.expiresAt,
  }
}

async function loadActiveGrant(grantId: OAuthConsentId) {
  const rows = await db
    .select({ id: OAuthConsentTable.id })
    .from(OAuthConsentTable)
    .where(eq(OAuthConsentTable.id, grantId))
    .limit(1)

  const row = rows[0]
  return row ? { id: normalizeDenTypeId("oauthConsent", row.id) } : null
}

async function loadOrgMembership(input: { organizationId: OrgId; userId: UserId }): Promise<CachedOrgMembership | null> {
  const rows = await db
    .select({ id: MemberTable.id, role: MemberTable.role })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.userId, input.userId),
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const member = rows[0]
  return member ? { id: member.id, role: member.role, isOwner: roleIncludesOwner(member.role) } : null
}

async function getAuthSessionResult(token: string): Promise<CacheResult<CachedAuthSession | null>> {
  const now = new Date()
  const keyInput = { parent: "auth", child: "session", id: token } as const
  const revokedKeyInput = { parent: "auth", child: "session-revoked", id: token } as const
  const key = cacheKey(keyInput)
  const revokedKey = cacheKey(revokedKeyInput)
  const redis = activeRedisClient
  if (redis) {
    try {
      if (await redis.get(revokedKey)) {
        return { value: null, source: "cache" }
      }
      const cached = parseCachedAuthSession(await redis.get(key), now)
      if (cached) {
        return { value: cached, source: "cache" }
      }
    } catch (error) {
      console.error("openwork_cache_get_failed", { ...cacheLogDetails(keyInput), error })
    }
  }

  const loaded = await activeAuthSessionLoader(token, now)
  if (!loaded || !redis) {
    return { value: loaded, source: "loader" }
  }

  const ttl = Math.min(AUTH_SESSION_MAX_TTL_SECONDS, Math.ceil((loaded.session.expiresAt.getTime() - now.getTime()) / 1000))
  if (ttl > 0) {
    try {
      await setUnlessRevoked({ redis, key, revokedKey, value: JSON.stringify(loaded), ttlSeconds: ttl })
    } catch (error) {
      console.error("openwork_cache_set_failed", { ...cacheLogDetails(keyInput), error })
    }
  }
  return { value: loaded, source: "loader" }
}

async function getAuthSession(token: string) {
  return (await getAuthSessionResult(token)).value
}

async function getActiveSessionId(sessionId: DenTypeId<"session">) {
  const now = new Date()
  const keyInput = { parent: "auth", child: "session-id", id: sessionId } as const
  const revokedKeyInput = { parent: "auth", child: "session-id-revoked", id: sessionId } as const
  const key = cacheKey(keyInput)
  const revokedKey = cacheKey(revokedKeyInput)
  const redis = activeRedisClient
  if (redis) {
    try {
      if (await redis.get(revokedKey)) {
        return null
      }
      const cached = parseCachedActiveSessionId(await redis.get(key))
      if (cached) {
        return cached
      }
    } catch (error) {
      console.error("openwork_cache_get_failed", { ...cacheLogDetails(keyInput), error })
    }
  }

  const loaded = await activeAuthSessionIdLoader(sessionId, now)
  if (!loaded || !redis) {
    return loaded
  }

  const ttl = Math.min(DEFAULT_CACHE_TTL_SECONDS, Math.ceil((loaded.expiresAt.getTime() - now.getTime()) / 1000))
  if (ttl > 0) {
    try {
      await setUnlessRevoked({ redis, key, revokedKey, value: JSON.stringify(loaded), ttlSeconds: ttl })
    } catch (error) {
      console.error("openwork_cache_set_failed", { ...cacheLogDetails(keyInput), error })
    }
  }
  return loaded
}

async function getActiveGrant(grantId: OAuthConsentId) {
  const keyInput: CacheKeyInput = { parent: "auth", child: "grant", id: grantId }
  const revokedKeyInput: CacheKeyInput = { parent: "auth", child: "grant-revoked", id: grantId }
  const key = cacheKey(keyInput)
  const revokedKey = cacheKey(revokedKeyInput)
  const redis = activeRedisClient
  if (redis) {
    try {
      if (await redis.get(revokedKey)) {
        return null
      }
      const cached = parseCachedActiveGrant(await redis.get(key))
      if (cached) {
        return cached
      }
    } catch (error) {
      console.error("openwork_cache_get_failed", { ...cacheLogDetails(keyInput), error })
    }
  }

  const loaded = await activeAuthGrantLoader(grantId)
  if (!loaded || !redis) {
    return loaded
  }

  try {
    await setUnlessRevoked({ redis, key, revokedKey, value: JSON.stringify(loaded), ttlSeconds: DEFAULT_CACHE_TTL_SECONDS })
  } catch (error) {
    console.error("openwork_cache_set_failed", { ...cacheLogDetails(keyInput), error })
  }
  return loaded
}

async function deleteAuthSession(token: string) {
  const keyInput = { parent: "auth", child: "session", id: token } as const
  const key = cacheKey(keyInput)
  try {
    const cached = parseCachedAuthSession(await activeRedisClient?.get(key) ?? null, new Date())
    await activeRedisClient?.del(key)
    if (cached) {
      await deleteAuthSessionId(cached.session.id)
    }
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(keyInput), error })
  }
}

async function revokeAuthSession(token: string) {
  const revokedKeyInput = { parent: "auth", child: "session-revoked", id: token } as const
  try {
    // Revocation tombstones stop a concurrent cache-miss loader from repopulating
    // a deleted session without adding a live DB check to cache hits.
    await activeRedisClient?.set(cacheKey(revokedKeyInput), "1", "EX", AUTH_SESSION_MAX_TTL_SECONDS)
    await deleteAuthSession(token)
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(revokedKeyInput), error })
  }
}

async function deleteAuthSessionId(sessionId: DenTypeId<"session">) {
  const keyInput = { parent: "auth", child: "session-id", id: sessionId } as const
  try {
    await activeRedisClient?.del(cacheKey(keyInput))
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(keyInput), error })
  }
}

async function revokeAuthSessionId(sessionId: DenTypeId<"session">) {
  const revokedKeyInput = { parent: "auth", child: "session-id-revoked", id: sessionId } as const
  try {
    await activeRedisClient?.set(cacheKey(revokedKeyInput), "1", "EX", AUTH_SESSION_MAX_TTL_SECONDS)
    await deleteAuthSessionId(sessionId)
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(revokedKeyInput), error })
  }
}

async function revokeAuthGrant(grantId: OAuthConsentId) {
  const keyInput: CacheKeyInput = { parent: "auth", child: "grant", id: grantId }
  const revokedKeyInput: CacheKeyInput = { parent: "auth", child: "grant-revoked", id: grantId }
  // The database row is already gone; these writes only bound cache staleness.
  // Attempt both independently so a failed tombstone write still clears the
  // positive entry — a lone tombstone or a lone delete each end acceptance,
  // and a total Redis outage converges at the positive entry's TTL.
  try {
    await activeRedisClient?.set(cacheKey(revokedKeyInput), "1", "EX", AUTH_SESSION_MAX_TTL_SECONDS)
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(revokedKeyInput), error })
  }
  try {
    await activeRedisClient?.del(cacheKey(keyInput))
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(keyInput), error })
  }
}

async function deleteByPrefix(prefix: string) {
  const redis = activeRedisClient
  if (!redis?.scan) {
    return
  }

  let cursor = "0"
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500)
    cursor = nextCursor
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } while (cursor !== "0")
}

async function deleteOrgMemberList(organizationId: OrgId) {
  const key = cacheKey({ parent: "org", child: "members", id: organizationId })
  try {
    await activeRedisClient?.del(key)
  } catch (error) {
    console.error("openwork_cache_delete_failed", { key, error })
  }
}

async function deleteOrgMembers(organizationId: OrgId) {
  const key = cacheKey({ parent: "org", child: "members", id: organizationId })
  try {
    await activeRedisClient?.del(key)
    await deleteByPrefix(cacheKey({ parent: "org", child: "member", id: `${organizationId}:` }))
  } catch (error) {
    console.error("openwork_cache_delete_failed", { key, error })
  }
}

async function deleteOrgMembership(input: { organizationId: OrgId; userId: UserId }) {
  const keyInput = { parent: "org", child: "member", id: `${input.organizationId}:${input.userId}` } as const
  try {
    await activeRedisClient?.del(cacheKey(keyInput))
  } catch (error) {
    console.error("openwork_cache_delete_failed", { ...cacheLogDetails(keyInput), error })
  }
}

async function getOrgMembership(input: { organizationId: OrgId; userId: UserId }) {
  return getOrSet({
    parent: "org",
    child: "member",
    id: `${input.organizationId}:${input.userId}`,
    ttlSeconds: ORG_CACHE_TTL_SECONDS,
    parse: parseCachedOrgMembership,
    load: () => activeOrgMembershipLoader(input),
  })
}

async function deleteAuthSessionsForUser(userId: UserId) {
  const sessions = await db
    .select({ id: AuthSessionTable.id, token: AuthSessionTable.token })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.userId, userId))
  await Promise.all(sessions.flatMap((session) => [deleteAuthSession(session.token), deleteAuthSessionId(normalizeDenTypeId("session", session.id))]))
}

/**
 * Shared Den API read-through cache.
 *
 * All entries use the Redis URL configured by DATABASE_REDIS_URL, but live
 * outside Better Auth's keyspace. Keys are intentionally predictable:
 * `cache:${cacheParent}:${cacheChild}:${id}`.
 *
 * Add expensive read helpers here instead of scattering ad-hoc Redis calls.
 * Every getter must be safe when Redis is absent: it should run its DB loader,
 * attempt to populate Redis when available, and return the loaded value either
 * way. Auth sessions are DB-authoritative and cached for at most one hour;
 * Cached hits must not perform live DB checks. Any operation that changes the
 * source rows instead calls the dedicated invalidators below: user sign-out and
 * session mutation clear auth session keys; consent deletion writes grant
 * tombstones; org deletion, member removal, member addition, role transfer, and
 * role edits clear org member/membership keys.
 */
export const cache = {
  auth: {
    session: getAuthSession,
    sessionResult: getAuthSessionResult,
    activeSessionId: getActiveSessionId,
    grant: getActiveGrant,
    deleteSession: deleteAuthSession,
    revokeSession: revokeAuthSession,
    deleteSessionId: deleteAuthSessionId,
    revokeSessionId: revokeAuthSessionId,
    revokeGrant: revokeAuthGrant,
    deleteSessionsForUser: deleteAuthSessionsForUser,
  },
  org: {
    membership: getOrgMembership,
    members(organizationId: OrgId) {
      return getOrSet({
        parent: "org",
        child: "members",
        id: organizationId,
        ttlSeconds: ORG_CACHE_TTL_SECONDS,
        parse: parseCachedOrgMembers,
        load: () => activeOrgMembersLoader(organizationId),
      })
    },
    deleteMemberList: deleteOrgMemberList,
    deleteMembers: deleteOrgMembers,
    deleteMembership: deleteOrgMembership,
  },
}

export function setCacheDependenciesForTest(input: {
  redis?: CacheRedisClient | null
  orgMembersLoader?: (organizationId: OrgId) => Promise<CachedOrgMember[]>
  authSessionLoader?: (token: string, now: Date) => Promise<CachedAuthSession | null>
  authSessionIdLoader?: (sessionId: DenTypeId<"session">, now: Date) => Promise<{ id: DenTypeId<"session">; expiresAt: Date } | null>
  authGrantLoader?: (grantId: OAuthConsentId) => Promise<{ id: OAuthConsentId } | null>
  orgMembershipLoader?: (input: { organizationId: OrgId; userId: UserId }) => Promise<CachedOrgMembership | null>
}) {
  const previousRedis = activeRedisClient
  const previousOrgMembersLoader = activeOrgMembersLoader
  const previousAuthSessionLoader = activeAuthSessionLoader
  const previousAuthSessionIdLoader = activeAuthSessionIdLoader
  const previousAuthGrantLoader = activeAuthGrantLoader
  const previousOrgMembershipLoader = activeOrgMembershipLoader
  if ("redis" in input) {
    activeRedisClient = input.redis ?? null
  }
  if (input.orgMembersLoader) {
    activeOrgMembersLoader = input.orgMembersLoader
  }
  if (input.authSessionLoader) {
    activeAuthSessionLoader = input.authSessionLoader
  }
  if (input.authSessionIdLoader) {
    activeAuthSessionIdLoader = input.authSessionIdLoader
  }
  if (input.authGrantLoader) {
    activeAuthGrantLoader = input.authGrantLoader
  }
  if (input.orgMembershipLoader) {
    activeOrgMembershipLoader = input.orgMembershipLoader
  }
  return () => {
    activeRedisClient = previousRedis
    activeOrgMembersLoader = previousOrgMembersLoader
    activeAuthSessionLoader = previousAuthSessionLoader
    activeAuthSessionIdLoader = previousAuthSessionIdLoader
    activeAuthGrantLoader = previousAuthGrantLoader
    activeOrgMembershipLoader = previousOrgMembershipLoader
  }
}
