import { randomBytes } from "node:crypto"
import { and, desc, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable, DaytonaSandboxTable, DesktopHandoffGrantTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { jsonValidator, publicRoute, userSessionRoute } from "../../middleware/index.js"
import { db } from "../../db.js"
import { env, type DenOrgMode } from "../../env.js"
import { resolveUserOrganizations } from "../../orgs.js"
import { denTypeIdSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { enforceRateLimit } from "../../utils/rate-limit.js"
import { CLOUD_INSTANCE_BACKEND } from "../../workers/cloud-constants.js"

const createGrantSchema = z.object({
  next: z.string().trim().max(128).optional().describe("Optional continuation hint for handoff clients."),
  desktopScheme: z.string().trim().max(32).optional().describe("Optional desktop URL scheme to use when building the OpenWork deep link."),
  returnUrl: z.string().trim().max(2048).optional().describe("Optional HTTPS OpenWork Cloud web return URL. Accepted only for multi-organization Cloud instances after server-side origin validation."),
}).meta({ ref: "DesktopHandoffGrantCreateBody" })

const exchangeGrantSchema = z.object({
  grant: z.string().trim().min(12).max(128),
})

const statusGrantSchema = z.object({
  grant: z.string().trim().min(12).max(128),
})

const desktopHandoffGrantResponseSchema = z.object({
  grant: z.string(),
  expiresAt: z.string().datetime(),
  openworkUrl: z.string().url(),
  returnUrl: z.string().url().optional(),
}).meta({ ref: "DesktopHandoffGrantResponse" })

const desktopHandoffExchangeResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: denTypeIdSchema("user"),
    email: z.string().email(),
    name: z.string().nullable(),
  }),
  organization: z.object({
    id: denTypeIdSchema("organization"),
    slug: z.string(),
    name: z.string(),
  }).nullable(),
  connectEnabled: z.boolean().nullable(),
}).meta({ ref: "DesktopHandoffExchangeResponse" })

const desktopHandoffStatusResponseSchema = z.object({
  status: z.enum(["pending", "consumed", "unknown"]),
}).meta({ ref: "DesktopHandoffStatusResponse" })

const grantNotFoundSchema = z.object({
  error: z.literal("grant_not_found"),
  message: z.string(),
}).meta({ ref: "DesktopHandoffGrantNotFoundError" })

const rateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "DesktopHandoffRateLimitedError" })

const invalidReturnUrlSchema = z.object({
  error: z.literal("invalid_return_url"),
  message: z.string(),
}).meta({ ref: "DesktopHandoffInvalidReturnUrlError" })

const createGrantBadRequestSchema = z.union([invalidRequestSchema, invalidReturnUrlSchema]).meta({ ref: "DesktopHandoffCreateBadRequest" })

const HANDOFF_STATUS_RATE_LIMIT_WINDOW_MS = 60 * 1000
const HANDOFF_STATUS_RATE_LIMIT_MAX = 240
type WorkerOrgId = typeof WorkerTable.$inferSelect.org_id

type ApprovedWebHandoffReturnUrlCandidate = {
  origin: string
  returnUrl: string
}

function readSingleHeader(value: string | null) {
  const first = value?.split(",")[0]?.trim() ?? ""
  return first || null
}

function isWebAppHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()

  if (
    normalized === "localhost"
    || normalized === "0.0.0.0"
    || normalized === "::1"
    || normalized === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  ) {
    return true
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [first, second, third, fourth] = ipv4Match.slice(1).map(Number)
    const octets = [first, second, third, fourth]
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      if (
        first === 10
        || first === 127
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254)
        || (first === 100 && second >= 64 && second <= 127)
      ) {
        return true
      }
    }
  }

  const configuredHosts = env.webAppHosts
  if (configuredHosts.some((host) => (host.startsWith(".") ? normalized.endsWith(host) : normalized === host))) {
    return true
  }

  return normalized === "app.openworklabs.com"
    || normalized === "app.openwork.software"
    || normalized.startsWith("app.")
    // Cloud Run hostnames serve the den-web frontend, which only exposes the
    // Den API behind its /api/den proxy path (see #1807).
    || normalized.endsWith(".run.app")
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

