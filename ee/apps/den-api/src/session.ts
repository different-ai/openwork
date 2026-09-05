import { and, eq, gt, lt, lte } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Context, MiddlewareHandler } from "hono"
import { getSignedCookie } from "hono/cookie"
import { DEN_API_KEY_HEADER, getApiKeySessionById, type DenApiKeySession } from "./api-keys.js"
import { auth } from "./auth.js"
import { cache, type CachedAuthSession } from "./cache.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { getDenSessionExpiresAt, getDenSessionRefreshCutoff } from "./session-lifetime.js"

type AuthSessionValue = {
  user: CachedAuthSession["user"]
  session: Omit<CachedAuthSession["session"], "id" | "token"> & {
    id: string
    token: string
  }
}
type AuthSessionLike = AuthSessionValue | null
type ApiKeyAuthResolution = {
  apiKey: DenApiKeySession
  user: AuthSessionValue["user"]
  activeOrganizationId: string
}
type SessionRequestContext = {
  method: string
  path: string
  requestId?: string
}

export type AuthContextVariables = {
  user: AuthSessionValue["user"] | null
  session: AuthSessionValue["session"] | null
  apiKey: DenApiKeySession | null
}

const INTERNAL_MCP_PRINCIPAL_HEADER = "x-den-internal-mcp-principal"
const INTERNAL_MCP_PRINCIPAL_TTL_MS = 60_000
export const INTERNAL_CAPABILITY_CONNECTOR_HEADER = "x-den-internal-capability-connector"
const BETTER_AUTH_SESSION_COOKIE_NAMES = [
  "openwork-den.session_token",
  "__Secure-openwork-den.session_token",
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth-session_token",
] as const

// Per-process secret used exclusively to sign the internal MCP principal header.
// It is generated fresh at startup, lives only in memory, and is never derived
// from betterAuthSecret. This binds the header to in-process callers: even an
// attacker who learns betterAuthSecret cannot forge a valid principal from an
// external request, closing the impersonation trust boundary.
const INTERNAL_MCP_PRINCIPAL_SECRET = new Uint8Array(randomBytes(32))

type InternalMcpPrincipal = {
  userId: string
  organizationId: string
  expiresAt: number
}

type InternalCapabilityConnector = InternalMcpPrincipal & {
  connectorId: string
}

function isInternalCapabilityConnector(value: unknown): value is InternalCapabilityConnector {
  return typeof value === "object"
    && value !== null
    && "userId" in value
    && typeof value.userId === "string"
    && "organizationId" in value
    && typeof value.organizationId === "string"
    && "connectorId" in value
    && typeof value.connectorId === "string"
    && value.connectorId.length > 0
    && "expiresAt" in value
    && typeof value.expiresAt === "number"
}

function signPrincipalPayload(payload: string) {
  return createHmac("sha256", INTERNAL_MCP_PRINCIPAL_SECRET).update(payload).digest("base64url")
}

function signCapabilityConnectorPayload(payload: string) {
  return createHmac("sha256", INTERNAL_MCP_PRINCIPAL_SECRET).update(`capability-connector:${payload}`).digest("base64url")
}

function verifySignature(payload: string, signature: string) {
  const expected = signPrincipalPayload(payload)
  const expectedBuffer = new Uint8Array(Buffer.from(expected))
  const receivedBuffer = new Uint8Array(Buffer.from(signature))
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)
}

export function createInternalMcpPrincipalHeader(input: { userId: string; organizationId: string }) {
  const principal: InternalMcpPrincipal = {
    userId: normalizeDenTypeId("user", input.userId),
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    expiresAt: Date.now() + INTERNAL_MCP_PRINCIPAL_TTL_MS,
  }
  const payload = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url")
  return `${payload}.${signPrincipalPayload(payload)}`
}

export function createInternalCapabilityConnectorHeader(input: {
  userId: string
  organizationId: string
  connectorId: string
}) {
  const connector: InternalCapabilityConnector = {
    userId: normalizeDenTypeId("user", input.userId),
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    connectorId: input.connectorId,
    expiresAt: Date.now() + INTERNAL_MCP_PRINCIPAL_TTL_MS,
  }
  const payload = Buffer.from(JSON.stringify(connector), "utf8").toString("base64url")
  return `${payload}.${signCapabilityConnectorPayload(payload)}`
}

