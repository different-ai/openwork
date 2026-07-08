import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
} from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import {
  buildAuthorizeUrl,
  createOAuthStateToken,
  createPkcePair,
  exchangeCodeForTokens,
  resolvePublicOrigin,
  verifyOAuthStateToken,
} from "../../capability-sources/generic-oauth.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import {
  clientSelectedFeatures,
  getNativeOAuthProvider,
  NATIVE_OAUTH_PROVIDERS,
  resolveProviderScopes,
  type NativeOAuthProviderConfig,
} from "../../capability-sources/provider-registry.js"
import {
  disconnectAccount,
  getConnectedAccount,
  getOrgOAuthClient,
  upsertConnectedAccount,
  upsertOrgOAuthClient,
} from "../../capability-sources/oauth-credentials.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const providerParamsSchema = z.object({
  providerId: z.string().trim().min(1).max(255),
})

const saveClientBodySchema = z.object({
  clientId: z.string().trim().min(1).max(512).optional(),
  clientSecret: z.string().trim().min(1).max(4096).optional(),
  features: z.array(z.string().trim().min(1).max(128)).optional(),
})

const oauthNotFoundSchema = z.object({
  error: z.literal("unknown_oauth_provider"),
  message: z.string(),
}).meta({ ref: "UnknownOAuthProviderError" })

const clientConfigResponseSchema = z.object({
  ok: z.literal(true),
  providerId: z.string(),
  clientId: z.string(),
  features: z.array(z.string()),
}).meta({ ref: "OAuthClientConfigResponse" })

const clientConfigDetailResponseSchema = z.object({
  providerId: z.string(),
  configured: z.boolean(),
  clientId: z.string().nullable(),
  features: z.array(z.string()),
  scopes: z.array(z.string()),
  redirectUri: z.string(),
}).meta({ ref: "OAuthClientConfigDetailResponse" })

const connectStartResponseSchema = z.object({
  authorizeUrl: z.string(),
}).meta({ ref: "OAuthConnectStartResponse" })

const clientNotConfiguredSchema = z.object({
  error: z.literal("client_not_configured"),
  message: z.string(),
}).meta({ ref: "OAuthClientNotConfiguredError" })

const oauthStatusResponseSchema = z.object({
  providerId: z.string(),
  connected: z.boolean(),
  externalAccountId: z.string().nullable(),
  scopes: z.array(z.string()).nullable(),
}).meta({ ref: "OAuthProviderStatusResponse" })

function callbackRedirectUri(request: Request, providerId: string) {
  const origin = resolvePublicOrigin(request, env.apiPublicUrl)
  return `${origin}/v1/oauth-providers/${encodeURIComponent(providerId)}/connect/callback`
}

const nativeConnectStartResponseSchema = z.object({
  status: z.enum(["connected", "needs_auth"]),
  authorizeUrl: z.string().nullable(),
}).meta({ ref: "NativeProviderConnectStartResponse" })

type OrgIds = { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member"> }

async function beginNativeProviderConnect(input: OrgIds & {
  provider: NativeOAuthProviderConfig
  request: Request
}): Promise<{ authorizeUrl: string } | { error: "client_not_configured" }> {
  const client = await getOrgOAuthClient(input.organizationId, input.provider.providerId)
  if (!client) {
    return { error: "client_not_configured" }
  }

  const { verifier, challenge } = createPkcePair()
  const state = createOAuthStateToken({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.provider.providerId,
    secret: env.betterAuthSecret,
  })

  await upsertConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.provider.providerId,
    pendingCodeVerifier: verifier,
  })

  const authorizeUrl = buildAuthorizeUrl({
    provider: input.provider,
    client,
    state,
    redirectUri: callbackRedirectUri(input.request, input.provider.providerId),
    codeChallenge: challenge,
  })
  return { authorizeUrl }
}

/**
 * Generic OAuth provider routes, parameterized by providerId. This is what
 * makes any native provider (google-workspace today, anything else we
 * implement natively later) reachable through one shared implementation:
 * adding a provider is a provider-registry.ts entry, never a new route file.
 *
 * connect/start and connect/callback are OAuth plumbing — tagged
 * "Authentication", already blocked from the MCP surface for the same
 * reason session/token endpoints are: this is not something an agent should
 * ever drive itself.
 */
