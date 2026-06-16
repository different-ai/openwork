import * as crypto from "node:crypto"
import { OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX, DEN_MCP_RESOURCE } from "../../auth.js"
import { db } from "../../db.js"
import { hashOpaqueMcpSecret } from "../../mcp/auth.js"
import { resolveMcpTokenScopes } from "../../mcp/scopes.js"
import { DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS } from "../../mcp/token-lifetime.js"
import {
  jsonValidator,
  orgMemberRoute,
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
 * Tokens are stored exactly like oauthProvider-issued opaque tokens
 * (sha256 of the secret in OAuthAccessTokenTable, org in referenceId), so
 * `verifyOpaqueMcpToken` accepts them with no verification changes.
 */

const FIRST_PARTY_MCP_CLIENT_ID = "openwork-desktop"

const mintMcpTokenSchema = z.object({
  scopes: z.array(z.enum(["mcp:read", "mcp:write"])).min(1).optional(),
})

const mcpTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  organizationId: z.string(),
  scopes: z.array(z.string()),
  resource: z.string(),
}).meta({ ref: "McpTokenResponse" })

const organizationRequiredSchema = z.object({
  error: z.literal("organization_required"),
  message: z.string(),
}).meta({ ref: "McpTokenOrganizationRequiredError" })

type McpRouteVariables = AuthContextVariables & Partial<OrganizationContextVariables>

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
    jsonValidator(mintMcpTokenSchema),
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      const apiKey = c.get("apiKey")
      const organizationContext = c.get("organizationContext")
      const orgId = organizationContext.organization.id
      const input = c.req.valid("json")

      if (apiKey) {
        return c.json({
          error: "forbidden",
          message: "Use a signed-in user session to mint MCP tokens.",
        }, 403)
      }

      const scopes = resolveMcpTokenScopes(input.scopes)
      const secret = crypto.randomBytes(32).toString("base64url")
      const expiresAt = new Date(Date.now() + DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS)

      let sessionId = null
      try {
        sessionId = session?.id ? normalizeDenTypeId("session", session.id) : null
      } catch {
        sessionId = null
      }

      await db.insert(OAuthAccessTokenTable).values({
        id: createDenTypeId("oauthAccessToken"),
        token: hashOpaqueMcpSecret(secret),
        clientId: FIRST_PARTY_MCP_CLIENT_ID,
        sessionId,
        userId: normalizeDenTypeId("user", user.id),
        referenceId: normalizeDenTypeId("organization", orgId),
        expiresAt,
        scopes: JSON.stringify(scopes),
      })

      return c.json({
        token: `${DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX}${secret}`,
        expiresAt: expiresAt.toISOString(),
        organizationId: normalizeDenTypeId("organization", orgId),
        scopes,
        resource: DEN_MCP_RESOURCE,
      })
    },
  )
}
