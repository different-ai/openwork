import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { createHash } from "node:crypto"
import { and, eq, gt, sql } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthUserTable, InvitationTable, OAuthClientTable } from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import type { Context } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auth, DEN_MCP_OAUTH_RESOURCE, normalizeMcpOAuthResource } from "../../auth.js"
import { buildLoginOptionsSessionCookieClearHeaders, normalizeLoginEmail, resolveLoginOptionKind } from "../../auth-login-options.js"
import { verifyBotProtection } from "../../bot-protection.js"
import {
  EMAIL_PASSWORD_SIGN_UP_PATH,
  getBreachedPasswordResponse,
  getEmailPasswordLockoutResponse,
  getPasswordPolicyResponse,
  getWeakPasswordResponse,
  readEmailSignInAttempt,
  recordEmailSignInResult,
} from "../../auth-protection.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { findEnterpriseAuthRequirementForEmailDomain } from "../../enterprise-auth-requirement.js"
import {
  authorizeInitialAdminBootstrapSignup,
  completeInitialAdminBootstrapSignup,
  getInitialAdminBootstrapAvailability,
  initialAdminBootstrapSignupRejectedResponse,
  readInitialAdminBootstrapGrantFromBody,
  verifyInitialAdminBootstrap,
} from "../../initial-admin-bootstrap.js"
import { getInvalidMcpOAuthRedirectUris, isAllowedMcpOAuthRedirectUri, MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION } from "../../mcp/oauth-client-policy.js"
import { normalizeMcpOAuthClientScope } from "../../mcp/scopes.js"
import { publicRoute, queryValidator, tokenRoute } from "../../middleware/index.js"
import { checkOAuthTokenRateLimit, recordOAuthTokenFailure } from "../../oauth-token-rate-limit.js"
import { getOAuthTokenRateLimitLogFields, readBasicAuthClientId } from "../../oauth-token-rate-limit-observability.js"
import { emptyObjectSchema, emptyResponse, jsonResponse } from "../../openapi.js"
import { getSingletonSsoStatus } from "../../orgs.js"
import { cache } from "../../cache.js"
import { appLogger } from "../../observability/logger.js"
import { getAuthRequestEmail, getSingleOrgEmailSignupPolicyViolation, type SingleOrgEmailSignupPolicyViolation } from "../../single-org-signup-policy.js"
import { samlResponsePolicyMiddleware } from "../../sso-saml-response-middleware.js"
import { authorizeOrganizationSsoCallback, failOrganizationSsoTestIntent } from "../../sso-test-lifecycle.js"
import { getRequestSession, readSignedSessionCookieToken, revokeBearerSession, type AuthContextVariables } from "../../session.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import { registerDesktopAuthRoutes } from "./desktop-handoff.js"
import { normalizeOAuthAuthorizeRedirect } from "./oauth-redirect.js"
import { registerScimAuthRoutes } from "./scim.js"

const logger = appLogger.child({ component: "auth" })

function rewriteAuthRequest(request: Request, path: string) {
  const url = new URL(request.url)
  url.pathname = path
  return new Request(url, request)
}

function normalizedPath(request: Request) {
  const path = new URL(request.url).pathname
  return path !== "/" ? path.replace(/\/+$/, "") : path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

type McpOAuthResourceNormalization =
  | { ok: true; changed: boolean }
  | { ok: false; response: Response }

function oauthInvalidTargetResponse(errorDescription: string, tokenEndpoint: boolean) {
  const headers = new Headers({ "content-type": "application/json" })
  if (tokenEndpoint) {
    headers.set("Cache-Control", "no-store")
    headers.set("Pragma", "no-cache")
  }
  return new Response(JSON.stringify({ error: "invalid_target", error_description: errorDescription }), {
    status: 400,
    headers,
  })
}

function readOAuthScopeList(scope: string | null) {
  return (normalizeMcpOAuthClientScope(scope) ?? "").split(" ").filter(Boolean)
}

function hasMcpOAuthScope(scopes: readonly string[]) {
  return scopes.some((scope) => scope === "mcp:read" || scope === "mcp:write")
}

function readStoredOAuthClientScopes(scopes: string | null) {
  if (!scopes) return []
  try {
    const parsed: unknown = JSON.parse(scopes)
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string")
    }
  } catch {
    // Better Auth has used both JSON arrays and space-delimited strings for scopes.
  }
  return readOAuthScopeList(scopes)
}

async function registeredClientHasMcpScope(clientId: string) {
  const [client] = await db
    .select({ scopes: OAuthClientTable.scopes })
    .from(OAuthClientTable)
    .where(eq(OAuthClientTable.clientId, clientId))
    .limit(1)

  return client ? hasMcpOAuthScope(readStoredOAuthClientScopes(client.scopes)) : false
}