function configuredDesktopDenBaseUrl() {
  return env.desktopDenBaseUrl ?? withDenProxyPath(env.webUrl)
}

export function resolveDesktopDenBaseUrl(request: Request) {
  const originHeader = readSingleHeader(request.headers.get("origin"))
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader)
      if (originUrl.hostname === "0.0.0.0") {
        return configuredDesktopDenBaseUrl()
      }
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
    return configuredDesktopDenBaseUrl()
  }

  const origin = `${protocol}://${targetHost}`
  try {
    const url = new URL(origin)
    if (url.hostname === "0.0.0.0") {
      return configuredDesktopDenBaseUrl()
    }
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

function rawPathnameForUrl(value: string) {
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)
  return match?.[1] ?? "/"
}

function hasPathTraversal(pathname: string) {
  const candidates = [pathname.toLowerCase()]
  try {
    candidates.push(decodeURIComponent(pathname).toLowerCase())
  } catch {
    // Keep the original escaped path candidate.
  }

  return candidates.some((candidate) => candidate.split("/").some((segment) => segment === "." || segment === ".."))
}

function resolveWebHandoffReturnUrlCandidate(input: {
  returnUrl: string
  orgMode: DenOrgMode
}): ApprovedWebHandoffReturnUrlCandidate | null {
  if (input.orgMode !== "multi_org") {
    return null
  }

  let candidate: URL
  try {
    candidate = new URL(input.returnUrl)
  } catch {
    return null
  }

  if (
    candidate.protocol !== "https:"
    || candidate.username
    || candidate.password
    || candidate.hash
    || hasPathTraversal(rawPathnameForUrl(input.returnUrl))
  ) {
    return null
  }

  if (candidate.pathname !== "/" && candidate.pathname !== "/signin") {
    return null
  }

  return {
    origin: candidate.origin,
    returnUrl: `${candidate.origin}/signin`,
  }
}

function isConfiguredGatewayOrigin(candidateOrigin: string, gatewayOrigin: string | null | undefined) {
  if (!gatewayOrigin) {
    return false
  }

  let gateway: URL
  try {
    gateway = new URL(gatewayOrigin)
  } catch {
    return false
  }

  if (
    gateway.protocol !== "https:"
    || gateway.username
    || gateway.password
    || gateway.search
    || gateway.hash
    || (gateway.pathname !== "/" && gateway.pathname !== "")
  ) {
    return false
  }

  // Exact-origin only. As with Daytona preview origins, suffix-based gateway
  // matches would approve an attacker-controlled origin.
  return candidateOrigin === gateway.origin
}

function isSignedPreviewOrigin(candidateOrigin: string, signedPreviewUrl: string) {
  let signedPreview: URL
  try {
    signedPreview = new URL(signedPreviewUrl)
  } catch {
    return false
  }

  if (signedPreview.protocol !== "https:") {
    return false
  }

  // Exact-origin only. The Daytona preview proxy zone is shared by every
  // Daytona customer, so any suffix-based match would approve an
  // attacker-controlled sandbox origin and leak one-time session grants.
  // If the preview URL was re-signed between opening the instance and
  // signing in, this fails closed and the user reopens Cloud for a fresh
  // URL.
  return candidateOrigin === signedPreview.origin
}

export function approveWebHandoffReturnUrl(input: {
  returnUrl: string
  signedPreviewUrl: string
  orgMode: DenOrgMode
  gatewayOrigin?: string | null
}) {
  const candidate = resolveWebHandoffReturnUrlCandidate(input)
  if (!candidate) {
    return null
  }

  if (isConfiguredGatewayOrigin(candidate.origin, input.gatewayOrigin)) {
    return candidate.returnUrl
  }

  if (isSignedPreviewOrigin(candidate.origin, input.signedPreviewUrl)) {
    return candidate.returnUrl
  }

  return null
}

