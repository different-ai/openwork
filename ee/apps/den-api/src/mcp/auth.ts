import * as crypto from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { verifyJwsAccessToken } from "better-auth/oauth2"
import {
  auth,
  DEN_MCP_FIRST_PARTY_CLIENT_ID,
  DEN_MCP_FIRST_PARTY_RESOURCES,
  DEN_MCP_GRANT_ID_CLAIM,
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_OAUTH_RESOURCE,
  DEN_MCP_RESOURCE,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_TOKEN_USE_CLAIM,
} from "../auth.js"
import { cache } from "../cache.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { publicRequestUrl } from "../request-url.js"
import { DEN_JWT_SIGNING_ALGORITHM, getDenAuthIssuer } from "./jwt-policy.js"
import { mcpProtectedResourceMetadataUrl, mcpRouteResource, resolveMcpResourceFromRequest, type McpResourceRoute } from "./resource.js"
import { DEN_MCP_REQUESTED_SCOPE } from "./scopes.js"
import { getMcpGrantLiveness } from "./grant-liveness.js"
import { getMcpSessionLiveness } from "./session-liveness.js"
import { DEN_MCP_HEADLESS_RUN_CLIENT_ID, DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM, isHeadlessRunMcpToken } from "./headless-run-token.js"
import { personalAgentChatTurnId } from "./workbot-turn-limits.js"
export { hasActiveMcpSession } from "./session-liveness.js"

export type McpPrincipal = {
  userId: string
  organizationId: string
  scopes: Set<string>
  payload: Record<string, unknown>
}

type McpJwtVerifyOptions = Parameters<typeof verifyJwsAccessToken>[1]["verifyOptions"]
type McpTokenSource = "jwt" | "opaque"

type VerifiedMcpToken = {
  payload: Record<string, unknown>
  source: McpTokenSource
}

export type McpAuthResourceContext = {
  route: McpResourceRoute
  resourceUrl: string
  metadataUrl: string
  oauthResources: readonly string[]
  firstPartyResources: readonly string[]
  requestId?: string
  agentChatOnly?: boolean
}

const MCP_JWT_SIGNING_ALGORITHMS = [DEN_JWT_SIGNING_ALGORITHM]

export function getMcpResourceUrl(request: Request) {
  return resolveMcpResourceFromRequest(publicRequestUrl(request).toString(), DEN_MCP_FIRST_PARTY_RESOURCES, DEN_MCP_RESOURCE)
}

export function getMcpResourceContext(request: Request, route: McpResourceRoute, requestId?: string): McpAuthResourceContext {
  const parentResource = getMcpResourceUrl(request)
  const resourceUrl = mcpRouteResource({
    route,
    parentResource,
    agentResource: DEN_MCP_OAUTH_RESOURCE,
  })
  return {
    route,
    resourceUrl,
    metadataUrl: mcpProtectedResourceMetadataUrl(resourceUrl),
    oauthResources: route === "agent" ? [DEN_MCP_OAUTH_RESOURCE] : [],
    firstPartyResources: DEN_MCP_FIRST_PARTY_RESOURCES,
    requestId,
  }
}

export function getMcpJwtVerifyOptions(): McpJwtVerifyOptions {
  return {
    issuer: getDenAuthIssuer(env.betterAuthUrl),
    audience: DEN_MCP_OAUTH_RESOURCE,
    algorithms: MCP_JWT_SIGNING_ALGORITHMS,
  }
}

export function readBearerToken(headers: Headers) {
  const authorization = headers.get("authorization")?.trim() ?? ""
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function hashOpaqueMcpSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("base64url")
}

function readStoredScopes(scopes: string) {
  try {
    const parsed = JSON.parse(scopes) as unknown
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string")
  } catch {
  }
  return scopes.split(/\s+/).filter(Boolean)
}

