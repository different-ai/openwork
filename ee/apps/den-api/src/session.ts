import { and, eq, gt } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
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
  c.set("apiKey", apiKey)
  await next()
}
