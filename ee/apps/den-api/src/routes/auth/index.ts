import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auth } from "../../auth.js"
import {
  getBreachedPasswordResponse,
  getEmailPasswordLockoutResponse,
  getShortPasswordResponse,
  readEmailPasswordSignInAttempt,
  recordEmailPasswordSignInResult,
} from "../../auth-protection.js"
import { env } from "../../env.js"
import { getInvalidMcpOAuthRedirectUris } from "../../mcp/oauth-client-policy.js"
import { normalizeMcpOAuthClientScope } from "../../mcp/scopes.js"
import { publicRoute, tokenRoute } from "../../middleware/index.js"
import { emptyResponse, jsonResponse } from "../../openapi.js"
import { getSingletonSsoStatus } from "../../orgs.js"
import { publicRequestUrl } from "../../request-url.js"
import { samlResponsePolicyMiddleware } from "../../sso-saml-response-middleware.js"
import type { AuthContextVariables } from "../../session.js"
import { registerDesktopAuthRoutes } from "./desktop-handoff.js"
import { registerScimAuthRoutes } from "./scim.js"

function rewriteAuthRequest(request: Request, path: string) {
  const url = new URL(request.url)
  url.pathname = path
  return new Request(url, request)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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
      "MCP OAuth redirect URIs must use HTTPS, loopback HTTP, or a custom app scheme.",
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

async function rewriteMetadataOrigin(response: Response, origin: string) {
  const metadata = await response.json() as Record<string, unknown>
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set("content-type", "application/json")

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      metadata[key] = value.replace(env.betterAuthUrl, origin)
    }
  }

  return new Response(JSON.stringify(metadata), {
    status: response.status,
    headers,
  })
}

function requestOrigin(request: Request) {
  return publicRequestUrl(request).origin
}

const authLoginLockedSchema = z.object({
  error: z.literal("login_locked"),
  message: z.string(),
}).meta({ ref: "AuthLoginLockedError" })

const authPasswordScreeningUnavailableSchema = z.object({
  error: z.literal("password_screening_unavailable"),
  message: z.string(),
}).meta({ ref: "AuthPasswordScreeningUnavailableError" })

async function handleAuthRequest(request: Request) {
  const singleOrgAuthGuardResponse = await getSingleOrgAuthGuardResponse(request)
  if (singleOrgAuthGuardResponse) {
    return singleOrgAuthGuardResponse
  }

  const emailPasswordAttempt = await readEmailPasswordSignInAttempt(request)
  if (emailPasswordAttempt) {
    const lockoutResponse = await getEmailPasswordLockoutResponse(emailPasswordAttempt)
    if (lockoutResponse) {
      return lockoutResponse
    }
  }

  const shortPasswordResponse = await getShortPasswordResponse(request)
  if (shortPasswordResponse) {
    return shortPasswordResponse
  }

  const breachedPasswordResponse = await getBreachedPasswordResponse(request)
  if (breachedPasswordResponse) {
    return breachedPasswordResponse
  }

  const response = await auth.handler(request)
  if (emailPasswordAttempt) {
    await recordEmailPasswordSignInResult(emailPasswordAttempt, response)
  }
  return response
}

export function registerAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  registerScimAuthRoutes(app)
  app.use("/api/auth/sso/saml2/callback/*", samlResponsePolicyMiddleware)
  app.use("/api/auth/sso/saml2/sp/acs/*", samlResponsePolicyMiddleware)
  app.get("/api/auth/.well-known/oauth-authorization-server", publicRoute, async (c) => rewriteMetadataOrigin(await oauthProviderAuthServerMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/api/auth/.well-known/openid-configuration", publicRoute, async (c) => rewriteMetadataOrigin(await oauthProviderOpenIdConfigMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/.well-known/oauth-authorization-server/api/auth", publicRoute, async (c) => rewriteMetadataOrigin(await oauthProviderAuthServerMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/.well-known/openid-configuration/api/auth", publicRoute, async (c) => rewriteMetadataOrigin(await oauthProviderOpenIdConfigMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/.well-known/oauth-authorization-server", publicRoute, async (c) => rewriteMetadataOrigin(await oauthProviderAuthServerMetadata(auth)(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/oauth-authorization-server")), requestOrigin(c.req.raw)))
  app.get("/.well-known/openid-configuration", publicRoute, async (c) => rewriteMetadataOrigin(await oauthProviderOpenIdConfigMetadata(auth)(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/openid-configuration")), requestOrigin(c.req.raw)))
  app.post("/register", publicRoute, async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.post("/api/auth/oauth2/register", publicRoute, async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.get("/api/auth/oauth2/authorize", tokenRoute, (c) => auth.handler(c.req.raw))

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
