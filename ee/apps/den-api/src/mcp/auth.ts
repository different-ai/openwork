import * as crypto from "node:crypto"
import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, MemberTable, OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { verifyJwsAccessToken } from "better-auth/oauth2"
import {
  auth,
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_RESOURCE,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_RESOURCES,
  DEN_MCP_TOKEN_USE_CLAIM,
} from "../auth.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { DEN_JWT_SIGNING_ALGORITHM, getDenAuthIssuer } from "./jwt-policy.js"

export type McpPrincipal = {
  userId: string
  organizationId: string
  scopes: Set<string>
  payload: Record<string, unknown>
}

type McpJwtVerifyOptions = Parameters<typeof verifyJwsAccessToken>[1]["verifyOptions"]

const MCP_JWT_SIGNING_ALGORITHMS = [DEN_JWT_SIGNING_ALGORITHM]

export function getMcpResourceUrl(request: Request) {
  const url = new URL(request.url)
  const requestResource = `${url.origin}/mcp`
  return DEN_MCP_RESOURCES.includes(requestResource) ? requestResource : DEN_MCP_RESOURCE
}

export function getMcpJwtVerifyOptions(): McpJwtVerifyOptions {
  return {
    issuer: getDenAuthIssuer(env.betterAuthUrl),
    audience: DEN_MCP_RESOURCES,
    algorithms: MCP_JWT_SIGNING_ALGORITHMS,
  }
}

function readBearerToken(headers: Headers) {
  const authorization = headers.get("authorization")?.trim() ?? ""
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

/**
 * Hash an opaque MCP token secret (the part after the `ow_mcp_at_` prefix)
 * for storage/lookup. Shared with the first-party mint route so the formats
 * cannot drift.
 */
export function hashOpaqueMcpSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("base64url")
}

function readStoredScopes(scopes: string) {
  try {
    const parsed = JSON.parse(scopes) as unknown
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string")
  } catch {
    // Older rows or custom stores may keep scopes as a space-delimited string.
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

function readStringClaim(payload: Record<string, unknown>, claim: string) {
  const value = payload[claim]
  return typeof value === "string" && value.trim() ? value.trim() : null
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

  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.userId, principal.userId),
      eq(MemberTable.organizationId, principal.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)

  return rows.length > 0
}

export async function hasActiveMcpSession(sessionId: string) {
  try {
    const normalizedSessionId = normalizeDenTypeId("session", sessionId)

    const rows = await db
      .select({ id: AuthSessionTable.id })
      .from(AuthSessionTable)
      .where(and(
        eq(AuthSessionTable.id, normalizedSessionId),
        gt(AuthSessionTable.expiresAt, new Date()),
      ))
      .limit(1)

    return rows.length > 0
  } catch {
    return false
  }
}

async function getJwks() {
  const response = await auth.handler(new Request(`${env.betterAuthUrl}/api/auth/jwks`))
  if (!response.ok) {
    throw new Error("Unable to load auth JWKS")
  }
  return response.json()
}

async function verifyJwtMcpToken(token: string) {
  const payload = await verifyJwsAccessToken(token, {
    jwksFetch: getJwks,
    verifyOptions: getMcpJwtVerifyOptions(),
  })
  return payload as Record<string, unknown>
}

async function verifyOpaqueMcpToken(token: string) {
  if (!token.startsWith(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX)) {
    return null
  }

  const storedToken = hashOpaqueMcpSecret(token.slice(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX.length))
  const [accessToken] = await db
    .select()
    .from(OAuthAccessTokenTable)
    .where(eq(OAuthAccessTokenTable.token, storedToken))
    .limit(1)

  if (!accessToken || accessToken.expiresAt <= new Date()) {
    return null
  }

  const storedScopes = readStoredScopes(accessToken.scopes)
  return {
    sub: accessToken.userId,
    scope: storedScopes.join(" "),
    client_id: accessToken.clientId,
    exp: Math.floor(accessToken.expiresAt.getTime() / 1000),
    iat: Math.floor(accessToken.createdAt.getTime() / 1000),
    [DEN_MCP_TOKEN_USE_CLAIM]: "mcp",
    [DEN_MCP_RESOURCE_CLAIM]: DEN_MCP_RESOURCE,
    ...(accessToken.sessionId ? { sid: accessToken.sessionId } : {}),
    ...(accessToken.referenceId ? { [DEN_MCP_ORG_ID_CLAIM]: accessToken.referenceId } : {}),
  }
}

export async function verifyMcpRequest(headers: Headers, resourceUrl = DEN_MCP_RESOURCE): Promise<McpPrincipal | Response> {
  const token = readBearerToken(headers)
  if (!token) {
    return new Response(JSON.stringify({ error: "missing_mcp_token" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource"`,
      },
    })
  }

  const payload = token.includes(".")
    ? await verifyJwtMcpToken(token).catch(() => null)
    : await verifyOpaqueMcpToken(token)
  if (!payload) {
    return new Response(JSON.stringify({ error: "invalid_mcp_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }

  const scopes = readScopes(payload)
  if (!scopes.has("mcp:read") && !scopes.has("mcp:write")) {
    return new Response(JSON.stringify({ error: "insufficient_mcp_scope" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  if (readStringClaim(payload, DEN_MCP_TOKEN_USE_CLAIM) !== "mcp") {
    return new Response(JSON.stringify({ error: "wrong_token_use" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  const resource = readStringClaim(payload, DEN_MCP_RESOURCE_CLAIM)
  if (resource && !DEN_MCP_RESOURCES.includes(resource)) {
    return new Response(JSON.stringify({ error: "wrong_mcp_resource" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null
  const organizationId = readStringClaim(payload, DEN_MCP_ORG_ID_CLAIM)
  if (!userId || !organizationId) {
    return new Response(JSON.stringify({ error: "missing_mcp_principal" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  const sessionId = readStringClaim(payload, "sid")
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "mcp_session_required" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  if (!(await hasActiveMcpSession(sessionId))) {
    return new Response(JSON.stringify({ error: "mcp_session_revoked" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  if (!(await hasActiveMcpMembership({ userId, organizationId }))) {
    return new Response(JSON.stringify({ error: "mcp_membership_revoked" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  return { userId, organizationId, scopes, payload }
}