function normalizeMcpOAuthResourceParams(searchParams: URLSearchParams, tokenEndpoint: boolean, resourceRequired: boolean): McpOAuthResourceNormalization {
  const resources = searchParams.getAll("resource")
  if (resources.length === 0) {
    if (!resourceRequired) {
      return { ok: true, changed: false }
    }
    return {
      ok: false,
      response: oauthInvalidTargetResponse("MCP OAuth requests must include the protected resource.", tokenEndpoint),
    }
  }
  if (resources.length > 1) {
    return {
      ok: false,
      response: oauthInvalidTargetResponse("MCP OAuth requests must include exactly one protected resource.", tokenEndpoint),
    }
  }

  const normalized = normalizeMcpOAuthResource(resources[0] ?? "")
  if (!normalized) {
    return {
      ok: false,
      response: oauthInvalidTargetResponse("The requested MCP OAuth resource is not recognized by this deployment.", tokenEndpoint),
    }
  }

  const changed = normalized !== resources[0]
  if (!changed) {
    return { ok: true, changed: false }
  }

  searchParams.delete("resource")
  searchParams.append("resource", normalized)
  return { ok: true, changed: true }
}

async function normalizeMcpOAuthUrl(request: Request) {
  const url = new URL(request.url)
  const clientId = url.searchParams.get("client_id")
  const requestHasMcpScope = hasMcpOAuthScope(readOAuthScopeList(url.searchParams.get("scope")))
  const registeredClientHasMcp = clientId ? await registeredClientHasMcpScope(clientId) : false
  if (!requestHasMcpScope && !registeredClientHasMcp) {
    return request
  }

  const redirectUri = url.searchParams.get("redirect_uri")
  if (redirectUri && !isAllowedMcpOAuthRedirectUri(redirectUri)) {
    return oauthRegistrationError(400, "invalid_redirect_uri", MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION)
  }

  const result = normalizeMcpOAuthResourceParams(url.searchParams, false, true)
  if (!result.ok) return result.response
  return result.changed ? new Request(url, request) : request
}

export async function normalizeMcpOAuthRequest(request: Request) {
  const url = new URL(request.url)
  const path = getBetterAuthProxyPath(url.pathname)
  if (path === "/oauth2/authorize") {
    return normalizeMcpOAuthUrl(request)
  }
  if (path !== "/oauth2/token") {
    return request
  }

  if (request.method.toUpperCase() !== "POST") {
    return request
  }

  const headers = new Headers(request.headers)
  const contentType = headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return request
  }

  const body = new URLSearchParams(await request.clone().text())

  const clientId = body.get("client_id") ?? readBasicAuthClientId(headers)
  const resourceRequired = clientId ? await registeredClientHasMcpScope(clientId) : false
  const inferredRefreshResource = resourceRequired
    && body.get("grant_type") === "refresh_token"
    && !body.has("resource")

  if (inferredRefreshResource) {
    // MCP clients should send resource on every token request, but some clients
    // omit it while refreshing. Public MCP has exactly one valid audience, so
    // defaulting only this grant preserves audience binding without widening it.
    body.set("resource", DEN_MCP_OAUTH_RESOURCE)
  }

  const result = normalizeMcpOAuthResourceParams(body, true, resourceRequired)
  if (!result.ok) {
    return result.response
  }
  if (!inferredRefreshResource && !result.changed) {
    return request
  }

  headers.delete("content-length")
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  })
}

function singleOrgModeResponse() {
  return Response.json({
    error: "single_org_mode",
    message: "This deployment is configured for one organization. Additional organization changes are disabled.",
  }, { status: 409 })
}

function singleOrgSsoRequiredResponse(signInPath: string) {
  return Response.json({
    error: "single_org_sso_required",
    message: "This deployment uses organization SSO. Continue with SSO to sign in.",
    signInPath,
  }, { status: 403 })
}

function singleOrgEmailSignupPolicyResponse(violation: SingleOrgEmailSignupPolicyViolation) {
  return Response.json(violation, { status: 403 })
}

async function getInitialAdminBootstrapGrantFromRequest(request: Request) {
  if (!isBetterAuthEmailSignupRequest(request)) {
    return null
  }
  try {
    return readInitialAdminBootstrapGrantFromBody(await request.clone().json())
  } catch {
    return null
  }
}

export function getBetterAuthProxyPath(pathname: string) {
  const prefix = "/api/auth"
  if (!pathname.startsWith(prefix)) {
    return pathname
  }

  return pathname.slice(prefix.length) || "/"
}

export function isBetterAuthOrganizationCreationRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/organization/create"
}

export function isBetterAuthSetActiveOrganizationRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/organization/set-active"
}

export function isBetterAuthEmailPasswordRequest(request: Request) {
  const url = new URL(request.url)
  const path = getBetterAuthProxyPath(url.pathname)
  return request.method.toUpperCase() === "POST" && (path === "/sign-in/email" || path === "/sign-up/email")
}

export function isBetterAuthEmailSignupRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/sign-up/email"
}

export function isBetterAuthSignOutRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/sign-out"
}

export function canSetActiveOrganizationInSingleOrgMode(input: {
  activeOrganizationId: string | null
  singleOrganizationSlug: string
  requestedOrganizationId?: string | null
  requestedOrganizationSlug?: string | null
}) {
  if (input.requestedOrganizationId === undefined && input.requestedOrganizationSlug === undefined) {
    return true
  }

  return (
    (!!input.activeOrganizationId && input.requestedOrganizationId === input.activeOrganizationId) ||
    input.requestedOrganizationSlug === input.singleOrganizationSlug
  )
}

async function readSetActiveOrganizationBody(request: Request) {
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return null
  }

  if (!isRecord(body)) {
    return null
  }

  return {
    organizationId: typeof body.organizationId === "string" || body.organizationId === null ? body.organizationId : undefined,
    organizationSlug: typeof body.organizationSlug === "string" || body.organizationSlug === null ? body.organizationSlug : undefined,
  }
}

async function getCurrentActiveOrganizationId(request: Request, context: Context) {
  const session = await getRequestSession(request.headers, context)
  const activeOrganizationId = session?.session.activeOrganizationId
  return typeof activeOrganizationId === "string" ? activeOrganizationId : null
}

async function getSingleOrgAuthGuardResponse(request: Request, context: Context, options?: { invitationSignupAllowed?: boolean }) {
  if (env.orgMode !== "single_org") {
    return null
  }

  if (isBetterAuthOrganizationCreationRequest(request)) {
    return singleOrgModeResponse()
  }

  if (isBetterAuthEmailSignupRequest(request)) {
    const violation = options?.invitationSignupAllowed
      ? null
      : await getSingleOrgEmailSignupPolicyViolation(await getAuthRequestEmail(request))
    if (violation) {
      return singleOrgEmailSignupPolicyResponse(violation)
    }
  }

  if (isBetterAuthEmailPasswordRequest(request)) {
    const status = await getSingletonSsoStatus()
    if (status.configured) {
      return singleOrgSsoRequiredResponse(status.signInPath)
    }
  }

  if (!isBetterAuthSetActiveOrganizationRequest(request)) {
    return null
  }

  const body = await readSetActiveOrganizationBody(request)
  if (!body) {
    return null
  }

  const activeOrganizationId = await getCurrentActiveOrganizationId(request, context)
  return canSetActiveOrganizationInSingleOrgMode({
    activeOrganizationId,
    singleOrganizationSlug: env.singleOrg.slug,
    requestedOrganizationId: body.organizationId,
    requestedOrganizationSlug: body.organizationSlug,
  })
    ? null
    : singleOrgModeResponse()
}

function oauthRegistrationError(status: number, error: string, errorDescription: string) {
  return new Response(JSON.stringify({ error, error_description: errorDescription }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function rewriteMcpClientRegistrationRequest(request: Request, path: string) {
  const url = new URL(request.url)
  url.pathname = path

  const headers = new Headers(request.headers)
  const contentType = headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    return new Request(url, request)
  }

  let parsedBody: unknown
  try {
    parsedBody = await request.json()
  } catch {
    return oauthRegistrationError(400, "invalid_client_metadata", "Registration request body must be valid JSON.")
  }

  if (!isRecord(parsedBody)) {
    return oauthRegistrationError(400, "invalid_client_metadata", "Registration request body must be a JSON object.")
  }

  const body = parsedBody
  const invalidRedirectUris = [
    ...getInvalidMcpOAuthRedirectUris(body.redirect_uris),
    ...getInvalidMcpOAuthRedirectUris(body.post_logout_redirect_uris),
  ]
  if (invalidRedirectUris.length > 0) {
    return oauthRegistrationError(
      400,
      "invalid_redirect_uri",
      MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION,
    )
  }

  const normalizedScope = normalizeMcpOAuthClientScope(body.scope)
  if (normalizedScope) {
    body.scope = normalizedScope
  }

  headers.set("content-type", "application/json")
  headers.delete("content-length")

  return new Request(url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
  })
}

async function handleMcpClientRegistrationRequest(request: Request, path: string) {
  const rewritten = await rewriteMcpClientRegistrationRequest(request, path)
  return rewritten instanceof Response ? rewritten : auth.handler(rewritten)
}

// Better Auth includes RFC 9207 `iss` on successful code responses but not on
// every compatibility path. Keep clients tolerant of an absent value; clients
// still validate it against `issuer` whenever the callback does include it.
async function makeAuthorizationResponseIssuerOptional(response: Response) {
  const metadata: unknown = await response.clone().json()
  if (!isRecord(metadata)) {
    return response
  }

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  metadata.authorization_response_iss_parameter_supported = false
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    headers,
  })
}

