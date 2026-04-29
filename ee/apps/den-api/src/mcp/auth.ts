import * as crypto from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import {
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_RESOURCE,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_TOKEN_USE_CLAIM,
} from "../auth.js"
import { db } from "../db.js"

export type McpPrincipal = {
  userId: string
  organizationId: string
  scopes: Set<string>
  payload: Record<string, unknown>
}

function readBearerToken(headers: Headers) {
  const authorization = headers.get("authorization")?.trim() ?? ""
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function hashStoredToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url")
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

export async function verifyMcpRequest(headers: Headers): Promise<McpPrincipal | Response> {
  const token = readBearerToken(headers)
  if (!token) {
    return new Response(JSON.stringify({ error: "missing_mcp_token" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${DEN_MCP_RESOURCE}/.well-known/oauth-protected-resource"`,
      },
    })
  }

  if (!token.startsWith(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX)) {
    return new Response(JSON.stringify({ error: "invalid_mcp_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }

  const storedToken = hashStoredToken(token.slice(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX.length))
  const [accessToken] = await db
    .select()
    .from(OAuthAccessTokenTable)
    .where(eq(OAuthAccessTokenTable.token, storedToken))
    .limit(1)

  if (!accessToken || accessToken.expiresAt <= new Date()) {
    return new Response(JSON.stringify({ error: "invalid_mcp_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }

  const storedScopes = readStoredScopes(accessToken.scopes)
  const payload: Record<string, unknown> = {
    sub: accessToken.userId,
    scope: storedScopes.join(" "),
    client_id: accessToken.clientId,
    exp: Math.floor(accessToken.expiresAt.getTime() / 1000),
    iat: Math.floor(accessToken.createdAt.getTime() / 1000),
    [DEN_MCP_TOKEN_USE_CLAIM]: "mcp",
    [DEN_MCP_RESOURCE_CLAIM]: DEN_MCP_RESOURCE,
    ...(accessToken.referenceId ? { [DEN_MCP_ORG_ID_CLAIM]: accessToken.referenceId } : {}),
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
  if (resource && resource !== DEN_MCP_RESOURCE) {
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

  return { userId, organizationId, scopes, payload }
}
