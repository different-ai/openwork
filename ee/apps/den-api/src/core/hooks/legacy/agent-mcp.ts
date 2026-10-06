import * as crypto from "node:crypto"
import { cimdClientDiscovery } from "@better-auth/cimd"
import { extendOAuthProvider } from "@better-auth/oauth-provider"
import type { BetterAuthPlugin } from "better-auth"
import { APIError } from "better-auth/api"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { maybeString, readStringProperty, stringArray } from "../../../better-auth-values.js"
import { env } from "../../../env.js"
import { withLoopbackRedirectRelaxation } from "../../../mcp/cimd-loopback-redirects.js"
import { isCimdClientIdUrlAllowed } from "../../../mcp/cimd-policy.js"
import { contributeMcpGrantClaim } from "../../../mcp/grant-claims.js"
import {
  DEN_MCP_GRANT_ID_CLAIM,
  DEN_MCP_OAUTH_RESOURCE,
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_REFRESH_TOKEN_PREFIX,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_RESOURCES,
  DEN_MCP_TOKEN_USE_CLAIM,
  hashOAuthProviderToken,
  INVALID_MCP_SESSION_GRANT_DESCRIPTION,
  normalizeMcpOAuthResource,
} from "../../../mcp/oauth-resources.js"
import {
  assertLiveMcpRefreshGrant,
  McpRefreshGrantRevokedError,
  type McpRefreshGrantRow,
} from "../../../mcp/refresh-grant-liveness.js"
import { addRequestedMcpClientScopes, DEN_MCP_DEFAULT_CLIENT_SCOPES, DEN_MCP_SCOPES } from "../../../mcp/scopes.js"
import { deleteMcpOAuthGrantFamilyForSession, getMcpSessionLiveness } from "../../../mcp/session-liveness.js"
import {
  DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  DEN_MCP_OAUTH_AUTHORIZATION_EXPIRES_IN_SECONDS,
  DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
} from "../../../mcp/token-lifetime.js"
import { appLogger } from "../../../observability/logger.js"
import { coreHooks } from "../default-registry.js"
import type { CoreAuthMiddlewareContext, CoreBootContributorPoints } from "../points.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: agentMcp.

const logger = appLogger.child({ component: "auth" })

function hasMcpScope(scopes: readonly string[]) {
  return scopes.some((scope) => scope.startsWith("mcp:"))
}

function stripMcpRefreshTokenPrefix(refreshToken: string) {
  return refreshToken.startsWith(DEN_MCP_REFRESH_TOKEN_PREFIX)
    ? refreshToken.slice(DEN_MCP_REFRESH_TOKEN_PREFIX.length)
    : null
}

async function assertLiveMcpSessionForRefreshGrant(ctx: CoreAuthMiddlewareContext) {
  if (ctx.path !== "/oauth2/token" || readStringProperty(ctx.body, "grant_type") !== "refresh_token") {
    return
  }

  const refreshToken = readStringProperty(ctx.body, "refresh_token")
  if (!refreshToken) {
    return
  }

  const tokenSecret = stripMcpRefreshTokenPrefix(refreshToken)
  if (!tokenSecret) {
    return
  }

  const grant = await ctx.context.adapter.findOne<McpRefreshGrantRow>({
    model: "oauthRefreshToken",
    where: [{ field: "token", value: hashOAuthProviderToken(tokenSecret) }],
  })
  try {
    await assertLiveMcpRefreshGrant({
      grant,
      getSessionLiveness: getMcpSessionLiveness,
      findConsent: ({ clientId, userId, referenceId }) => ctx.context.adapter.findOne<{ id: string }>({
        model: "oauthConsent",
        where: [
          { field: "clientId", value: clientId },
          { field: "userId", value: userId },
          { field: "referenceId", value: referenceId },
        ],
      }),
      deleteGrantFamily: deleteMcpOAuthGrantFamilyForSession,
    })
  } catch (error) {
    if (!(error instanceof McpRefreshGrantRevokedError)) {
      throw error
    }
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: INVALID_MCP_SESSION_GRANT_DESCRIPTION,
    })
  }
}

