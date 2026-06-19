import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { auth } from "../../auth.js"
import {
  getBreachedPasswordResponse,
  getEmailPasswordLockoutResponse,
  readEmailPasswordSignInAttempt,
  recordEmailPasswordSignInResult,
} from "../../auth-protection.js"
import { env } from "../../env.js"
import { getInvalidMcpOAuthRedirectUris } from "../../mcp/oauth-client-policy.js"
import { normalizeMcpOAuthClientScope } from "../../mcp/scopes.js"
import { publicRoute, tokenRoute } from "../../middleware/index.js"
import { emptyResponse, jsonResponse } from "../../openapi.js"
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
      "MCP OAuth redirect URIs must use loopback HTTP(S) or a private-use custom scheme.",
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
  return new URL(request.url).origin
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
  const emailPasswordAttempt = await readEmailPasswordSignInAttempt(request)
  if (emailPasswordAttempt) {
    const lockoutResponse = await getEmailPasswordLockoutResponse(emailPasswordAttempt)
    if (lockoutResponse) {
      return lockoutResponse
    }
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
        400: emptyResponse("Better Auth rejected the request as invalid. Password creation, password change, or reset is also rejected when the proposed password is known to be compromised."),
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