// Verifies and parses the internal MCP principal header WITHOUT any DB access.
// Returns the principal only when the signature (per-process secret) and TTL are
// valid. Exported for unit testing of the trust boundary. Returns null for any
// missing, malformed, forged, or expired header.
export function verifyInternalMcpPrincipalHeader(header: string | null): InternalMcpPrincipal | null {
  if (!header) {
    return null
  }

  const [payload, signature] = header.split(".")
  if (!payload || !signature || !verifySignature(payload, signature)) {
    return null
  }

  let parsed: InternalMcpPrincipal
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as InternalMcpPrincipal
  } catch {
    return null
  }

  if (typeof parsed.userId !== "string" || typeof parsed.organizationId !== "string" || typeof parsed.expiresAt !== "number" || parsed.expiresAt < Date.now()) {
    return null
  }

  return parsed
}

export function readInternalCapabilityConnectorId(headers: Headers): string | null {
  const principal = verifyInternalMcpPrincipalHeader(headers.get(INTERNAL_MCP_PRINCIPAL_HEADER))
  const header = headers.get(INTERNAL_CAPABILITY_CONNECTOR_HEADER)
  if (!principal || !header) return null
  const [payload, signature] = header.split(".")
  if (!payload || !signature) return null
  const expected = signCapabilityConnectorPayload(payload)
  const expectedBuffer = new Uint8Array(Buffer.from(expected))
  const receivedBuffer = new Uint8Array(Buffer.from(signature))
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!isInternalCapabilityConnector(parsed)
    || parsed.expiresAt < Date.now()
    || parsed.userId !== principal.userId
    || parsed.organizationId !== principal.organizationId) {
    return null
  }
  return parsed.connectorId
}

async function getSessionFromInternalMcpPrincipal(headers: Headers): Promise<(AuthSessionValue & { activeOrganizationId: string }) | null> {
  const parsed = verifyInternalMcpPrincipalHeader(headers.get(INTERNAL_MCP_PRINCIPAL_HEADER))
  if (!parsed) {
    return null
  }

  const rows = await db
    .select({
      id: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
      image: AuthUserTable.image,
      createdAt: AuthUserTable.createdAt,
      updatedAt: AuthUserTable.updatedAt,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, normalizeDenTypeId("user", parsed.userId)))
    .limit(1)

  const user = rows[0]
  if (!user) {
    return null
  }

  return {
    user: {
      ...user,
      id: normalizeDenTypeId("user", user.id),
    },
    session: {
      id: "mcp_internal",
      token: "mcp_internal",
      userId: user.id,
      activeOrganizationId: normalizeDenTypeId("organization", parsed.organizationId),
      activeTeamId: null,
      expiresAt: new Date(parsed.expiresAt),
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    },
    activeOrganizationId: normalizeDenTypeId("organization", parsed.organizationId),
  }
}

function readBearerToken(headers: Headers): string | null {
  const header = headers.get("authorization")?.trim() ?? ""
  if (!header) {
    return null
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return null
  }

  const token = match[1]?.trim() ?? ""
  return token || null
}

function bearerSessionValue(row: CachedAuthSession): AuthSessionValue {
  return {
    session: row.session,
    user: {
      ...row.user,
      id: normalizeDenTypeId("user", row.user.id),
    },
  }
}

const logger = appLogger.child({ component: "session" })

function readDenApiKey(headers: Headers): string | null {
  const apiKey = headers.get(DEN_API_KEY_HEADER)?.trim() ?? ""
  return apiKey || null
}

async function getUserById(userId: string): Promise<AuthSessionValue["user"] | null> {
  const rows = await db
    .select({
      id: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
      image: AuthUserTable.image,
      createdAt: AuthUserTable.createdAt,
      updatedAt: AuthUserTable.updatedAt,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, normalizeDenTypeId("user", userId)))
    .limit(1)

  const user = rows[0]
  return user
    ? {
        ...user,
        id: normalizeDenTypeId("user", user.id),
      }
    : null
}

async function getSessionFromApiKey(headers: Headers): Promise<ApiKeyAuthResolution | null> {
  const apiKeySecret = readDenApiKey(headers)
  if (!apiKeySecret) {
    return null
  }

  const verified = await auth.api.verifyApiKey({
    body: { key: apiKeySecret },
  })
  if (!verified.valid || !verified.key?.id) {
    return null
  }

  const apiKey = await getApiKeySessionById(verified.key.id)
  if (!apiKey?.metadata?.organizationId || apiKey.referenceId !== verified.key.referenceId) {
    return null
  }

  const user = await getUserById(apiKey.referenceId)
  if (!user) {
    return null
  }

  return {
    apiKey,
    user,
    activeOrganizationId: normalizeDenTypeId("organization", apiKey.metadata.organizationId),
  }
}