// Refresh grants die with the session, consent or grant family that backed them.
coreHooks.registerMiddleware({
  point: "auth.beforePath",
  id: "legacy/agent-mcp/refresh-grant-liveness",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.security,
  handler: async ({ ctx }) => {
    await assertLiveMcpSessionForRefreshGrant(ctx)
  },
})

// Authorization requests may widen a client's registered scopes with MCP scopes.
coreHooks.registerMiddleware({
  point: "auth.beforePath",
  id: "legacy/agent-mcp/widen-authorize-client-scopes",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.security + 1,
  handler: async ({ ctx }) => {
    if (ctx.path !== "/oauth2/authorize") return
    const clientId = maybeString(ctx.query?.client_id)
    const requestedScopes = maybeString(ctx.query?.scope)?.split(/\s+/).filter(Boolean) ?? []
    if (!clientId) return

    const client = await ctx.context.adapter.findOne<{ scopes?: unknown }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    })
    const clientScopes = stringArray(client?.scopes)
    const nextScopes = addRequestedMcpClientScopes(clientScopes, requestedScopes)

    if (nextScopes.length > clientScopes.length) {
      await ctx.context.adapter.update({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
        update: {
          scopes: nextScopes,
          updatedAt: new Date(),
        },
      })
    }
  },
})

// Everything but the login and consent pages, which Core sets.
const mcpOAuthProviderOptions: CoreBootContributorPoints["oauth.providerConfig"] = {
  scopes: [...DEN_MCP_SCOPES],
  // No validAudiences: better-auth 1.7 has no such option (the key used to
  // be passed and ignored); audiences come from `resources` below.
  // better-auth 1.7 gates every token-request `resource` parameter on the
  // oauthResource registry (invalid_target "is not configured" otherwise
  // validAudiences no longer whitelists issuance). Seed all accepted MCP
  // resource aliases at startup — seeding is idempotent (insertOnly).
  resources: [...DEN_MCP_RESOURCES],
  // 1.7 defaults to requiring an oauthClientResource link per client per
  // resource. Dynamically registered MCP clients never request resources
  // at registration, so enforcement would invalid_target every DCR client.
  // Keep pre-1.7 behavior: registry + audience validation, no per-client ACL.
  enforcePerClientResources: false,
  allowPublicClientPrelogin: true,
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  codeExpiresIn: DEN_MCP_OAUTH_AUTHORIZATION_EXPIRES_IN_SECONDS,
  accessTokenExpiresIn: DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  m2mAccessTokenExpiresIn: DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  refreshTokenExpiresIn: DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  refreshTokenReuseInterval: 30,
  storeTokens: { hash: hashOAuthProviderToken },
  clientRegistrationDefaultScopes: [...DEN_MCP_DEFAULT_CLIENT_SCOPES],
  clientRegistrationAllowedScopes: [...DEN_MCP_SCOPES],
  advertisedMetadata: {
    scopes_supported: [...DEN_MCP_SCOPES],
    claims_supported: [
      DEN_MCP_TOKEN_USE_CLAIM,
      DEN_MCP_ORG_ID_CLAIM,
      DEN_MCP_RESOURCE_CLAIM,
      DEN_MCP_GRANT_ID_CLAIM,
    ],
  },
  extensions: [{
    claims: {
      accessToken: ({ ctx, client, user, referenceId }) => contributeMcpGrantClaim({
        claimName: DEN_MCP_GRANT_ID_CLAIM,
        clientId: client.clientId,
        userId: user?.id,
        referenceId,
        findConsent: ({ clientId, userId, referenceId: consentReferenceId }) => ctx.context.adapter.findOne<{ id: string }>({
          model: "oauthConsent",
          where: [
            { field: "clientId", value: clientId },
            { field: "userId", value: userId },
            { field: "referenceId", value: consentReferenceId },
          ],
        }),
      }),
    },
  }],
  postLogin: {
    page: `${env.betterAuthUrl}/mcp/select-organization`,
    shouldRedirect: async ({ session, scopes }) => {
      if (!hasMcpScope(scopes)) {
        return false
      }

      return !session.activeOrganizationId
    },
    consentReferenceId: async ({ session, scopes }) => {
      if (!hasMcpScope(scopes)) {
        return undefined
      }

      const activeOrganizationId = typeof session.activeOrganizationId === "string"
        ? session.activeOrganizationId
        : undefined
      if (!activeOrganizationId) {
        throw new APIError("BAD_REQUEST", {
          message: "Select an organization before authorizing MCP access.",
        })
      }

      return normalizeDenTypeId("organization", activeOrganizationId)
    },
  },
  customAccessTokenClaims: ({ referenceId, resources, scopes }) => {
    const claims: Record<string, string> = {}
    const resource = resources?.[0]
    const mcpResource = typeof resource === "string" ? normalizeMcpOAuthResource(resource) : null
    if (hasMcpScope(scopes) || mcpResource) {
      claims[DEN_MCP_TOKEN_USE_CLAIM] = "mcp"
      claims[DEN_MCP_RESOURCE_CLAIM] = mcpResource ?? DEN_MCP_OAUTH_RESOURCE
    }
    if (referenceId) {
      claims[DEN_MCP_ORG_ID_CLAIM] = referenceId
    }
    return claims
  },
  // Better Auth refresh-family teardown and /oauth2/revoke intentionally do
  // not remove durable consent. Already minted JWT exposure remains bounded
  // by the configured 45-minute MCP access-token lifetime.
  prefix: {
    opaqueAccessToken: DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
    refreshToken: DEN_MCP_REFRESH_TOKEN_PREFIX,
    clientSecret: "ow_mcp_cs_",
  },
}

