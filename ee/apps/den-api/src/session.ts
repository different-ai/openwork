import { and, eq, gt } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { DEN_API_KEY_HEADER, getApiKeySessionById, type DenApiKeySession } from "./api-keys.js"
import { auth } from "./auth.js"
import { db } from "./db.js"

type AuthSessionLike = Awaited<ReturnType<typeof auth.api.getSession>>
type AuthSessionValue = NonNullable<AuthSessionLike>

export type AuthContextVariables = {
  user: AuthSessionValue["user"] | null
  session: AuthSessionValue["session"] | null
  apiKey: DenApiKeySession | null
}

const INTERNAL_MCP_PRINCIPAL_HEADER = "x-den-internal-mcp-principal"
const INTERNAL_MCP_PRINCIPAL_TTL_MS = 60_000

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

function signPrincipalPayload(payload: string) {
  return createHmac("sha256", INTERNAL_MCP_PRINCIPAL_SECRET).update(payload).digest("base64url")
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

async function getSessionFromBearerToken(token: string): Promise<AuthSessionLike> {
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
    .where(and(eq(AuthSessionTable.token, token), gt(AuthSessionTable.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }

  return {
    session: row.session,
    user: {
      ...row.user,
      id: normalizeDenTypeId("user", row.user.id),
    },
  }
}

export async function getRequestSession(headers: Headers): Promise<AuthSessionLike> {
  const internalMcpSession = await getSessionFromInternalMcpPrincipal(headers)
  if (internalMcpSession) {
    return internalMcpSession
  }

  let cookieSession: AuthSessionLike
  try {
    cookieSession = await auth.api.getSession({ headers })
  } catch {
    return null
  }

  if (cookieSession?.user?.id) {
    return {
      ...cookieSession,
      user: {
        ...cookieSession.user,
        id: normalizeDenTypeId("user", cookieSession.user.id),
      },
    }
  }

  const bearerToken = readBearerToken(headers)
  if (!bearerToken) {
    return null
  }

  return getSessionFromBearerToken(bearerToken)
}

async function getRequestApiKeySession(headers: Headers, session: AuthSessionLike): Promise<DenApiKeySession | null> {
  if (!headers.has(DEN_API_KEY_HEADER) || !session?.session?.id) {
    return null
  }

  return getApiKeySessionById(session.session.id)
}

export const sessionMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  const resolved = await getRequestSession(c.req.raw.headers)
  const apiKey = await getRequestApiKeySession(c.req.raw.headers, resolved)
  c.set("user", resolved?.user ?? null)
  c.set("session", resolved?.session ?? null)
  if (resolved?.session?.activeOrganizationId) {
    ;(c as unknown as { set: (key: string, value: unknown) => void }).set("activeOrganizationId", resolved.session.activeOrganizationId)
  }
  c.set("apiKey", apiKey)
  await next()
}