function sessionRequestContext(context?: Context): SessionRequestContext | undefined {
  if (!context) {
    return undefined
  }

  const requestId = context.get("requestId")
  return {
    method: context.req.method,
    path: context.req.path,
    requestId: typeof requestId === "string" ? requestId : undefined,
  }
}

async function getSessionFromToken(token: string, requestContext?: SessionRequestContext): Promise<AuthSessionLike> {
  const result = await cache.auth.sessionResult(token)
  const row = result.value
  if (!row) {
    return null
  }
  if (result.source === "cache") {
    return bearerSessionValue(row)
  }

  const now = new Date()
  const refreshCutoff = getDenSessionRefreshCutoff(now)
  if (row.session.expiresAt > refreshCutoff) {
    return bearerSessionValue(row)
  }

  const nextExpiresAt = getDenSessionExpiresAt(now)
  try {
    await db
      .update(AuthSessionTable)
      .set({
        expiresAt: nextExpiresAt,
        updatedAt: now,
      })
      .where(and(
        eq(AuthSessionTable.token, token),
        gt(AuthSessionTable.expiresAt, now),
        lte(AuthSessionTable.expiresAt, refreshCutoff),
        lt(AuthSessionTable.expiresAt, nextExpiresAt),
      ))
  } catch (error) {
    logger.error("session refresh failed", {
      auth_session_source: "den_session_middleware",
      http_method: requestContext?.method,
      http_path: requestContext?.path,
      request_id: requestContext?.requestId,
      error,
    })
    throw error
  }

  await cache.auth.deleteSession(token)
  const renewed = await cache.auth.session(token)
  if (!renewed) {
    return null
  }
  return bearerSessionValue(renewed)
}

export async function readSignedSessionCookieToken(c: Context) {
  for (const cookieName of BETTER_AUTH_SESSION_COOKIE_NAMES) {
    const token = await getSignedCookie(c, env.betterAuthSecret, cookieName).catch(() => null)
    if (typeof token === "string" && token.length > 0) {
      return token
    }
  }
  return null
}

export async function revokeBearerSession(headers: Headers) {
  const token = readBearerToken(headers)
  if (!token) {
    return false
  }

  const rows = await db
    .select({ id: AuthSessionTable.id })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.token, token))
    .limit(1)
  await db.delete(AuthSessionTable).where(eq(AuthSessionTable.token, token))
  // Sign-out/revocation is the authoritative point that invalidates cached auth.
  await cache.auth.revokeSession(token)
  const session = rows[0]
  if (session) {
    await cache.auth.revokeSessionId(normalizeDenTypeId("session", session.id))
  }
  return true
}

export async function getRequestSession(headers: Headers, context?: Context): Promise<AuthSessionLike> {
  const internalMcpSession = await getSessionFromInternalMcpPrincipal(headers)
  if (internalMcpSession) {
    return internalMcpSession
  }

  const cookieToken = context ? await readSignedSessionCookieToken(context) : null
  if (cookieToken) {
    const cookieSession = await getSessionFromToken(cookieToken, sessionRequestContext(context))
    if (cookieSession?.user?.id) {
      return cookieSession
    }
  }

  const bearerToken = readBearerToken(headers)
  if (!bearerToken) {
    return null
  }

  return getSessionFromToken(bearerToken, sessionRequestContext(context))
}

export function shouldSkipRequestSession(request: Request) {
  return request.method.toUpperCase() === "POST"
    && new URL(request.url).pathname === "/api/auth/sign-out"
}

export const sessionMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  const skipRequestSession = shouldSkipRequestSession(c.req.raw)
  const apiKeyResolution = skipRequestSession
    ? null
    : await getSessionFromApiKey(c.req.raw.headers)
  const resolved = apiKeyResolution
    ? { user: apiKeyResolution.user, session: null }
    : (skipRequestSession
    ? null
    : await getRequestSession(c.req.raw.headers, c))
  c.set("user", resolved?.user ?? null)
  c.set("session", resolved?.session ?? null)
  const activeOrganizationId = apiKeyResolution?.activeOrganizationId ?? resolved?.session?.activeOrganizationId
  if (activeOrganizationId) {
    ;(c as unknown as { set: (key: string, value: unknown) => void }).set("activeOrganizationId", activeOrganizationId)
  }
  c.set("apiKey", apiKeyResolution?.apiKey ?? null)
  await next()
}
