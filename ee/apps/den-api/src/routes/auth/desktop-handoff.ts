import { randomBytes } from "node:crypto"
import { and, desc, eq, gt, isNull, lt } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable, CloudRuntimeInstanceTable, DesktopHandoffGrantTable, MemberTable, OrganizationTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { cloudHostingAvailable } from "../../capability-sources/cloud-hosting.js"
import { recordDesktopHandoffCreated, recordSessionHandedOff } from "../../audit/domain/sessions.js"
import { attributeAuditRequest, auditSessionUserAttribution } from "../../audit/request-capture.js"
import { createOrganizationSessionToken, createSessionToken, sessionTokenDigest, sessionTokenMatches } from "../../session-token.js"
import { isPlatformAdminUserId, jsonValidator, publicRoute, userSessionRoute } from "../../middleware/index.js"
import { db } from "../../db.js"
import { env, type DenOrgMode } from "../../env.js"
import { ensurePersonalOrganizationForUser, resolveUserOrganizations } from "../../orgs.js"
import { findMemberOrganizationsApprovingWebOrigin, isWebOriginApprovedForOrganization } from "../../organization-web-origins.js"
import { denTypeIdSchema, invalidRequestSchema, jsonResponse, notFoundSchema, ssoRequiredSchema, unauthorizedSchema } from "../../openapi.js"
import { carrySessionSsoProofs, findSsoAccessBlock, ssoRequiredErrorBody } from "../../organization-sso-access.js"
import { userSessionExpiresAt } from "../../session-security-lifetime.js"
import type { AuthContextVariables } from "../../session.js"
import { enforceRateLimit } from "../../utils/rate-limit.js"
import { CLOUD_INSTANCE_BACKEND } from "../../workers/cloud-constants.js"

const createGrantSchema = z.object({
  next: z.string().trim().max(128).optional().describe("Optional continuation hint for handoff clients."),
  desktopScheme: z.literal("openwork").optional().describe("The registered OpenWork desktop URL scheme."),
  returnUrl: z.string().trim().max(2048).optional().describe("Optional HTTPS web return URL, validated server-side. Accepted in multi-organization mode, and on single-organization installs with OpenWork Web on for the configured gateway origin only."),
  confirmed: z.boolean().optional().describe("True once the person confirmed signing in to a website their organization approved. Without it, such a return URL answers 409 confirmation_required and no grant is created."),
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

const confirmationRequiredSchema = z.object({
  error: z.literal("confirmation_required"),
  message: z.string(),
  returnHost: z.string(),
  organizationName: z.string(),
}).meta({ ref: "DesktopHandoffConfirmationRequiredError" })

const organizationWebsiteRefusedSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string(),
}).meta({ ref: "DesktopHandoffOrganizationWebsiteRefusedError" })

