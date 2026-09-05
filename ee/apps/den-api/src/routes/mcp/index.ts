import * as crypto from "node:crypto"
import { OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { DEN_MCP_FIRST_PARTY_CLIENT_ID, DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX, DEN_MCP_RESOURCE } from "../../auth.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { hashOpaqueMcpSecret } from "../../mcp/auth.js"
import { deriveFirstPartyMcpTokenResourceFromRequest } from "../../mcp/resource.js"
import { DEN_MCP_APP_HOST_SCOPE, resolveMcpTokenScopes } from "../../mcp/scopes.js"
import { DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS } from "../../mcp/token-lifetime.js"
import {
  jsonValidator,
  orgMemberRoute,
  userSessionRoute,
  type OrganizationContextVariables,
} from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

/**
 * First-party MCP token exchange.
 *
 * A signed-in Den session can mint an org-scoped opaque MCP access token
 * without the browser OAuth dance. This is not a privilege escalation: the
 * caller already holds a full session token for the same user, which can do
 * strictly more than the resulting `mcp:*`-scoped token. The org is the
 * session's active organization, validated for membership and API-key scope by
 * `resolveOrganizationContextMiddleware`.
 *
 * These first-party tokens are stored as opaque grants (sha256 of the secret
 * in OAuthAccessTokenTable, org in referenceId), so `verifyOpaqueMcpToken`
 * accepts them without changing the public OAuth JWT access-token contract.
 */

const mintMcpTokenSchema = z.object({
  scopes: z.array(z.enum(["mcp:read", "mcp:write"])).min(1).optional(),
})

const mcpTokenResponseSchema = z.object({
  token: z.string(),
  appHostToken: z.string(),
  expiresAt: z.string().datetime(),
  appHostExpiresAt: z.string().datetime(),
  organizationId: z.string(),
  scopes: z.array(z.string()),
  resource: z.string(),
}).meta({ ref: "McpTokenResponse" })

const organizationRequiredSchema = z.object({
  error: z.literal("organization_required"),
  message: z.string(),
}).meta({ ref: "McpTokenOrganizationRequiredError" })

type McpRouteVariables = AuthContextVariables & Partial<OrganizationContextVariables>

const firstPartyMcpTokenTrustedOrigins = env.publicProxyTrustedOrigins

export function registerMcpTokenRoutes<T extends { Variables: McpRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/mcp/token",
    describeRoute({
      // Session-equivalent credential minting must never be exposed as an MCP
      // tool; the Authentication tag is blocked by the MCP exposure policy.
      tags: ["Authentication"],
      summary: "Mint MCP access token",
      description: "Mints an org-scoped MCP access token for the caller's active organization so first-party clients can connect to the Den MCP server without a separate browser OAuth flow.",
      responses: {
        200: jsonResponse("MCP access token minted successfully.", mcpTokenResponseSchema),
        400: jsonResponse("The token request was invalid or no active organization is selected.", z.union([invalidRequestSchema, organizationRequiredSchema])),
        401: jsonResponse("The caller must be signed in to mint an MCP token.", unauthorizedSchema),
        403: jsonResponse("API keys cannot mint MCP tokens.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    userSessionRoute(),
    jsonValidator(mintMcpTokenSchema),
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      const organizationContext = c.get("organizationContext")
      const orgId = organizationContext.organization.id
      const input = c.req.valid("json")

      const scopes = resolveMcpTokenScopes(input.scopes)
      const secret = crypto.randomBytes(32).toString("base64url")
      const appHostSecret = crypto.randomBytes(32).toString("base64url")
      const expiresAt = new Date(Date.now() + DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS)

      let sessionId = null
      try {
        sessionId = session?.id ? normalizeDenTypeId("session", session.id) : null
      } catch {
        sessionId = null
      }

      const tokenOwner = {
        clientId: DEN_MCP_FIRST_PARTY_CLIENT_ID,
        sessionId,
        userId: normalizeDenTypeId("user", user.id),
        referenceId: normalizeDenTypeId("organization", orgId),
        expiresAt,
      }
      await db.insert(OAuthAccessTokenTable).values([
        {
          id: createDenTypeId("oauthAccessToken"),
          token: hashOpaqueMcpSecret(secret),
          ...tokenOwner,
          scopes: JSON.stringify(scopes),
        },
        {
          id: createDenTypeId("oauthAccessToken"),
          token: hashOpaqueMcpSecret(appHostSecret),
          ...tokenOwner,
          scopes: JSON.stringify(["mcp:read", "mcp:write", DEN_MCP_APP_HOST_SCOPE]),
        },
      ])

      return c.json({
        token: `${DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX}${secret}`,
        appHostToken: `${DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX}${appHostSecret}`,
        expiresAt: expiresAt.toISOString(),
        appHostExpiresAt: expiresAt.toISOString(),
        organizationId: normalizeDenTypeId("organization", orgId),
        scopes,
        resource: deriveFirstPartyMcpTokenResourceFromRequest(c.req.raw, {
          fallback: DEN_MCP_RESOURCE,
          trustedOrigins: firstPartyMcpTokenTrustedOrigins,
        }),
      })
    },
  )
}
