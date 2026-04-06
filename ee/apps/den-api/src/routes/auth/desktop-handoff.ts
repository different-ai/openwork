import { randomBytes } from "node:crypto"
import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable, DesktopHandoffGrantTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { jsonValidator, requireUserMiddleware } from "../../middleware/index.js"
import { db } from "../../db.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const createGrantSchema = z.object({
  next: z.string().trim().max(128).optional(),
  desktopScheme: z.string().trim().max(32).optional(),
})

const exchangeGrantSchema = z.object({
  grant: z.string().trim().min(12).max(128),
})

const desktopHandoffGrantResponseSchema = z.object({
  grant: z.string(),
  expiresAt: z.string().datetime(),
  openworkUrl: z.string().url(),
}).meta({ ref: "DesktopHandoffGrantResponse" })

const desktopHandoffExchangeResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string().nullable(),
  }),
}).meta({ ref: "DesktopHandoffExchangeResponse" })

const grantNotFoundSchema = z.object({
  error: z.literal("grant_not_found"),
  message: z.string(),
}).meta({ ref: "DesktopHandoffGrantNotFoundError" })

function readSingleHeader(value: string | null) {
  const first = value?.split(",")[0]?.trim() ?? ""
  return first || null
}

function isWebAppHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()
  return normalized === "app.openworklabs.com"
    || normalized === "app.openwork.software"
    || normalized.startsWith("app.")
}

function withDenProxyPath(origin: string) {
  const url = new URL(origin)
  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.toLowerCase().endsWith("/api/den")) {
    return url.toString().replace(/\/+$/, "")
  }
  url.pathname = `${pathname}/api/den`.replace(/\/+/g, "/")
  return url.toString().replace(/\/+$/, "")
}

function resolveDesktopDenBaseUrl(request: Request) {
  const originHeader = readSingleHeader(request.headers.get("origin"))
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader)
      if ((originUrl.protocol === "https:" || originUrl.protocol === "http:") && isWebAppHost(originUrl.hostname)) {
        return withDenProxyPath(originUrl.origin)
      }
    } catch {
      // Ignore invalid origins.
    }
  }

  const forwardedProto = readSingleHeader(request.headers.get("x-forwarded-proto"))
  const forwardedHost = readSingleHeader(request.headers.get("x-forwarded-host"))
  const host = readSingleHeader(request.headers.get("host"))
  const protocol = forwardedProto ?? new URL(request.url).protocol.replace(/:$/, "")
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
  } catch {
    // Ignore invalid forwarded origins.
  }

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

export function registerDesktopAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.post(
    "/v1/auth/desktop-handoff",
    describeRoute({
      tags: ["Authentication"],
      summary: "Create desktop handoff grant",
      description: "Creates a short-lived desktop handoff grant and deep link so a signed-in web user can continue the same account in the OpenWork desktop app.",
      responses: {
        200: jsonResponse("Desktop handoff grant created successfully.", desktopHandoffGrantResponseSchema),
        400: jsonResponse("The handoff request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create a desktop handoff grant.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    jsonValidator(createGrantSchema),
    async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user?.id || !session?.token) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const input = c.req.valid("json")

    const grant = randomBytes(24).toString("base64url")
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
    await db.insert(DesktopHandoffGrantTable).values({
      id: grant,
      user_id: normalizeDenTypeId("user", user.id),
      session_token: session.token,
      expires_at: expiresAt,
      consumed_at: null,
    })

    const denBaseUrl = resolveDesktopDenBaseUrl(c.req.raw)

    return c.json({
      grant,
      expiresAt: expiresAt.toISOString(),
      openworkUrl: buildOpenworkDeepLink({
        scheme: input.desktopScheme || "openwork",
        grant,
        denBaseUrl,
      }),
    })
    },
  )

  app.post(
    "/v1/auth/desktop-handoff/exchange",
    describeRoute({
      tags: ["Authentication"],
      summary: "Exchange desktop handoff grant",
      description: "Exchanges a one-time desktop handoff grant for the user's session token and basic profile so the desktop app can sign the user in.",
      responses: {
        200: jsonResponse("Desktop handoff grant exchanged successfully.", desktopHandoffExchangeResponseSchema),
        400: jsonResponse("The handoff exchange request body was invalid.", invalidRequestSchema),
        404: jsonResponse("The handoff grant was missing, expired, or already used.", grantNotFoundSchema),
      },
    }),
    jsonValidator(exchangeGrantSchema),
    async (c) => {
    const input = c.req.valid("json")

    const now = new Date()
    const rows = await db
      .select({
        grant: DesktopHandoffGrantTable,
        session: AuthSessionTable,
        user: AuthUserTable,
      })
      .from(DesktopHandoffGrantTable)
      .innerJoin(AuthSessionTable, eq(DesktopHandoffGrantTable.session_token, AuthSessionTable.token))
      .innerJoin(AuthUserTable, eq(DesktopHandoffGrantTable.user_id, AuthUserTable.id))
      .where(
        and(
          eq(DesktopHandoffGrantTable.id, input.grant),
          isNull(DesktopHandoffGrantTable.consumed_at),
          gt(DesktopHandoffGrantTable.expires_at, now),
          gt(AuthSessionTable.expiresAt, now),
        ),
      )
      .limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({
        error: "grant_not_found",
        message: "This desktop sign-in link is missing, expired, or already used.",
      }, 404)
    }

    await db
      .update(DesktopHandoffGrantTable)
      .set({ consumed_at: now })
      .where(
        and(
          eq(DesktopHandoffGrantTable.id, input.grant),
          isNull(DesktopHandoffGrantTable.consumed_at),
        ),
      )

    return c.json({
      token: row.session.token,
      user: {
        id: row.user.id,
        email: row.user.email,
        name: row.user.name,
      },
    })
    },
  )
}