// Expired grants are deleted a day later, a few at a time as new ones are created.
const HANDOFF_GRANT_RETENTION_MS = 24 * 60 * 60 * 1000
const HANDOFF_GRANT_PURGE_BATCH = 200

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
  grant: string
  denBaseUrl: string
}) {
  const url = new URL("openwork://den-auth")
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
  openworkWebEnabled?: boolean
}): ApprovedWebHandoffReturnUrlCandidate | null {
  if (!cloudHostingAvailable({ orgMode: input.orgMode, openworkWebEnabled: input.openworkWebEnabled === true })) {
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
  openworkWebEnabled?: boolean
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
  openworkWebEnabled?: boolean
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
    .select({ signedPreviewUrl: CloudRuntimeInstanceTable.endpoint_url })
    .from(WorkerTable)
    .innerJoin(CloudRuntimeInstanceTable, eq(WorkerTable.id, CloudRuntimeInstanceTable.worker_id))
    .where(and(
      eq(WorkerTable.org_id, organizationId),
      eq(WorkerTable.destination, "cloud"),
      eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
    ))
    .orderBy(desc(WorkerTable.created_at))

  return rows.map((row) => row.signedPreviewUrl)
}

type WebHandoffApproval = {
  returnUrl: string
  /**
   * The organization whose own approval matched. The website then receives a
   * session that works in this organization only, after the person confirms.
   * Null for the deployment's gateway and OpenWork Cloud previews.
   */
  organizationId: WorkerOrgId | null
}

function normalizeOptionalOrganizationId(value: string | null | undefined): WorkerOrgId | null {
  if (!value) return null
  try {
    return normalizeDenTypeId("organization", value)
  } catch {
    return null
  }
}

function normalizeOptionalUserId(value: string | null | undefined) {
  if (!value) return null
  try {
    return normalizeDenTypeId("user", value)
  } catch {
    return null
  }
}

export async function resolveWebHandoffApproval(input: {
  returnUrl: string
  activeOrganizationId?: string | null
  userId?: string | null
  loadSignedPreviewUrls?: (organizationId: WorkerOrgId) => Promise<string[]>
}): Promise<WebHandoffApproval | null> {
  // The configured OpenWork Web gateway: multi-org, or a single-org install
  // with OpenWork Web on (its own gateway is then the only web return origin).
  const gatewayReturnUrl = approveWebHandoffReturnUrlForSignedPreviews({
    returnUrl: input.returnUrl,
    signedPreviewUrls: [],
    orgMode: env.orgMode,
    openworkWebEnabled: env.openworkWebEnabled,
    gatewayOrigin: env.gatewayOrigin,
  })
  if (gatewayReturnUrl) {
    return { returnUrl: gatewayReturnUrl, organizationId: null }
  }

  // Organization-approved origins and sandbox preview origins stay multi-org only.
  if (env.orgMode !== "multi_org") {
    return null
  }

  const candidate = resolveWebHandoffReturnUrlCandidate({ returnUrl: input.returnUrl, orgMode: env.orgMode })
  if (!candidate) {
    return null
  }

  // Exact origins the active organization's owners approved in Org settings.
  const activeOrganizationId = normalizeOptionalOrganizationId(input.activeOrganizationId)
  if (activeOrganizationId && await isWebOriginApprovedForOrganization(activeOrganizationId, candidate.origin)) {
    return { returnUrl: candidate.returnUrl, organizationId: activeOrganizationId }
  }

  // A fresh sign-in by someone in several organizations has no active
  // organization yet, and a member may be active in another one. Approval by
  // any organization the user currently belongs to is enough; the handoff then
  // lands them in that organization.
  const userId = normalizeOptionalUserId(input.userId)
  if (userId) {
    const [approvingOrganizationId] = await findMemberOrganizationsApprovingWebOrigin(userId, candidate.origin)
    if (approvingOrganizationId) {
      return { returnUrl: candidate.returnUrl, organizationId: approvingOrganizationId }
    }
  }

  if (!activeOrganizationId) {
    return null
  }

  const signedPreviewUrls = await (input.loadSignedPreviewUrls ?? getCloudSignedPreviewUrls)(activeOrganizationId)
  const previewReturnUrl = approveWebHandoffReturnUrlForSignedPreviews({
    returnUrl: input.returnUrl,
    signedPreviewUrls,
    orgMode: env.orgMode,
    gatewayOrigin: env.gatewayOrigin,
  })
  return previewReturnUrl ? { returnUrl: previewReturnUrl, organizationId: null } : null
}

export async function resolveApprovedWebHandoffReturnUrl(input: Parameters<typeof resolveWebHandoffApproval>[0]) {
  return (await resolveWebHandoffApproval(input))?.returnUrl ?? null
}

/** The organization the handed-over session belongs to, when the user is an active member of it. */
async function verifiedHandoffOrganization(userIdRaw: string, organizationIdRaw: string | null | undefined): Promise<{ organizationId: WorkerOrgId; memberId: string } | null> {
  const organizationId = normalizeOptionalOrganizationId(organizationIdRaw)
  const userId = normalizeOptionalUserId(userIdRaw)
  if (!organizationId || !userId) return null
  const [member] = await db.select({ id: MemberTable.id }).from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt))).limit(1)
  return member ? { organizationId, memberId: member.id } : null
}