async function getOAuthAuthorizationServerMetadata(request: Request) {
  return makeAuthorizationResponseIssuerOptional(await oauthProviderAuthServerMetadata(auth)(request))
}

async function getOAuthOpenIdConfiguration(request: Request) {
  return makeAuthorizationResponseIssuerOptional(await oauthProviderOpenIdConfigMetadata(auth)(request))
}

const authLoginLockedSchema = z.object({
  error: z.literal("login_locked"),
  message: z.string(),
}).meta({ ref: "AuthLoginLockedError" })

const authPasswordScreeningUnavailableSchema = z.object({
  error: z.literal("password_screening_unavailable"),
  message: z.string(),
}).meta({ ref: "AuthPasswordScreeningUnavailableError" })

const loginOptionsQuerySchema = z.object({
  email: z.string().trim().email().transform(normalizeLoginEmail),
  invite: z.string().trim().min(1).optional(),
})

const loginOptionKindSchema = z.union([
  z.literal("sso"),
  z.literal("google"),
  z.literal("github"),
  z.literal("password"),
  z.literal("new_account"),
])

const loginOptionsResponseSchema = z.object({
  email: z.string().email(),
  nextStep: loginOptionKindSchema,
  allowPublicSignup: z.boolean().optional(),
  allowInvitationSignup: z.boolean().optional(),
  organizationSlug: z.string().optional(),
  signInPath: z.string().optional(),
  signInUrl: z.string().url().optional(),
}).meta({ ref: "AuthLoginOptionsResponse" })

const loginOptionsBotVerificationFailedSchema = z.object({
  error: z.literal("bot_verification_failed"),
  message: z.string(),
}).meta({ ref: "LoginOptionsBotVerificationFailedError" })

const loginOptionsRateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "LoginOptionsRateLimitedError" })

const LOGIN_OPTIONS_IDENTITY_RATE_LIMIT_MAX = 20
const LOGIN_OPTIONS_RATE_LIMIT_WINDOW_MS = 60_000
// Domain buckets deliberately use a LONG window instead of a bigger per-minute
// count. Coworkers need burst tolerance (a whole team signing in at once);
// enumeration is bounded by SUSTAINED throughput. Against the previous flat
// 20/min domain bucket both sustained rates are strictly lower: 120 per 10 min
// = 12/min overall, and 30 misses per 10 min = 3/min for the account-discovery
// path that actually leaks which addresses exist.
const LOGIN_OPTIONS_DOMAIN_RATE_LIMIT_WINDOW_MS = 600_000
const LOGIN_OPTIONS_DOMAIN_RATE_LIMIT_MAX = 120
const LOGIN_OPTIONS_DOMAIN_MISS_RATE_LIMIT_MAX = 30
const INITIAL_ADMIN_BOOTSTRAP_VERIFY_RATE_LIMIT_MAX = 5
const INITIAL_ADMIN_BOOTSTRAP_VERIFY_RATE_LIMIT_WINDOW_MS = 300_000
// A generous domain bucket bounds distributed enumeration without recreating coworker lockouts;
// only unresolved addresses pay the tighter miss bucket.

