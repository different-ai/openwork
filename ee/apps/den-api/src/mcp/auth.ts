import { verifyAccessToken } from "better-auth/oauth2"
import {
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_RESOURCE,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_TOKEN_USE_CLAIM,
} from "../auth.js"
import { env } from "../env.js"

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

  let payload: Record<string, unknown>
  try {
    payload = await verifyAccessToken(token, {
      verifyOptions: {
        issuer: env.betterAuthUrl,
        audience: DEN_MCP_RESOURCE,
      },
    }) as Record<string, unknown>
  } catch {
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