export function registerDesktopAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.post(
    "/v1/auth/desktop-handoff",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      security: [{ bearerAuth: [] }],
      summary: "Create desktop handoff grant",
      description: "Creates a short-lived handoff grant for a signed-in web user. Desktop clients receive an OpenWork deep link; approved Cloud web clients also receive a validated return URL. A website an organization approved needs the person's confirmation first, and its grant exchanges for a session that works in that organization only.",
      responses: {
        200: jsonResponse("Desktop handoff grant created successfully.", desktopHandoffGrantResponseSchema),
        400: jsonResponse("The handoff request body or Cloud web return URL was invalid.", createGrantBadRequestSchema),
        401: jsonResponse("The caller must be signed in to create a desktop handoff grant.", unauthorizedSchema),
        403: jsonResponse("The organization requires SSO and this session did not sign in through it, or a platform administrator asked to sign in to an organization's website.", z.union([ssoRequiredSchema, organizationWebsiteRefusedSchema])),
        409: jsonResponse("The return URL is a website an organization approved, and the person has not confirmed signing in to it yet. No grant was created.", confirmationRequiredSchema),
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
    // Set when an organization approved the website: its session is bound to that organization.
    let boundOrganizationId: WorkerOrgId | null = null
    if (input.returnUrl !== undefined) {
      const approval = await resolveWebHandoffApproval({
        returnUrl: input.returnUrl,
        activeOrganizationId: session.activeOrganizationId,
        userId: user.id,
      })
      if (!approval) {
        return c.json({
          error: "invalid_return_url",
          message: "The Cloud web handoff return URL is not approved for this organization.",
        }, 400)
      }
      approvedReturnUrl = approval.returnUrl
      boundOrganizationId = approval.organizationId
    }

    // never hand a session to the desktop inside an
    // organization that requires SSO unless the session signed in through it.
    const ssoBlock = await findSsoAccessBlock({ sessionId: session.id, organizationId: boundOrganizationId ?? session.activeOrganizationId })
    if (ssoBlock) {
      return c.json(ssoRequiredErrorBody(ssoBlock), 403)
    }

    if (boundOrganizationId && approvedReturnUrl) {
      // Platform authority follows the person, not the session, in places an
      // organization-bound session can still reach, so it never leaves OpenWork.
      if (await isPlatformAdminUserId(user.id)) {
        return c.json({
          error: "forbidden",
          message: "Platform administrators cannot sign in to an organization's website with this account.",
        }, 403)
      }
      // The website is the organization's choice, not OpenWork's: the person
      // sees where they are signing in before any grant exists.
      if (input.confirmed !== true) {
        const [organization] = await db.select({ name: OrganizationTable.name }).from(OrganizationTable)
          .where(eq(OrganizationTable.id, boundOrganizationId)).limit(1)
        return c.json({
          error: "confirmation_required",
          message: "Confirm signing in to this website.",
          returnHost: new URL(approvedReturnUrl).host,
          organizationName: organization?.name ?? "",
        }, 409)
      }
    }

    // Audit: the grant hands over a session in its organization. With a
    // verified active membership there the request is attributed before any
    // write (intent fails closed); without one the request stays platform
    // evidence and desktop_handoff.created fans out to every membership.
    const handoffOrganizationId = await verifiedHandoffOrganization(user.id, boundOrganizationId ?? session.activeOrganizationId)
    if (handoffOrganizationId) {
      const attribution = auditSessionUserAttribution(user.id, handoffOrganizationId.memberId)
      const audited = attribution ? await attributeAuditRequest(c, { organizationId: handoffOrganizationId.organizationId, ...attribution }) : { ok: true as const }
      if (!audited.ok) return audited.response
    }

    // The grant names the signed-in session and never holds its token: the
    // exchange gives the recipient a session of its own.
    const grant = randomBytes(24).toString("base64url")
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
    await db.insert(DesktopHandoffGrantTable).values({
      id: grant,
      user_id: normalizeDenTypeId("user", user.id),
      session_id: normalizeDenTypeId("session", session.id),
      organization_id: boundOrganizationId,
      expires_at: expiresAt,
      consumed_at: null,
    })
    await db.delete(DesktopHandoffGrantTable)
      .where(lt(DesktopHandoffGrantTable.expires_at, new Date(Date.now() - HANDOFF_GRANT_RETENTION_MS)))
      .limit(HANDOFF_GRANT_PURGE_BATCH)
      .catch(() => undefined)

    await recordDesktopHandoffCreated({ userId: user.id, sessionId: session.id, organizationId: handoffOrganizationId?.organizationId ?? null, expiresAt, returnUrlApproved: approvedReturnUrl !== null })

    const denBaseUrl = resolveDesktopDenBaseUrl(c.req.raw)

    return c.json({
      grant,
      expiresAt: expiresAt.toISOString(),
      openworkUrl: buildOpenworkDeepLink({
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
      security: [],
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
      // primary: polled right after the grant is created and consumed; a lagging "unknown" reads as invalid.
      const [grant] = await db.$primary
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
      security: [],
      summary: "Exchange desktop handoff grant",
      description: "Exchanges a one-time desktop handoff grant for a new session token and basic profile so the recipient can sign the user in. The session is the recipient's own, created from the signed-in session the grant names.",
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
    const userAgent = c.req.header("user-agent")?.trim().slice(0, 512) || null
    const exchange = await db.transaction(async (tx) => {
      const grants = await tx
        .select({
          sessionId: DesktopHandoffGrantTable.session_id,
          legacySessionToken: DesktopHandoffGrantTable.session_token,
          organizationId: DesktopHandoffGrantTable.organization_id,
          userId: DesktopHandoffGrantTable.user_id,
        })
        .from(DesktopHandoffGrantTable)
        .where(
          and(
            eq(DesktopHandoffGrantTable.id, input.grant),
            isNull(DesktopHandoffGrantTable.consumed_at),
            gt(DesktopHandoffGrantTable.expires_at, now),
          ),
        )
        .limit(1)

      const grant = grants[0]
      if (!grant) {
        return null
      }

      // The signed-in session the grant was created from must still be live.
      // A grant written before grants stopped holding tokens names it by token.
      const createdFrom = grant.sessionId
        ? eq(AuthSessionTable.id, grant.sessionId)
        : grant.legacySessionToken ? sessionTokenMatches(grant.legacySessionToken) : null
      if (!createdFrom) {
        return null
      }
      const rows = await tx
        .select({
          session: AuthSessionTable,
          user: AuthUserTable,
        })
        .from(AuthSessionTable)
        .innerJoin(AuthUserTable, eq(AuthUserTable.id, AuthSessionTable.userId))
        .where(and(createdFrom, eq(AuthSessionTable.userId, grant.userId), gt(AuthSessionTable.expiresAt, now)))
        .limit(1)

      const row = rows[0]
      if (!row) {
        return null
      }

      const consumedAt = new Date()
      await tx
        .update(DesktopHandoffGrantTable)
        .set({ consumed_at: consumedAt, session_token: null })
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

      // The recipient's own session. It keeps the sign-in time of the session
      // it came from, so it is no fresher for step-up checks and ends by the
      // same maximum length. One for an organization's website is bound to
      // that organization by its token (session-token.ts).
      const token = grant.organizationId ? createOrganizationSessionToken(grant.organizationId) : createSessionToken()
      const sessionId = createDenTypeId("session")
      const expiresAt = await userSessionExpiresAt(row.session.userId, now, row.session.createdAt)
      const activeOrganizationId = grant.organizationId ?? row.session.activeOrganizationId
      await tx.insert(AuthSessionTable).values({
        id: sessionId,
        userId: row.session.userId,
        activeOrganizationId,
        activeTeamId: grant.organizationId ? null : row.session.activeTeamId,
        token: sessionTokenDigest(token),
        expiresAt,
        createdAt: row.session.createdAt,
        ipAddress: null,
        userAgent,
      })

      return {
        token,
        createdFromSessionId: row.session.id,
        boundOrganizationId: grant.organizationId,
        session: { id: sessionId, userId: row.session.userId, expiresAt },
        user: {
          id: row.user.id,
          email: row.user.email,
          name: row.user.name,
        },
        activeOrganizationId,
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
    try {
      const userId = normalizeDenTypeId("user", exchange.user.id)
      let resolved = await resolveUserOrganizations({
        userId,
        activeOrganizationId: exchange.activeOrganizationId,
      })
      // Bootstrap only an authenticated desktop handoff, not browser onboarding
      // or membership in a managed single-org deployment.
      if (env.orgMode === "multi_org" && resolved.orgs.length === 0) {
        const organizationId = await ensurePersonalOrganizationForUser(userId)
        resolved = await resolveUserOrganizations({
          userId,
          activeOrganizationId: organizationId,
          // primary: the organization was just created.
          reader: db.$primary,
        })
      }
      const activeOrg = resolved.orgs.find((org) => org.id === resolved.activeOrgId) ?? null
      // A bound session names its own organization or none: never another one.
      organization = activeOrg && (!exchange.boundOrganizationId || activeOrg.id === exchange.boundOrganizationId)
        ? { id: activeOrg.id, slug: activeOrg.slug, name: activeOrg.name }
        : null
    } catch {
      organization = null
    }

    // An organization that requires SSO opens only from a session that signed
    // in through it; the new session keeps the proofs of the one it came from.
    // Without them the new session simply cannot open such an organization.
    await carrySessionSsoProofs({ fromSessionId: exchange.createdFromSessionId, toSessionId: exchange.session.id, userId: exchange.session.userId })
      .catch(() => undefined)

    // The recipient's session comes from a signed-in web session, not a new
    // sign-in: session.handed_off in the session's organization, or every
    // active membership when it has none.
    await recordSessionHandedOff({ ...exchange.session, activeOrganizationId: exchange.activeOrganizationId })

    return c.json({
      token: exchange.token,
      user: exchange.user,
      organization,
      // Compatibility field for published desktops: Connect is always on.
      connectEnabled: organization ? true : null,
    })
    },
  )
}
