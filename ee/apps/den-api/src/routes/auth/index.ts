import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthUserTable, OAuthClientTable } from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auth, normalizeMcpOAuthResource } from "../../auth.js"
import { normalizeLoginEmail, resolveLoginOptionKind } from "../../auth-login-options.js"
import {
  getBreachedPasswordResponse,
  getEmailPasswordLockoutResponse,
  getShortPasswordResponse,
  readEmailPasswordSignInAttempt,
  recordEmailPasswordSignInResult,
} from "../../auth-protection.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { findEnterpriseAuthRequirementForEmail } from "../../enterprise-auth-requirement.js"
import { getInvalidMcpOAuthRedirectUris, isAllowedMcpOAuthRedirectUri, MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION } from "../../mcp/oauth-client-policy.js"
import { normalizeMcpOAuthClientScope } from "../../mcp/scopes.js"
import { publicRoute, queryValidator, tokenRoute } from "../../middleware/index.js"
import { emptyResponse, jsonResponse } from "../../openapi.js"
import { getSingletonSsoStatus } from "../../orgs.js"
import { getAuthRequestEmail, getSingleOrgEmailSignupPolicyViolation, type SingleOrgEmailSignupPolicyViolation } from "../../single-org-signup-policy.js"
import { samlResponsePolicyMiddleware } from "../../sso-saml-response-middleware.js"
import { revokeBearerSession, type AuthContextVariables } from "../../session.js"
import { registerDesktopAuthRoutes } from "./desktop-handoff.js"
import { normalizeOAuthAuthorizeRedirect } from "./oauth-redirect.js"
import { registerScimAuthRoutes } from "./scim.js"