function readScopes(payload: Record<string, unknown>) {
  const scope = typeof payload.scope === "string" ? payload.scope : ""
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : []
  return new Set([
    ...scope.split(/\s+/).filter(Boolean),
    ...scopes.filter((entry: unknown): entry is string => typeof entry === "string"),
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readStringClaim(payload: Record<string, unknown>, claim: string) {
  const value = payload[claim]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function mcpPrincipalCredentialId(principal: McpPrincipal): string | null {
  const payload = principal.payload
  const grantId = readStringClaim(payload, DEN_MCP_GRANT_ID_CLAIM)
  if (grantId) return `grant:${grantId}`
  const runTokenId = payload.client_id === DEN_MCP_HEADLESS_RUN_CLIENT_ID ? readStringClaim(payload, DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM) : null
  if (runTokenId) return `run_token:${runTokenId}`
  const clientId = readStringClaim(payload, "client_id") ?? readStringClaim(payload, "azp")
  return clientId ? `client:${clientId}` : null
}

function readTokenAudiences(payload: Record<string, unknown>) {
  const audience = payload.aud
  if (typeof audience === "string" && audience.trim()) return [audience.trim()]
  if (Array.isArray(audience)) {
    return audience
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
  }
  return []
}

function hasAcceptedMcpOauthAudience(payload: Record<string, unknown>) {
  const audiences = readTokenAudiences(payload)
  const userInfoAudience = `${getDenAuthIssuer(env.betterAuthUrl)}/oauth2/userinfo`
  return audiences.includes(DEN_MCP_OAUTH_RESOURCE)
    && audiences.every((audience) => audience === DEN_MCP_OAUTH_RESOURCE || audience === userInfoAudience)
}

function hasMatchingMcpResourceClaim(payload: Record<string, unknown>) {
  const resource = readStringClaim(payload, DEN_MCP_RESOURCE_CLAIM)
  return !resource || resource === DEN_MCP_OAUTH_RESOURCE
}

function readTokenResource(payload: Record<string, unknown>, source: McpTokenSource) {
  if (source === "jwt") {
    return hasAcceptedMcpOauthAudience(payload) && hasMatchingMcpResourceClaim(payload) ? DEN_MCP_OAUTH_RESOURCE : null
  }

  const resource = readStringClaim(payload, DEN_MCP_RESOURCE_CLAIM)
  if (resource) return resource

  const audience = payload.aud
  if (typeof audience === "string" && audience.trim()) return audience.trim()
  if (Array.isArray(audience)) {
    const stringAudiences = audience.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    if (stringAudiences.length === 1) return stringAudiences[0].trim()
  }
  return null
}

const FIRST_PARTY_OPAQUE_CLIENT_IDS: ReadonlySet<string> = new Set([DEN_MCP_FIRST_PARTY_CLIENT_ID, DEN_MCP_HEADLESS_RUN_CLIENT_ID])

function isFirstPartyMcpToken(payload: Record<string, unknown>, source: McpTokenSource) {
  if (source !== "opaque") {
    return false
  }

  const clientId = readStringClaim(payload, "client_id")
  return clientId !== null && FIRST_PARTY_OPAQUE_CLIENT_IDS.has(clientId)
}

export function isFirstPartyMcpPrincipal(principal: McpPrincipal): boolean {
  const clientId = readStringClaim(principal.payload, "client_id")
  return clientId !== null && FIRST_PARTY_OPAQUE_CLIENT_IDS.has(clientId)
}


function bearerChallenge(input: {
  metadataUrl: string
  error?: "invalid_token" | "insufficient_scope"
  message?: string
}) {
  const params = [
    input.error ? `error="${input.error}"` : null,
    input.message ? `error_description="${input.message.replace(/"/g, "'")}"` : null,
    `resource_metadata="${input.metadataUrl}"`,
    `scope="${DEN_MCP_REQUESTED_SCOPE}"`,
  ].filter((entry): entry is string => typeof entry === "string")
  return `Bearer ${params.join(", ")}`
}

function mcpJsonResponse(
  status: number,
  body: { error: string; message: string; referenceId: string; oauthError?: "invalid_token" | "insufficient_scope"; scope?: string },
  challenge?: string,
  extraHeaders?: HeadersInit,
) {
  const headers = new Headers(extraHeaders)
  headers.set("content-type", "application/json")
  if (challenge) headers.set("www-authenticate", challenge)
  return new Response(JSON.stringify(body), { status, headers })
}

function verifyOptions(input: string | McpAuthResourceContext | undefined): McpAuthResourceContext {
  if (typeof input === "string") {
    const route = input === DEN_MCP_OAUTH_RESOURCE ? "agent" : "mcp"
    return {
      route,
      resourceUrl: input,
      metadataUrl: mcpProtectedResourceMetadataUrl(input),
      oauthResources: route === "agent" ? [DEN_MCP_OAUTH_RESOURCE] : [],
      firstPartyResources: DEN_MCP_FIRST_PARTY_RESOURCES,
    }
  }
  return input ?? {
    route: "mcp",
    resourceUrl: DEN_MCP_RESOURCE,
    metadataUrl: mcpProtectedResourceMetadataUrl(DEN_MCP_RESOURCE),
    oauthResources: [],
    firstPartyResources: DEN_MCP_FIRST_PARTY_RESOURCES,
  }
}

function allowedResourcesForPayload(payload: Record<string, unknown>, source: McpTokenSource, options: McpAuthResourceContext) {
  return isFirstPartyMcpToken(payload, source) ? options.firstPartyResources : options.oauthResources
}

function hasAcceptedResource(payload: Record<string, unknown>, source: McpTokenSource, options: McpAuthResourceContext) {
  const resource = readTokenResource(payload, source)
  if (!resource) {
    return false
  }

  if (source === "jwt" && options.route !== "agent") {
    return false
  }

  if (source === "opaque" && !isFirstPartyMcpToken(payload, source)) {
    return false
  }

  return allowedResourcesForPayload(payload, source, options).includes(resource)
}

function normalizeMcpPrincipal(input: { userId: string; organizationId: string }) {
  try {
    return {
      userId: normalizeDenTypeId("user", input.userId),
      organizationId: normalizeDenTypeId("organization", input.organizationId),
    }
  } catch {
    return null
  }
}

export async function hasActiveMcpMembership(input: { userId: string; organizationId: string }) {
  const principal = normalizeMcpPrincipal(input)
  if (!principal) {
    return false
  }

  return await cache.org.membership(principal) !== null
}

class McpSigningKeysUnavailable extends Error {}

async function getJwks() {
  try {
    return await auth.api.getJwks()
  } catch (cause) {
    throw new McpSigningKeysUnavailable("Unable to load auth JWKS", { cause })
  }
}

const MCP_JWKS_CACHE_KEY = {}

async function verifyJwtMcpToken(token: string) {
  const payload: unknown = await verifyJwsAccessToken(token, {
    jwksFetch: getJwks,
    jwksCacheKey: MCP_JWKS_CACHE_KEY,
    verifyOptions: getMcpJwtVerifyOptions(),
  })
  return isRecord(payload) ? payload : null
}

async function verifyOpaqueMcpToken(token: string) {
  if (!token.startsWith(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX)) {
    return null
  }

  const storedToken = hashOpaqueMcpSecret(token.slice(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX.length))
  const lookup = (database: typeof db.$primary) => database
    .select()
    .from(OAuthAccessTokenTable)
    .where(eq(OAuthAccessTokenTable.token, storedToken))
    .limit(1)
  const fromReplica = await lookup(db)
  const [accessToken] = fromReplica[0] ? fromReplica : await lookup(db.$primary)

  if (!accessToken || accessToken.expiresAt <= new Date()) {
    return null
  }

  const storedScopes = readStoredScopes(accessToken.scopes)
  const resource = FIRST_PARTY_OPAQUE_CLIENT_IDS.has(accessToken.clientId) ? DEN_MCP_RESOURCE : DEN_MCP_OAUTH_RESOURCE
  return {
    sub: accessToken.userId,
    scope: storedScopes.join(" "),
    client_id: accessToken.clientId,
    exp: Math.floor(accessToken.expiresAt.getTime() / 1000),
    iat: Math.floor(accessToken.createdAt.getTime() / 1000),
    [DEN_MCP_TOKEN_USE_CLAIM]: "mcp",
    [DEN_MCP_RESOURCE_CLAIM]: resource,
    ...(accessToken.sessionId ? { sid: accessToken.sessionId } : {}),
    ...(accessToken.referenceId ? { [DEN_MCP_ORG_ID_CLAIM]: accessToken.referenceId } : {}),
    ...(accessToken.clientId === DEN_MCP_HEADLESS_RUN_CLIENT_ID ? { [DEN_MCP_HEADLESS_RUN_TOKEN_ID_CLAIM]: accessToken.id } : {}),
  }
}

export async function verifyMcpRequest(headers: Headers, optionsInput?: string | McpAuthResourceContext): Promise<McpPrincipal | Response> {
  const options = verifyOptions(optionsInput)
  const referenceId = options.requestId ?? "unknown"
  const token = readBearerToken(headers)
  if (!token) {
    return mcpJsonResponse(401, {
      error: "missing_mcp_token",
      message: "Provide a Bearer token with MCP scope to access this resource.",
      referenceId,
    }, bearerChallenge({ metadataUrl: options.metadataUrl }))
  }

  let verifiedToken: VerifiedMcpToken | null
  if (token.includes(".")) {
    try {
      const payload = await verifyJwtMcpToken(token)
      verifiedToken = payload ? { payload, source: "jwt" } : null
    } catch (error) {
      if (error instanceof McpSigningKeysUnavailable) {
        return mcpJsonResponse(503, {
          error: "mcp_signing_keys_unavailable",
          message: "OpenWork could not verify the token signing key. Retry shortly.",
          referenceId,
        }, undefined, { "retry-after": "10" })
      }
      verifiedToken = null
    }
  } else {
    const payload = await verifyOpaqueMcpToken(token)
    verifiedToken = payload ? { payload, source: "opaque" } : null
  }
  if (!verifiedToken) {
    const message = "The MCP bearer token is invalid or expired."
    return mcpJsonResponse(401, {
      error: "invalid_mcp_token",
      oauthError: "invalid_token",
      message,
      referenceId,
    }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
  }
  const { payload, source } = verifiedToken

  const scopes = readScopes(payload)
  if (!scopes.has("mcp:read") && !scopes.has("mcp:write")) {
    const message = "The MCP bearer token is missing required MCP scopes."
    return mcpJsonResponse(403, {
      error: "insufficient_mcp_scope",
      oauthError: "insufficient_scope",
      message,
      referenceId,
      scope: DEN_MCP_REQUESTED_SCOPE,
    }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "insufficient_scope", message }))
  }

  if (readStringClaim(payload, DEN_MCP_TOKEN_USE_CLAIM) !== "mcp") {
    const message = "The bearer token is not an MCP access token."
    return mcpJsonResponse(401, {
      error: "wrong_token_use",
      oauthError: "invalid_token",
      message,
      referenceId,
    }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
  }

  const agentChat = personalAgentChatTurnId(scopes) !== undefined
  if (agentChat !== (options.agentChatOnly === true) || (agentChat && !isHeadlessRunMcpToken(payload, source))) {
    return mcpJsonResponse(403, { error: "wrong_mcp_resource", message: "This credential is not valid for this MCP endpoint.", referenceId })
  }

  if (!hasAcceptedResource(payload, source, options)) {
    const message = "The MCP bearer token was issued for a different resource."
    return mcpJsonResponse(401, {
      error: "wrong_mcp_resource",
      oauthError: "invalid_token",
      message,
      referenceId,
    }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null
  const organizationId = readStringClaim(payload, DEN_MCP_ORG_ID_CLAIM)
  if (!userId || !organizationId) {
    const message = "The MCP bearer token is missing its user or organization principal."
    return mcpJsonResponse(401, {
      error: "missing_mcp_principal",
      oauthError: "invalid_token",
      message,
      referenceId,
    }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
  }

  const grantId = readStringClaim(payload, DEN_MCP_GRANT_ID_CLAIM)
  if (grantId) {
    const grantLiveness = await getMcpGrantLiveness(grantId)
    if (grantLiveness === "check_failed") {
      return mcpJsonResponse(503, {
        error: "mcp_grant_check_unavailable",
        message: "OpenWork could not verify the token grant. Retry shortly.",
        referenceId,
      }, undefined, { "retry-after": "10" })
    }

    if (grantLiveness === "missing") {
      const message = "The MCP bearer token grant is missing or revoked."
      return mcpJsonResponse(401, {
        error: "mcp_grant_revoked",
        oauthError: "invalid_token",
        message,
        referenceId,
      }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
    }
  } else if (!isHeadlessRunMcpToken(payload, source)) {
    const sessionId = readStringClaim(payload, "sid")
    if (!sessionId) {
      const message = "The MCP bearer token is not tied to an active session."
      return mcpJsonResponse(401, {
        error: "mcp_session_required",
        oauthError: "invalid_token",
        message,
        referenceId,
      }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
    }

    const sessionLiveness = await getMcpSessionLiveness(sessionId)
    if (sessionLiveness === "check_failed") {
      return mcpJsonResponse(503, {
        error: "mcp_session_check_unavailable",
        message: "OpenWork could not verify the token session. Retry shortly.",
        referenceId,
      }, undefined, { "retry-after": "10" })
    }

    if (sessionLiveness === "missing") {
      const message = "The MCP bearer token session is missing, expired, or revoked."
      return mcpJsonResponse(401, {
        error: "mcp_session_revoked",
        oauthError: "invalid_token",
        message,
        referenceId,
      }, bearerChallenge({ metadataUrl: options.metadataUrl, error: "invalid_token", message }))
    }
  }

  if (!(await hasActiveMcpMembership({ userId, organizationId }))) {
    return mcpJsonResponse(403, {
      error: "mcp_membership_revoked",
      message: "The MCP bearer token's organization membership is no longer active.",
      referenceId,
    })
  }

  return { userId, organizationId, scopes, payload }
}