export function approveWebHandoffReturnUrlForSignedPreviews(input: {
  returnUrl: string
  signedPreviewUrls: string[]
  orgMode: DenOrgMode
  gatewayOrigin?: string | null
}) {
  const candidate = resolveWebHandoffReturnUrlCandidate(input)
  if (!candidate) {
    return null
  }

  if (isConfiguredGatewayOrigin(candidate.origin, input.gatewayOrigin)) {
    return candidate.returnUrl
  }

  for (const signedPreviewUrl of input.signedPreviewUrls) {
    if (isSignedPreviewOrigin(candidate.origin, signedPreviewUrl)) {
      return candidate.returnUrl
    }
  }

  return null
}

async function getCloudSignedPreviewUrls(organizationId: WorkerOrgId) {
  const rows = await db
    .select({ signedPreviewUrl: DaytonaSandboxTable.signed_preview_url })
    .from(WorkerTable)
    .innerJoin(DaytonaSandboxTable, eq(WorkerTable.id, DaytonaSandboxTable.worker_id))
    .where(and(
      eq(WorkerTable.org_id, organizationId),
      eq(WorkerTable.destination, "cloud"),
      eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
    ))
    .orderBy(desc(WorkerTable.created_at))

  return rows.map((row) => row.signedPreviewUrl)
}

export async function resolveApprovedWebHandoffReturnUrl(input: {
  returnUrl: string
  activeOrganizationId?: string | null
}) {
  const gatewayReturnUrl = approveWebHandoffReturnUrlForSignedPreviews({
    returnUrl: input.returnUrl,
    signedPreviewUrls: [],
    orgMode: env.orgMode,
    gatewayOrigin: env.gatewayOrigin,
  })
  if (gatewayReturnUrl) {
    return gatewayReturnUrl
  }

  if (env.orgMode !== "multi_org" || !input.activeOrganizationId) {
    return null
  }

  let organizationId: WorkerOrgId
  try {
    organizationId = normalizeDenTypeId("organization", input.activeOrganizationId)
  } catch {
    return null
  }

  const signedPreviewUrls = await getCloudSignedPreviewUrls(organizationId)
  return approveWebHandoffReturnUrlForSignedPreviews({
    returnUrl: input.returnUrl,
    signedPreviewUrls,
    orgMode: env.orgMode,
    gatewayOrigin: env.gatewayOrigin,
  })
}