function rewriteAuthRequest(request: Request, path: string) {
  const url = new URL(request.url)
  url.pathname = path
  return new Request(url, request)
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

function readBasicAuthClientId(headers: Headers) {
  const authorization = headers.get("authorization")?.trim() ?? ""
  const match = authorization.match(/^Basic\s+(.+)$/i)
  if (!match?.[1]) return null

  try {
    const decoded = atob(match[1])
    const separator = decoded.indexOf(":")
    return separator > 0 ? decoded.slice(0, separator) : null
  } catch {
    return null
  }
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
  const result = normalizeMcpOAuthResourceParams(body, true, resourceRequired)
  if (!result.ok) {
    return result.response
  }
  if (!result.changed) {
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

async function getCurrentActiveOrganizationId(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  const activeOrganizationId = session?.session.activeOrganizationId
  return typeof activeOrganizationId === "string" ? activeOrganizationId : null
}

async function getSingleOrgAuthGuardResponse(request: Request) {
  if (env.orgMode !== "single_org") {
    return null
  }

  if (isBetterAuthOrganizationCreationRequest(request)) {
    return singleOrgModeResponse()
  }

  if (isBetterAuthEmailSignupRequest(request)) {
    const violation = await getSingleOrgEmailSignupPolicyViolation(await getAuthRequestEmail(request))
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

  const activeOrganizationId = await getCurrentActiveOrganizationId(request)
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
  organizationSlug: z.string().optional(),
  signInPath: z.string().optional(),
  signInUrl: z.string().url().optional(),
}).meta({ ref: "AuthLoginOptionsResponse" })

async function getLoginOptionAccounts(email: string) {
  const rows = await db
    .select({
      providerId: AuthAccountTable.providerId,
      password: AuthAccountTable.password,
    })
    .from(AuthUserTable)
    .innerJoin(AuthAccountTable, eq(AuthUserTable.id, AuthAccountTable.userId))
    .where(sql`lower(${AuthUserTable.email}) = ${email}`)

  return rows.map((row) => ({
    providerId: row.providerId,
    hasPassword: Boolean(row.password),
  }))
}

async function handleAuthRequest(request: Request) {
  const authRequest = await normalizeMcpOAuthRequest(request)
  if (authRequest instanceof Response) {
    return authRequest
  }
  const singleOrgAuthGuardResponse = await getSingleOrgAuthGuardResponse(authRequest)
  if (singleOrgAuthGuardResponse) {
    return singleOrgAuthGuardResponse
  }

  const emailPasswordAttempt = await readEmailPasswordSignInAttempt(authRequest)
  if (emailPasswordAttempt) {
    const lockoutResponse = await getEmailPasswordLockoutResponse(emailPasswordAttempt)
    if (lockoutResponse) {
      return lockoutResponse
    }
  }

  const shortPasswordResponse = await getShortPasswordResponse(authRequest)
  if (shortPasswordResponse) {
    return shortPasswordResponse
  }

  const breachedPasswordResponse = await getBreachedPasswordResponse(authRequest)
  if (breachedPasswordResponse) {
    return breachedPasswordResponse
  }

  // Desktop sessions use an Authorization bearer and intentionally send no
  // cookies. Better Auth's sign-out endpoint only deletes the cookie-backed
  // session, so explicitly revoke the bearer row first; auth.handler still
  // runs to preserve its normal idempotent response and cookie cleanup for
  // browser callers.
  if (isBetterAuthSignOutRequest(authRequest)) {
    await revokeBearerSession(authRequest.headers)
  }

  const response = await auth.handler(authRequest)
  if (emailPasswordAttempt) {
    await recordEmailPasswordSignInResult(emailPasswordAttempt, response)
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
  app.get("/api/auth/.well-known/oauth-authorization-server", publicRoute, (c) => getOAuthAuthorizationServerMetadata(c.req.raw))
  app.get("/api/auth/.well-known/openid-configuration", publicRoute, (c) => getOAuthOpenIdConfiguration(c.req.raw))
  app.get("/.well-known/oauth-authorization-server/api/auth", publicRoute, (c) => getOAuthAuthorizationServerMetadata(c.req.raw))
  app.get("/.well-known/openid-configuration/api/auth", publicRoute, (c) => getOAuthOpenIdConfiguration(c.req.raw))
  app.get("/.well-known/oauth-authorization-server", publicRoute, (c) => getOAuthAuthorizationServerMetadata(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/oauth-authorization-server")))
  app.get("/.well-known/openid-configuration", publicRoute, (c) => getOAuthOpenIdConfiguration(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/openid-configuration")))
  app.post("/register", publicRoute, async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.post("/api/auth/oauth2/register", publicRoute, async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.get("/api/auth/oauth2/authorize", tokenRoute, async (c) => {
    const authRequest = await normalizeMcpOAuthRequest(c.req.raw)
    if (authRequest instanceof Response) {
      return authRequest
    }
    const response = await auth.handler(authRequest)
    return normalizeOAuthAuthorizeRedirect(response)
  })

  app.get(
    "/v1/auth/login-options",
    describeRoute({
      tags: ["Authentication"],
      summary: "Resolve deterministic login option",
      description: "Returns the deterministic next authentication step for an email address. SSO is preferred before Google, password, GitHub compatibility, and new account creation.",
      responses: {
        200: jsonResponse("Login option resolved successfully.", loginOptionsResponseSchema),
        400: jsonResponse("The login option query parameters were invalid.", z.object({ error: z.literal("invalid_request") })),
      },
    }),
    publicRoute,
    queryValidator(loginOptionsQuerySchema),
    async (c) => {
      const { email } = c.req.valid("query")
      const singletonSsoStatus = env.orgMode === "single_org" ? await getSingletonSsoStatus() : null
      const singletonSsoRequirement = singletonSsoStatus?.configured
        ? {
            organizationSlug: singletonSsoStatus.organizationSlug,
            signInPath: singletonSsoStatus.signInPath,
          }
        : null
      const requirement = singletonSsoRequirement ?? await findEnterpriseAuthRequirementForEmail(email)
      const accounts = requirement ? [] : await getLoginOptionAccounts(email)
      const allowPublicSignup = env.orgMode !== "single_org" || env.singleOrg.allowPublicSignup
      const nextStep = resolveLoginOptionKind({ requireSso: Boolean(requirement), accounts, allowNewAccount: allowPublicSignup })

      if (nextStep === "sso" && requirement) {
        return c.json({
          email,
          nextStep,
          allowPublicSignup,
          organizationSlug: requirement.organizationSlug,
          signInPath: requirement.signInPath,
          signInUrl: new URL(requirement.signInPath, env.betterAuthTrustedOrigins[0] ?? env.betterAuthUrl).toString(),
        })
      }

      return c.json({ email, nextStep, allowPublicSignup })
    },
  )

  app.on(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/api/auth/*",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Handle Better Auth flow",
      description: "Proxies Better Auth sign-in, sign-out, session, and verification flows under the Den API auth namespace.",
      responses: {
        200: emptyResponse("Better Auth handled the request successfully."),
        302: emptyResponse("Better Auth redirected the user to continue the auth flow."),
        400: emptyResponse("Better Auth rejected the request as invalid. Password creation, password change, or reset is also rejected when the proposed password is too short or is known to be compromised."),
        401: emptyResponse("Better Auth rejected the request because authentication failed."),
        429: jsonResponse("Email/password sign-in is temporarily locked after too many failed attempts. The response includes a Retry-After header.", authLoginLockedSchema),
        503: jsonResponse("Password breach screening is temporarily unavailable, so password creation or reset should be retried later.", authPasswordScreeningUnavailableSchema),
      },
    }),
    publicRoute,
    (c) => handleAuthRequest(c.req.raw),
  )
  registerDesktopAuthRoutes(app)
}