export function registerOAuthProviderRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/oauth-providers/:providerId/client",
    describeRoute({
      tags: ["Authentication"],
      summary: "Save an org's OAuth client for a provider",
      description: "Admin-only. Lets an org bring its own OAuth app (client id + secret) for a native provider such as google-workspace, instead of relying on an OpenWork-owned client.",
      responses: {
        200: jsonResponse("OAuth client saved.", clientConfigResponseSchema),
        400: jsonResponse("The request body or providerId was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can configure an OAuth client.", forbiddenSchema),
        404: jsonResponse("Unknown providerId.", oauthNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(providerParamsSchema),
    jsonValidator(saveClientBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can configure an OAuth client.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { providerId } = c.req.valid("param")
      const provider = getNativeOAuthProvider(providerId)
      if (!provider) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }

      const body = c.req.valid("json")
      const existing = await getOrgOAuthClient(payload.organization.id, providerId)
      if (!existing && !body.clientId) {
        return c.json({ error: "invalid_request", message: "clientId is required for first-time setup." }, 400)
      }

      if (body.features !== undefined) {
        const optionalFeatures = provider.optionalFeatures ?? {}
        const unknownFeatures = body.features.filter((feature) => !Object.hasOwn(optionalFeatures, feature))
        if (unknownFeatures.length > 0) {
          return c.json({ error: "invalid_request", message: `Unknown optional feature(s): ${unknownFeatures.join(", ")}.` }, 400)
        }
      }

      const clientId = body.clientId ?? existing?.clientId
      if (!clientId) {
        return c.json({ error: "invalid_request", message: "clientId is required for first-time setup." }, 400)
      }

      const saved = await upsertOrgOAuthClient({
        organizationId: payload.organization.id,
        providerId,
        clientId,
        ...(body.clientSecret !== undefined ? { clientSecret: body.clientSecret } : {}),
        ...(body.features !== undefined ? { extra: { ...(existing?.extra ?? {}), features: body.features } } : {}),
        createdByOrgMembershipId: payload.currentMember.id,
      })

      return c.json({ ok: true, providerId, clientId: saved.clientId, features: clientSelectedFeatures(provider, saved.extra) })
    },
  )

  app.get(
    "/v1/oauth-providers/:providerId/client",
    describeRoute({
      tags: ["Authentication"],
      summary: "Get an org's OAuth client configuration for a provider",
      description: "Admin-only. Returns setup status, the saved OAuth client id when configured, selected permission features, the callback redirect URI, and the full scope list members will be asked to approve. Never returns the client secret.",
      responses: {
        200: jsonResponse("OAuth client configuration.", clientConfigDetailResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can view an OAuth client configuration.", forbiddenSchema),
        404: jsonResponse("Unknown providerId.", oauthNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can view an OAuth client configuration.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { providerId } = c.req.valid("param")
      const provider = getNativeOAuthProvider(providerId)
      if (!provider) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }

      const client = await getOrgOAuthClient(payload.organization.id, providerId)
      const features = clientSelectedFeatures(provider, client?.extra ?? null)
      return c.json({
        providerId,
        configured: Boolean(client),
        clientId: client?.clientId ?? null,
        features,
        scopes: resolveProviderScopes(provider, features),
        redirectUri: callbackRedirectUri(c.req.raw, providerId),
      })
    },
  )

  app.get(
    "/v1/oauth-providers/:providerId/connect/start",
    describeRoute({
      tags: ["Authentication"],
      summary: "Begin connecting the calling member's account for a provider",
      description: "Returns an authorize URL to redirect the member's browser to. Requires the org to have already saved an OAuth client for this provider.",
      responses: {
        200: jsonResponse("Authorize URL to redirect to.", connectStartResponseSchema),
        400: jsonResponse("Unknown providerId.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The org has not configured an OAuth client for this provider yet.", clientNotConfiguredSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { providerId } = c.req.valid("param")
      const provider = getNativeOAuthProvider(providerId)
      if (!provider) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }

      const started = await beginNativeProviderConnect({
        provider,
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        request: c.req.raw,
      })
      if ("error" in started) {
        return c.json({ error: "client_not_configured", message: `Connect an OAuth client for "${providerId}" first.` }, 404)
      }
      return c.json({ authorizeUrl: started.authorizeUrl })
    },
  )

  // Native providers surface as synthetic entries in the member-facing
  // /v1/mcp-connections?scope=usable list (see native-provider-connections.ts),
  // and the desktop starts a connect by calling the SAME path shape it uses
  // for external MCP connections. These static delegates are registered
  // before the parameterized /v1/mcp-connections/:connectionId routes
  // (routes/org/index.ts order), so provider ids never reach the emc_ id
  // validator. Zero desktop changes.
  for (const provider of Object.values(NATIVE_OAUTH_PROVIDERS)) {
    app.get(
      `/v1/mcp-connections/${provider.providerId}/connect/start`,
      describeRoute({
        tags: ["Authentication"],
        summary: `Begin connecting the calling member to ${provider.displayName}`,
        description: "Native-provider twin of the external MCP connect/start route: returns an authorize URL for the browser, using the OAuth client the org saved for this provider.",
        responses: {
          200: jsonResponse("Authorize URL, or already connected.", nativeConnectStartResponseSchema),
          401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
          404: jsonResponse("The org has not configured an OAuth client for this provider yet.", clientNotConfiguredSchema),
        },
      }),
      orgMemberRoute(),
      async (c) => {
        const payload = c.get("organizationContext")
        const started = await beginNativeProviderConnect({
          provider,
          organizationId: payload.organization.id,
          orgMembershipId: payload.currentMember.id,
          request: c.req.raw,
        })
        if ("error" in started) {
          return c.json({ error: "client_not_configured", message: `Connect an OAuth client for "${provider.providerId}" first.` }, 404)
        }
        return c.json({ status: "needs_auth" as const, authorizeUrl: started.authorizeUrl })
      },
    )
  }

  app.get(
    "/v1/oauth-providers/:providerId/connect/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "OAuth callback for a provider",
      description: "The provider redirects here with code+state after the member consents. Identity is carried entirely by the signed state token, not a session cookie, since the redirect may arrive in a fresh browser context. Serves a small static HTML page that deep-links back to OpenWork.",
      responses: {
        200: htmlResponse("Connected — a static success page."),
        400: jsonResponse("Missing or invalid code/state.", invalidRequestSchema),
      },
    }),
    publicRoute,
    paramValidator(providerParamsSchema),
    async (c) => {
      const { providerId } = c.req.valid("param")
      const provider = getNativeOAuthProvider(providerId)
      if (!provider) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }

      const url = new URL(c.req.url)
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) {
        return c.json({ error: "invalid_request", message: "Missing code or state." }, 400)
      }

      const statePayload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
      if (!statePayload || statePayload.providerId !== providerId) {
        return c.json({ error: "invalid_request", message: "Invalid or expired state." }, 400)
      }

      const client = await getOrgOAuthClient(statePayload.organizationId, providerId)
      const pending = await getConnectedAccount({
        organizationId: statePayload.organizationId,
        orgMembershipId: statePayload.orgMembershipId,
        providerId,
      })
      if (!client || !pending?.pendingCodeVerifier) {
        return c.json({ error: "invalid_request", message: "No pending connection for this state." }, 400)
      }

      try {
        const tokens = await exchangeCodeForTokens({
          provider,
          client,
          code,
          redirectUri: callbackRedirectUri(c.req.raw, providerId),
          codeVerifier: pending.pendingCodeVerifier,
        })

        await upsertConnectedAccount({
          organizationId: statePayload.organizationId,
          orgMembershipId: statePayload.orgMembershipId,
          providerId,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          tokenType: tokens.token_type ?? null,
          expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
          scopes: tokens.scope ? tokens.scope.split(" ") : resolveProviderScopes(provider, clientSelectedFeatures(provider, client.extra)),
          pendingCodeVerifier: null,
        })
      } catch (error) {
        return c.html(connectCallbackPage({ ok: false, name: provider.displayName, message: error instanceof Error ? error.message : String(error) }), 400)
      }

      return c.html(connectCallbackPage({ ok: true, name: provider.displayName }))
    },
  )

  app.get(
    "/v1/oauth-providers/:providerId/status",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Check whether the calling member has connected a provider",
      description: "Read-only. Never returns a token — only whether a connection exists and which scopes/account it covers. Safe to expose to a harness so it can detect \"not connected\" and tell the human what to do.",
      responses: {
        200: jsonResponse("Connection status.", oauthStatusResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Unknown providerId.", oauthNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { providerId } = c.req.valid("param")
      if (!getNativeOAuthProvider(providerId)) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }

      const account = await getConnectedAccount({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerId,
      })
      return c.json({
        providerId,
        connected: Boolean(account?.accessToken),
        externalAccountId: account?.externalAccountId ?? null,
        scopes: account?.scopes ?? null,
      })
    },
  )

  app.post(
    "/v1/oauth-providers/:providerId/disconnect",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Disconnect the calling member's account for a provider",
      description: "Removes the stored credential. Mutation — intentionally kept out of the agent-callable MCP surface (see policy.ts BLOCKED_OPERATION_IDS).",
      responses: {
        200: emptyResponse("Disconnected."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Nothing was connected.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { providerId } = c.req.valid("param")
      const removed = await disconnectAccount({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerId,
      })
      if (!removed) {
        return c.json({ error: "not_found", message: "Nothing was connected." }, 404)
      }
      return c.json({ ok: true })
    },
  )
}