// Client ID Metadata Documents (MCP authorization spec): an MCP client may
// present the HTTPS URL of a JSON document it hosts as its client_id. The
// plugin fetches and validates the document, stores it as a public client,
// and advertises `client_id_metadata_document_supported` in discovery, so
// spec-following clients no longer need dynamic registration. DCR stays on
// as the fallback for clients that do not support this yet.
const cimdPlugin: BetterAuthPlugin = {
  id: "cimd",
  init(ctx) {
    extendOAuthProvider(ctx, {
      // Same discovery the @better-auth/cimd plugin installs, wrapped so a
      // registered loopback redirect matches on any port (RFC 8252 §7.3),
      // which native MCP clients such as Claude Code depend on.
      clientDiscovery: withLoopbackRedirectRelaxation(cimdClientDiscovery({
        // Redirect URIs are matched at authorize time and Den's MCP redirect
        // policy still applies; native clients legitimately redirect to
        // loopback or another origin than the one hosting their document.
        originBoundFields: ["post_logout_redirect_uris", "client_uri"],
        allowFetch: (url) => isCimdClientIdUrlAllowed(url),
        onClientCreated: ({ client }) => {
          logger.info("Registered MCP client from its client ID metadata document", {
            clientId: client.clientId,
            clientName: client.name ?? null,
          })
        },
      })),
    })
  },
}

coreHooks.registerBootContributor({
  point: "oauth.providerConfig",
  id: "legacy/agent-mcp/oauth-provider-config",
  registrant: "legacy",
  contribute: () => mcpOAuthProviderOptions,
})

coreHooks.registerBootContributor({
  point: "betterAuth.plugins",
  id: "legacy/agent-mcp/cimd-client-discovery",
  registrant: "legacy",
  contribute: () => [cimdPlugin],
})

coreHooks.registerBootContributor({
  point: "auth.modelIds",
  id: "legacy/agent-mcp/oauth-model-ids",
  registrant: "legacy",
  contribute: () => ({
    oauthClient: () => createDenTypeId("oauthClient"),
    oauthAccessToken: () => createDenTypeId("oauthAccessToken"),
    oauthRefreshToken: () => createDenTypeId("oauthRefreshToken"),
    oauthConsent: () => createDenTypeId("oauthConsent"),
    // better-auth 1.7 oauth-provider models with no den typeid: without
    // an id the drizzle adapter emits `insert ... values (default, ...)`
    // and MySQL rejects it (no default on `id`) — the oauthResource seed
    // storm of 2026-08-07. oauthClientResource/oauthClientAssertion use
    // forceAllowId, but cover them for any future non-forced create.
    oauthResource: () => crypto.randomUUID(),
    oauthClientResource: () => crypto.randomUUID(),
    oauthClientAssertion: () => crypto.randomUUID(),
  }),
})