export function registerDesktopAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.post(
    "/v1/auth/desktop-handoff",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Create desktop handoff grant",
      description: "Creates a short-lived handoff grant for a signed-in web user. Desktop clients receive an OpenWork deep link; approved Cloud web clients also receive a validated return URL.",
      responses: {
        200: jsonResponse("Desktop handoff grant created successfully.", desktopHandoffGrantResponseSchema),
        400: jsonResponse("The handoff request body or Cloud web return URL was invalid.", createGrantBadRequestSchema),
        401: jsonResponse("The caller must be signed in to create a desktop handoff grant.", unauthorizedSchema),
      },
    }),
    userSessionRoute(),
    jsonValidator(createGrantSchema),
    async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user?.id || !session?.token) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const input = c.req.valid("json")
    let approvedReturnUrl: string | null = null
    if (input.returnUrl !== undefined) {
      approvedReturnUrl = await resolveApprovedWebHandoffReturnUrl({
        returnUrl: input.returnUrl,
        activeOrganizationId: session.activeOrganizationId,
      })
      if (!approvedReturnUrl) {
        return c.json({
          error: "invalid_return_url",
          message: "The Cloud web handoff return URL is not approved for this organization.",
        }, 400)
      }
    }

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
      ...(approvedReturnUrl ? { returnUrl: approvedReturnUrl } : {}),
    })
    },
  )

  app.post(
    "/v1/auth/desktop-handoff/status",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Check desktop handoff grant status",
      description: "Returns whether a short-lived desktop handoff grant is still pending, has been consumed, or is no longer valid. It never returns session tokens or user details.",
      responses: {
        200: jsonResponse("Desktop handoff grant status resolved successfully.", desktopHandoffStatusResponseSchema),
        400: jsonResponse("The handoff status request body was invalid.", invalidRequestSchema),
        429: jsonResponse("Too many handoff status checks.", rateLimitedSchema),
      },
    }),
    publicRoute,
    jsonValidator(statusGrantSchema),
    async (c) => {
      const retryAfter = await enforceRateLimit(c.req.raw.headers, "handoff:handoff-status", HANDOFF_STATUS_RATE_LIMIT_MAX, HANDOFF_STATUS_RATE_LIMIT_WINDOW_MS)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many handoff status checks. Try again later." }, 429)
      }

      const input = c.req.valid("json")
      const [grant] = await db
        .select({ consumedAt: DesktopHandoffGrantTable.consumed_at, expiresAt: DesktopHandoffGrantTable.expires_at })
        .from(DesktopHandoffGrantTable)
        .where(eq(DesktopHandoffGrantTable.id, input.grant))
        .limit(1)

      if (!grant) {
        return c.json({ status: "unknown" })
      }

      if (grant.consumedAt) {
        return c.json({ status: "consumed" })
      }

      return c.json({ status: grant.expiresAt > new Date() ? "pending" : "unknown" })
    },
  )

  app.post(
    "/v1/auth/desktop-handoff/exchange",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Exchange desktop handoff grant",
      description: "Exchanges a one-time desktop handoff grant for the user's session token and basic profile so the desktop app can sign the user in.",
      responses: {
        200: jsonResponse("Desktop handoff grant exchanged successfully.", desktopHandoffExchangeResponseSchema),
        400: jsonResponse("The handoff exchange request body was invalid.", invalidRequestSchema),
        404: jsonResponse("The handoff grant was missing, expired, or already used.", grantNotFoundSchema),
      },
    }),
    publicRoute,
    jsonValidator(exchangeGrantSchema),
    async (c) => {
    const input = c.req.valid("json")

    const now = new Date()
    const exchange = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
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
        return null
      }

      const consumedAt = new Date()
      await tx
        .update(DesktopHandoffGrantTable)
        .set({ consumed_at: consumedAt })
        .where(
          and(
            eq(DesktopHandoffGrantTable.id, input.grant),
            isNull(DesktopHandoffGrantTable.consumed_at),
            gt(DesktopHandoffGrantTable.expires_at, now),
          ),
        )

      const claimed = await tx
        .select({ id: DesktopHandoffGrantTable.id })
        .from(DesktopHandoffGrantTable)
        .where(
          and(
            eq(DesktopHandoffGrantTable.id, input.grant),
            eq(DesktopHandoffGrantTable.consumed_at, consumedAt),
          ),
        )
        .limit(1)

      if (!claimed[0]) {
        return null
      }

      return {
        token: row.session.token,
        user: {
          id: row.user.id,
          email: row.user.email,
          name: row.user.name,
        },
        activeOrganizationId: row.session.activeOrganizationId,
      }
    })

    if (!exchange) {
      return c.json({
        error: "grant_not_found",
        message: "This desktop sign-in link is missing, expired, or already used.",
      }, 404)
    }

    // Tell the desktop which organization this sign-in belongs to so the app
    // never has to guess (or race /v1/me/orgs) right after a handoff. Falls
    // back to null when the session has no resolvable organization; the app
    // then repairs through its normal org-resolution path.
    let organization: { id: string; slug: string; name: string } | null = null
    let organizationMetadata: string | null = null
    try {
      const resolved = await resolveUserOrganizations({
        userId: normalizeDenTypeId("user", exchange.user.id),
        activeOrganizationId: exchange.activeOrganizationId,
      })
      const activeOrg = resolved.orgs.find((org) => org.id === resolved.activeOrgId) ?? null
      organization = activeOrg ? { id: activeOrg.id, slug: activeOrg.slug, name: activeOrg.name } : null
      organizationMetadata = activeOrg?.metadata ?? null
    } catch {
      organization = null
    }

    let connectEnabled: boolean | null = null
    if (organization) {
      try {
        connectEnabled = memberFacingMcpConnectionsEnabled(organizationMetadata, {
          gatingEnabled: env.mcpConnectionsGatingEnabled,
        })
      } catch {
        connectEnabled = null
      }
    }

    return c.json({
      token: exchange.token,
      user: exchange.user,
      organization,
      connectEnabled,
    })
    },
  )
}
