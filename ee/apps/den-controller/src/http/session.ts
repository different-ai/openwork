import type express from "express"
import { fromNodeHeaders } from "better-auth/node"
import { and, eq, gt } from "../db/drizzle.js"
import { auth } from "../auth.js"
import { db } from "../db/index.js"
import { AuthSessionTable, AuthUserTable } from "../db/schema.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

type AuthSessionLike = Awaited<ReturnType<typeof auth.api.getSession>>

function readBearerToken(req: express.Request): string | null {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : ""
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

export async function getRequestSession(req: express.Request): Promise<AuthSessionLike> {
  const cookieSession = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })
  if (cookieSession?.user?.id) {
    return {
      ...cookieSession,
      user: {
        ...cookieSession.user,
        id: normalizeDenTypeId("user", cookieSession.user.id),
      },
    }
  }

  const bearerToken = readBearerToken(req)
  if (!bearerToken) {
    return null
  }

  return getSessionFromBearerToken(bearerToken)
}