function readRequestAddress(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function loginOptionsRateLimitKeys(headers: Headers, email: string) {
  const domainHash = sha256Hex(email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase())
  return {
    ip: `auth-login-options:ip:${sha256Hex(readRequestAddress(headers))}`,
    email: `auth-login-options:email:${sha256Hex(email)}`,
    domain: `auth-login-options:domain:${domainHash}`,
    domainMiss: `auth-login-options:domain-miss:${domainHash}`,
  }
}

async function checkLoginOptionsRateLimit(keys: ReturnType<typeof loginOptionsRateLimitKeys>) {
  const now = Date.now()

  for (const key of [keys.ip, keys.email]) {
    const retryAfter = await checkRateLimit(key, LOGIN_OPTIONS_IDENTITY_RATE_LIMIT_MAX, LOGIN_OPTIONS_RATE_LIMIT_WINDOW_MS, now)
    if (retryAfter !== null) {
      return retryAfter
    }
  }

  return checkRateLimit(keys.domain, LOGIN_OPTIONS_DOMAIN_RATE_LIMIT_MAX, LOGIN_OPTIONS_DOMAIN_RATE_LIMIT_WINDOW_MS, now)
}

function checkLoginOptionsMissRateLimit(key: string) {
  return checkRateLimit(key, LOGIN_OPTIONS_DOMAIN_MISS_RATE_LIMIT_MAX, LOGIN_OPTIONS_DOMAIN_RATE_LIMIT_WINDOW_MS, Date.now())
}

function initialAdminBootstrapVerifyRateLimitKey(email: string) {
  return `auth-bootstrap:verify:email:${sha256Hex(email)}`
}

async function getLoginOptionAccounts(email: string) {
  const rows = await db
    .select({
      providerId: AuthAccountTable.providerId,
      password: AuthAccountTable.password,
    })
    .from(AuthUserTable)
    .innerJoin(AuthAccountTable, eq(AuthUserTable.id, AuthAccountTable.userId))
    .where(eq(AuthUserTable.email, email))

  return rows.map((row) => ({
    providerId: row.providerId,
    hasPassword: Boolean(row.password),
  }))
}

async function hasPendingInvitationForEmail(invitationIdOrToken: string | undefined, email: string) {
  if (!invitationIdOrToken) {
    return false
  }

  const [invitation] = await db
    .select({ inviteToken: InvitationTable.inviteToken })
    .from(InvitationTable)
    .where(and(
      sql`(${InvitationTable.id} = ${invitationIdOrToken} or ${InvitationTable.inviteToken} = ${invitationIdOrToken})`,
      eq(InvitationTable.status, "pending"),
      gt(InvitationTable.expiresAt, new Date()),
      sql`lower(${InvitationTable.email}) = ${email}`,
    ))
    .limit(1)

  return Boolean(invitation)
}

async function isInvitationSignupAllowed(request: Request) {
  if (request.method !== "POST" || normalizedPath(request) !== EMAIL_PASSWORD_SIGN_UP_PATH) {
    return false
  }

  const invite = new URL(request.url).searchParams.get("invite")?.trim() ?? ""
  if (!invite) {
    return false
  }

  const email = await getAuthRequestEmail(request)
  return email ? hasPendingInvitationForEmail(invite, normalizeLoginEmail(email)) : false
}

async function getOrganizationSsoCallbackRequest(request: Request) {
  const url = new URL(request.url)
  const proxyPath = getBetterAuthProxyPath(url.pathname)
  const oidcPrefix = "/sso/callback/"
  const samlPrefix = "/sso/saml2/sp/acs/"
  if (proxyPath.startsWith(oidcPrefix)) {
    return {
      providerId: decodeURIComponent(proxyPath.slice(oidcPrefix.length)),
      stateIdentifier: url.searchParams.get("state"),
    }
  }
  if (!proxyPath.startsWith(samlPrefix)) return null

  let stateIdentifier = url.searchParams.get("RelayState")
  if (!stateIdentifier && request.method.toUpperCase() === "POST") {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
    if (contentType.includes("application/x-www-form-urlencoded")) {
      stateIdentifier = new URLSearchParams(await request.clone().text()).get("RelayState")
    } else if (contentType.includes("application/json")) {
      const body: unknown = await request.clone().json().catch(() => null)
      stateIdentifier = isRecord(body) && typeof body.RelayState === "string" ? body.RelayState : null
    }
  }
  return {
    providerId: decodeURIComponent(proxyPath.slice(samlPrefix.length)),
    stateIdentifier,
  }
}

async function handleAuthRequest(c: Context) {
  const request = c.req.raw
  const observabilityRequest = request.method === "POST"
    && getBetterAuthProxyPath(new URL(request.url).pathname) === "/oauth2/token"
    ? request.clone()
    : null
  const oauthTokenRateLimit = observabilityRequest
    ? await checkOAuthTokenRateLimit(request, checkRateLimit)
    : null
  if (observabilityRequest && oauthTokenRateLimit?.response) {
    const rateLimitFields = await getOAuthTokenRateLimitLogFields(observabilityRequest, oauthTokenRateLimit.response)
    if (rateLimitFields) {
      logger.warn("oauth token request rate limited", rateLimitFields)
    }
    return oauthTokenRateLimit.response
  }
  const authRequest = await normalizeMcpOAuthRequest(request)
  if (authRequest instanceof Response) {
    if (oauthTokenRateLimit) {
      // Malformed token requests rejected before auth.handler must still
      // consume the failure budget, or repeated invalid-resource submissions
      // would only ever pay the looser attempt buckets.
      await recordOAuthTokenFailure(oauthTokenRateLimit.failureKey, authRequest, checkRateLimit)
    }
    return authRequest
  }
  const ssoCallbackRequest = await getOrganizationSsoCallbackRequest(authRequest)
  const ssoCallbackAuthorization = ssoCallbackRequest
    ? await authorizeOrganizationSsoCallback(ssoCallbackRequest)
    : null
  if (ssoCallbackAuthorization && !ssoCallbackAuthorization.ok) {
    return Response.json({
      error: "sso_not_enabled",
      message: ssoCallbackAuthorization.message,
    }, { status: 403 })
  }
  const invitationSignupAllowed = await isInvitationSignupAllowed(authRequest)
  const initialAdminBootstrapGrant = await getInitialAdminBootstrapGrantFromRequest(authRequest)

  const emailSignInAttempt = await readEmailSignInAttempt(authRequest)
  if (emailSignInAttempt) {
    const lockoutResponse = await getEmailPasswordLockoutResponse(emailSignInAttempt)
    if (lockoutResponse) {
      return lockoutResponse
    }
  }

  if (!initialAdminBootstrapGrant) {
    const singleOrgAuthGuardResponse = await getSingleOrgAuthGuardResponse(authRequest, c, { invitationSignupAllowed })
    if (singleOrgAuthGuardResponse) {
      return singleOrgAuthGuardResponse
    }
  }

  const passwordPolicyResponse = await getPasswordPolicyResponse(authRequest)
  if (passwordPolicyResponse) {
    return passwordPolicyResponse
  }

  const weakPasswordResponse = await getWeakPasswordResponse(authRequest)
  if (weakPasswordResponse) {
    return weakPasswordResponse
  }

  const breachedPasswordResponse = await getBreachedPasswordResponse(authRequest)
  if (breachedPasswordResponse) {
    return breachedPasswordResponse
  }

  const initialAdminBootstrapAuthorization = initialAdminBootstrapGrant
    ? await authorizeInitialAdminBootstrapSignup({
        body: await authRequest.clone().json().catch(() => null),
        email: await getAuthRequestEmail(authRequest),
      })
    : null
  if (initialAdminBootstrapGrant && !initialAdminBootstrapAuthorization) {
    return initialAdminBootstrapSignupRejectedResponse()
  }

  // Desktop sessions use an Authorization bearer and intentionally send no
  // cookies. Better Auth's sign-out endpoint only deletes the cookie-backed
  // session, so explicitly revoke the bearer row first; auth.handler still
  // runs to preserve its normal idempotent response and cookie cleanup for
  // browser callers.
  if (isBetterAuthSignOutRequest(authRequest)) {
    const cookieToken = await readSignedSessionCookieToken(c)
    if (cookieToken) {
      await cache.auth.revokeSession(cookieToken)
    }
    await revokeBearerSession(authRequest.headers)
  }

  let response: Response
  try {
    response = await auth.handler(authRequest)
  } catch (error) {
    if (ssoCallbackAuthorization?.ok && ssoCallbackAuthorization.mode === "test") {
      await failOrganizationSsoTestIntent(ssoCallbackAuthorization.intentId, "authentication")
    }
    const requestId = c.get("requestId")
    logger.error("better auth handler failed", {
      auth_session_source: "better_auth_handler",
      http_method: authRequest.method,
      http_path: new URL(authRequest.url).pathname,
      request_id: typeof requestId === "string" ? requestId : undefined,
      error,
    })
    throw error
  }
  if (ssoCallbackAuthorization?.ok && ssoCallbackAuthorization.mode === "test") {
    const location = response.headers.get("location")
    const failed = response.status >= 400 || (location ? new URL(location, env.betterAuthUrl).searchParams.has("error") : false)
    if (failed) {
      await failOrganizationSsoTestIntent(ssoCallbackAuthorization.intentId, "authentication")
    }
  }
  if (initialAdminBootstrapAuthorization) {
    response = await completeInitialAdminBootstrapSignup({
      grant: initialAdminBootstrapAuthorization,
      response,
    })
  }
  if (emailSignInAttempt) {
    await recordEmailSignInResult(emailSignInAttempt, response)
  }
  if (oauthTokenRateLimit) {
    await recordOAuthTokenFailure(oauthTokenRateLimit.failureKey, response, checkRateLimit)
  }
  if (observabilityRequest) {
    const rateLimitFields = await getOAuthTokenRateLimitLogFields(observabilityRequest, response)
    if (rateLimitFields) {
      logger.warn("oauth token request rate limited", rateLimitFields)
    }
  }
  return response
}

export function registerAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  registerScimAuthRoutes(app)
  app.use("/api/auth/sso/saml2/callback/*", samlResponsePolicyMiddleware)
  app.use("/api/auth/sso/saml2/sp/acs/*", samlResponsePolicyMiddleware)
  // Better Auth uses this configured base URL for the callback `iss` value.
  // Keep discovery on that same canonical issuer even when these routes are
  // reached through a separate API or reverse-proxy origin.
  // OAuth 2.0 / OIDC discovery documents (RFC 8414, OpenID Connect Discovery
  // 1.0) are served at every path an MCP client may probe. Their bodies follow
  // the RFCs verbatim, so they are documented as opaque objects.
  const oauthAuthorizationServerMetadataRoute = describeRoute({
    tags: ["OAuth"],
    security: [],
    summary: "Get OAuth authorization server metadata",
    description: "Returns the RFC 8414 authorization server metadata for the Den OAuth issuer used by MCP clients.",
    responses: { 200: jsonResponse("Authorization server metadata (RFC 8414).", emptyObjectSchema) },
  })
  const openIdConfigurationRoute = describeRoute({
    tags: ["OAuth"],
    security: [],
    summary: "Get OpenID Connect discovery document",
    description: "Returns the OpenID Connect Discovery 1.0 configuration for the Den OAuth issuer used by MCP clients.",
    responses: { 200: jsonResponse("OpenID Connect discovery document.", emptyObjectSchema) },
  })
  const dynamicClientRegistrationRoute = describeRoute({
    tags: ["OAuth"],
    security: [],
    summary: "Register an OAuth client dynamically",
    description: "RFC 7591 dynamic client registration for MCP clients. The Den registration policy validates redirect URIs and grant types before the request reaches the authorization server.",
    responses: {
      201: jsonResponse("Client information response (RFC 7591 section 3.2.1).", emptyObjectSchema),
      400: jsonResponse("Client registration error response (RFC 7591 section 3.2.2).", emptyObjectSchema),
    },
  })

  app.get("/api/auth/.well-known/oauth-authorization-server", oauthAuthorizationServerMetadataRoute, publicRoute, (c) => getOAuthAuthorizationServerMetadata(c.req.raw))
  app.get("/api/auth/.well-known/openid-configuration", openIdConfigurationRoute, publicRoute, (c) => getOAuthOpenIdConfiguration(c.req.raw))
  app.get("/.well-known/oauth-authorization-server/api/auth", oauthAuthorizationServerMetadataRoute, publicRoute, (c) => getOAuthAuthorizationServerMetadata(c.req.raw))
  app.get("/.well-known/openid-configuration/api/auth", openIdConfigurationRoute, publicRoute, (c) => getOAuthOpenIdConfiguration(c.req.raw))
  app.get("/.well-known/oauth-authorization-server", oauthAuthorizationServerMetadataRoute, publicRoute, (c) => getOAuthAuthorizationServerMetadata(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/oauth-authorization-server")))
  app.get("/.well-known/openid-configuration", openIdConfigurationRoute, publicRoute, (c) => getOAuthOpenIdConfiguration(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/openid-configuration")))
  app.post("/register", dynamicClientRegistrationRoute, publicRoute, async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.post("/api/auth/oauth2/register", dynamicClientRegistrationRoute, publicRoute, async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.get(
    "/api/auth/oauth2/authorize",
    describeRoute({
      tags: ["OAuth"],
      security: [],
      summary: "Start an OAuth authorization request",
      description: "RFC 6749 authorization endpoint. The Den request policy normalizes the MCP client's request, then the user signs in and consents through the Better Auth authorization server; the browser is redirected back to the client's redirect URI.",
      responses: {
        302: emptyResponse("Redirect to the sign-in flow or to the client's redirect URI with an authorization code or error."),
        400: jsonResponse("The authorization request was malformed or referenced an unknown client.", emptyObjectSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const authRequest = await normalizeMcpOAuthRequest(c.req.raw)
      if (authRequest instanceof Response) {
        return authRequest
      }
      const response = await auth.handler(authRequest)
      return normalizeOAuthAuthorizeRedirect(response)
    },
  )

  app.get(
    "/v1/auth/bootstrap/status",
    describeRoute({
      tags: ["Authentication"],
      security: [],
      summary: "Check initial administrator bootstrap availability",
      description: "Returns whether the private-deployment initial-administrator setup flow is available without exposing configured administrator emails.",
      responses: {
        200: jsonResponse("Bootstrap status returned successfully.", z.object({ status: z.enum(["available", "complete", "unavailable"]) })),
      },
    }),
    publicRoute,
    async (c) => {
      const availability = await getInitialAdminBootstrapAvailability()
      return c.json({ status: availability.status })
    },
  )

  app.post(
    "/v1/auth/bootstrap/verify",
    describeRoute({
      tags: ["Authentication"],
      security: [],
      summary: "Verify an initial administrator setup code",
      description: "Validates a configured administrator email and one-time operator code, then returns a short-lived setup grant for Better Auth account creation.",
      responses: {
        200: jsonResponse("Bootstrap grant issued successfully.", z.object({ grant: z.string(), expiresAt: z.string() })),
        403: jsonResponse("Bootstrap verification failed.", z.object({ error: z.literal("bootstrap_verification_failed"), message: z.string() })),
        409: jsonResponse("Bootstrap is unavailable.", z.object({ error: z.literal("bootstrap_unavailable"), message: z.string() })),
      },
    }),
    publicRoute,
    async (c) => {
      const bodySchema = z.object({ email: z.string().trim().email(), code: z.string().min(1) })
      const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) {
        return c.json({ error: "bootstrap_verification_failed", message: "Setup could not be verified. Check the administrator email and one-time setup code." }, 403)
      }
      const retryAfter = await checkRateLimit(
        initialAdminBootstrapVerifyRateLimitKey(normalizeLoginEmail(parsed.data.email)),
        INITIAL_ADMIN_BOOTSTRAP_VERIFY_RATE_LIMIT_MAX,
        INITIAL_ADMIN_BOOTSTRAP_VERIFY_RATE_LIMIT_WINDOW_MS,
        Date.now(),
      )
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many setup attempts. Try again later." }, 429)
      }
      const result = await verifyInitialAdminBootstrap(parsed.data)
      if (!result.ok) {
        return result.status === 409
          ? c.json({ error: "bootstrap_unavailable", message: result.message }, 409)
          : c.json({ error: "bootstrap_verification_failed", message: result.message }, 403)
      }
      return c.json({ grant: result.grant, expiresAt: result.expiresAt.toISOString() })
    },
  )

  app.get(
    "/v1/auth/login-options",
    describeRoute({
      tags: ["Authentication"],
      security: [],
      summary: "Resolve deterministic login option",
      description: "Returns the deterministic next authentication step for an email address. SSO is preferred before Google, password, GitHub compatibility, and new account creation.",
      responses: {
        200: jsonResponse("Login option resolved successfully.", loginOptionsResponseSchema),
        400: jsonResponse("The login option query parameters were invalid.", z.object({ error: z.literal("invalid_request") })),
        403: jsonResponse("Bot verification failed.", loginOptionsBotVerificationFailedSchema),
        429: jsonResponse("Too many login option attempts.", loginOptionsRateLimitedSchema),
      },
    }),
    publicRoute,
    queryValidator(loginOptionsQuerySchema),
    async (c) => {
      const { email, invite } = c.req.valid("query")
      for (const cookie of buildLoginOptionsSessionCookieClearHeaders(env.betterAuthCookieDomain)) {
        c.header("Set-Cookie", cookie, { append: true })
      }
      const botProtection = await verifyBotProtection()
      if (!botProtection.ok) {
        return c.json({
          error: "bot_verification_failed",
          message: botProtection.message,
        }, botProtection.status)
      }

      const rateLimitKeys = loginOptionsRateLimitKeys(c.req.raw.headers, email)
      const retryAfter = await checkLoginOptionsRateLimit(rateLimitKeys)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({
          error: "rate_limited",
          message: "Too many sign-in option attempts. Try again later.",
        }, 429)
      }

      const singletonSsoStatus = env.orgMode === "single_org" ? await getSingletonSsoStatus() : null
      const singletonSsoRequirement = singletonSsoStatus?.configured
        ? {
            organizationSlug: singletonSsoStatus.organizationSlug,
            signInPath: singletonSsoStatus.signInPath,
          }
        : null
      const requirement = singletonSsoRequirement ?? await findEnterpriseAuthRequirementForEmailDomain(email)
      const accounts = requirement ? [] : await getLoginOptionAccounts(email)
      if (!requirement && accounts.length === 0) {
        const missRetryAfter = await checkLoginOptionsMissRateLimit(rateLimitKeys.domainMiss)
        if (missRetryAfter !== null) {
          c.header("Retry-After", String(missRetryAfter))
          return c.json({
            error: "rate_limited",
            message: "Too many sign-in option attempts. Try again later.",
          }, 429)
        }
      }
      const allowPublicSignup = env.orgMode !== "single_org" || env.singleOrg.allowPublicSignup
      const allowInvitationSignup = !requirement && await hasPendingInvitationForEmail(invite, email)
      const nextStep = resolveLoginOptionKind({ requireSso: Boolean(requirement), accounts, allowNewAccount: allowPublicSignup || allowInvitationSignup })

      if (nextStep === "sso" && requirement) {
        return c.json({
          email,
          nextStep,
          allowPublicSignup,
          allowInvitationSignup,
          organizationSlug: requirement.organizationSlug,
          signInPath: requirement.signInPath,
          signInUrl: new URL(requirement.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
        })
      }

      return c.json({ email, nextStep, allowPublicSignup, allowInvitationSignup })
    },
  )

  app.on(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/api/auth/*",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      security: [],
      summary: "Handle Better Auth flow",
      description: "Proxies Better Auth sign-in, sign-out, session, and verification flows under the Den API auth namespace.",
      responses: {
        200: emptyResponse("Better Auth handled the request successfully."),
        302: emptyResponse("Better Auth redirected the user to continue the auth flow."),
        400: emptyResponse("Better Auth rejected the request as invalid. Password creation, password change, or reset is also rejected when the proposed password fails Den password policy or is known to be compromised."),
        401: emptyResponse("Better Auth rejected the request because authentication failed."),
        429: jsonResponse("Email/password sign-in is temporarily locked after too many failed attempts. The response includes a Retry-After header.", authLoginLockedSchema),
        503: jsonResponse("Password breach screening is temporarily unavailable, so password creation or reset should be retried later.", authPasswordScreeningUnavailableSchema),
      },
    }),
    publicRoute,
    (c) => handleAuthRequest(c),
  )
  registerDesktopAuthRoutes(app)
}
