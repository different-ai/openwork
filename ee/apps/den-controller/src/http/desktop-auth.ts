import { randomBytes } from "node:crypto"
import express from "express"
import { and, eq, gt, isNull } from "../db/drizzle.js"
import { db } from "../db/index.js"
import { AuthSessionTable, AuthUserTable, DesktopHandoffGrantTable } from "../db/schema.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { asyncRoute } from "./errors.js"
import { getRequestSession } from "./session.js"
import { z } from "zod"

const desktopAuthRouter = express.Router()

const createGrantSchema = z.object({
  next: z.string().trim().max(128).optional(),
  desktopScheme: z.string().trim().max(32).optional(),
})

const exchangeGrantSchema = z.object({
  grant: z.string().trim().min(12).max(128),
})

function readSingleHeader(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const first = value.split(",")[0]?.trim() ?? ""
  return first || null
}

function isWebAppHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  return normalized === "app.openworklabs.com"
    || normalized === "app.openwork.software"
    || normalized.startsWith("app.")
}

function withDenProxyPath(origin: string): string {
  const url = new URL(origin)
  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.toLowerCase().endsWith("/api/den")) {
    return url.toString().replace(/\/+$/, "")
  }
  url.pathname = `${pathname}/api/den`.replace(/\/+/g, "/")
  return url.toString().replace(/\/+$/, "")
}

function resolveDesktopDenBaseUrl(req: express.Request): string {
  const originHeader = readSingleHeader(req.headers.origin)
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader)
      if ((originUrl.protocol === "https:" || originUrl.protocol === "http:") && isWebAppHost(originUrl.hostname)) {
        return withDenProxyPath(originUrl.origin)
      }
    } catch {}
  }

  const forwardedProto = readSingleHeader(req.headers["x-forwarded-proto"])
  const forwardedHost = readSingleHeader(req.headers["x-forwarded-host"])
  const host = readSingleHeader(req.headers.host)
  const protocol = forwardedProto ?? req.protocol ?? "https"
  const targetHost = forwardedHost ?? host
  if (!targetHost) {
    return "https://app.openworklabs.com/api/den"
  }

  const origin = `${protocol}://${targetHost}`
  try {
    const url = new URL(origin)
    if (isWebAppHost(url.hostname)) {
      return withDenProxyPath(url.origin)
    }
  } catch {}

  return origin
}

function buildOpenworkDeepLink(input: {
  scheme?: string | null
  grant: string
  denBaseUrl: string
}) {
  const requestedScheme = input.scheme?.trim() || "openwork"
  const scheme = /^[a-z][a-z0-9+.-]*$/i.test(requestedScheme)
    ? requestedScheme
    : "openwork"
  const url = new URL(`${scheme}://den-auth`)
  url.searchParams.set("grant", input.grant)
  url.searchParams.set("denBaseUrl", input.denBaseUrl)
  return url.toString()
}

desktopAuthRouter.post(
  "/desktop-handoff",
  asyncRoute(async (req, res) => {
    const session = await getRequestSession(req)
    if (!session?.user?.id || !session.session?.token) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = createGrantSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
      return
    }

    const grant = randomBytes(24).toString("base64url")
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
    await db.insert(DesktopHandoffGrantTable).values({
      id: grant,
      user_id: normalizeDenTypeId("user", session.user.id),
      session_token: session.session.token,
      expires_at: expiresAt,
      consumed_at: null,
    })

    const denBaseUrl = resolveDesktopDenBaseUrl(req)

    res.json({
      grant,
      expiresAt: expiresAt.toISOString(),
      openworkUrl: buildOpenworkDeepLink({
        scheme: parsed.data.desktopScheme || "openwork",
        grant,
        denBaseUrl,
      }),
    })
  }),
)

desktopAuthRouter.post(
  "/desktop-handoff/exchange",
  asyncRoute(async (req, res) => {
    const parsed = exchangeGrantSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
      return
    }

    const now = new Date()
    const rows = await db
      .select({
        grant: DesktopHandoffGrantTable,
        session: AuthSessionTable,
        user: AuthUserTable,
      })
      .from(DesktopHandoffGrantTable)
      .innerJoin(
        AuthSessionTable,
        eq(DesktopHandoffGrantTable.session_token, AuthSessionTable.token),
      )
      .innerJoin(
        AuthUserTable,
        eq(DesktopHandoffGrantTable.user_id, AuthUserTable.id),
      )
      .where(
        and(
          eq(DesktopHandoffGrantTable.id, parsed.data.grant),
          isNull(DesktopHandoffGrantTable.consumed_at),
          gt(DesktopHandoffGrantTable.expires_at, now),
          gt(AuthSessionTable.expiresAt, now),
        ),
      )
      .limit(1)

    const row = rows[0]
    if (!row) {
      res.status(404).json({
        error: "grant_not_found",
        message: "This desktop sign-in link is missing, expired, or already used.",
      })
      return
    }

    await db
      .update(DesktopHandoffGrantTable)
      .set({ consumed_at: now })
      .where(
        and(
          eq(DesktopHandoffGrantTable.id, parsed.data.grant),
          isNull(DesktopHandoffGrantTable.consumed_at),
        ),
      )

    res.json({
      token: row.session.token,
      user: {
        id: row.user.id,
        email: row.user.email,
        name: row.user.name,
      },
    })
  }),
)

export { desktopAuthRouter }
