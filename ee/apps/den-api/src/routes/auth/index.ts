import { eq } from "@openwork-ee/den-db/drizzle"
import { OAuthClientTable } from "@openwork-ee/den-db/schema"
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { auth } from "../../auth.js"
import {
  getBreachedPasswordResponse,
  getEmailPasswordLockoutResponse,
  readEmailPasswordSignInAttempt,
  recordEmailPasswordSignInResult,
} from "../../auth-protection.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { getInvalidMcpOAuthRedirectUris } from "../../mcp/oauth-client-policy.js"
import { emptyResponse } from "../../openapi.js"
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

  const scope = typeof body.scope === "string" ? body.scope : ""
  const scopes = new Set(scope.split(/\s+/).filter(Boolean))
  if (scopes.has("mcp:read") || scopes.has("mcp:write")) {
    scopes.add("mcp:read")
    scopes.add("mcp:write")
    body.scope = Array.from(scopes).join(" ")
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

function readStoredClientScopes(scopes: string | null) {
  if (!scopes) {
    return []
  }

  try {
    const parsed = JSON.parse(scopes) as unknown
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string")
  } catch {}

  return scopes.split(/\s+/).filter(Boolean)
}

async function ensureMcpClientScopes(request: Request) {
  const url = new URL(request.url)
  const requestedScopes = new Set((url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean))
  if (!requestedScopes.has("mcp:read") && !requestedScopes.has("mcp:write")) {
    return
  }

  const clientId = url.searchParams.get("client_id")
  if (!clientId) {
    return
  }

  const [client] = await db
    .select({ scopes: OAuthClientTable.scopes })
    .from(OAuthClientTable)
    .where(eq(OAuthClientTable.clientId, clientId))
    .limit(1)
  if (!client) {
    return
  }

  const scopes = new Set(readStoredClientScopes(client.scopes))
  const hasMcpRead = scopes.has("mcp:read")
  const hasMcpWrite = scopes.has("mcp:write")
  if (!hasMcpRead && !hasMcpWrite) {
    return
  }
  if (hasMcpRead && hasMcpWrite) {
    return
  }

  scopes.add("mcp:read")
  scopes.add("mcp:write")
  await db
    .update(OAuthClientTable)
    .set({ scopes: JSON.stringify(Array.from(scopes)) })
    .where(eq(OAuthClientTable.clientId, clientId))
}

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
  app.get("/api/auth/.well-known/oauth-authorization-server", async (c) => rewriteMetadataOrigin(await oauthProviderAuthServerMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/api/auth/.well-known/openid-configuration", async (c) => rewriteMetadataOrigin(await oauthProviderOpenIdConfigMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/.well-known/oauth-authorization-server/api/auth", async (c) => rewriteMetadataOrigin(await oauthProviderAuthServerMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/.well-known/openid-configuration/api/auth", async (c) => rewriteMetadataOrigin(await oauthProviderOpenIdConfigMetadata(auth)(c.req.raw), requestOrigin(c.req.raw)))
  app.get("/.well-known/oauth-authorization-server", async (c) => rewriteMetadataOrigin(await oauthProviderAuthServerMetadata(auth)(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/oauth-authorization-server")), requestOrigin(c.req.raw)))
  app.get("/.well-known/openid-configuration", async (c) => rewriteMetadataOrigin(await oauthProviderOpenIdConfigMetadata(auth)(rewriteAuthRequest(c.req.raw, "/api/auth/.well-known/openid-configuration")), requestOrigin(c.req.raw)))
  app.post("/register", async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.post("/api/auth/oauth2/register", async (c) => handleMcpClientRegistrationRequest(c.req.raw, "/api/auth/oauth2/register"))
  app.get("/api/auth/oauth2/authorize", async (c) => {
    await ensureMcpClientScopes(c.req.raw)
    return auth.handler(c.req.raw)
  })

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
        400: emptyResponse("Better Auth rejected the request as invalid."),
        401: emptyResponse("Better Auth rejected the request because authentication failed."),
      },
    }),
    (c) => handleAuthRequest(c.req.raw),
  )
  registerDesktopAuthRoutes(app)
}
