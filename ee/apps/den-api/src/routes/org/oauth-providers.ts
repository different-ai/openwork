import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import {
  buildAuthorizeUrl,
  createOAuthStateToken,
  createPkcePair,
  exchangeCodeForTokens,
  OAuthClientConfigurationError,
  OAuthTokenExchangeError,
  resolvePublicOrigin,
  verifyOAuthStateToken,
} from "../../capability-sources/generic-oauth.js"
import { connectCallbackPage } from "../../capability-sources/oauth-callback-page.js"
import { revokeAccountsBeforeOAuthClientIdentityChange } from "../../capability-sources/oauth-client-rotation.js"
import {
  clientSelectedFeatures,
  getNativeOAuthProvider,
  NATIVE_OAUTH_PROVIDERS,
  resolveProviderScopes,
  type NativeOAuthProviderConfig,
} from "../../capability-sources/provider-registry.js"
import {
  completeConnectedAccountForActiveMember,
  disconnectAccount,
  disconnectProviderAccountsForOrganization,
  getConnectedAccount,
  getOrgOAuthClient,
  upsertConnectedAccount,
  upsertOrgOAuthClient,
} from "../../capability-sources/oauth-credentials.js"
import { normalizeEntraTenantId, readProviderTenantId } from "../../capability-sources/oauth-tenant.js"
import { getExternalMcpConnection, listUsableNativeProviderConnections } from "../../capability-sources/external-mcp-connections.js"
import { resolveDefaultNativeProviderCredentialId, resolveManageableNativeProviderCredentialId } from "../../capability-sources/native-provider-connections.js"
import { listTeamsForMember } from "../../orgs.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { CONNECTIONS_READ_SESSION_MAX_AGE_MS, ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const providerParamsSchema = z.object({
  providerId: z.string().trim().min(1).max(255),
})

const saveClientBodySchema = z.object({
  clientId: z.string().trim().min(1).max(512).optional(),
  clientSecret: z.string().trim().min(1).max(4096).optional(),
  features: z.array(z.string().trim().min(1).max(128)).optional(),
  tenantId: z.string().trim().min(1).max(253).optional(),
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
  tenantId: z.string().nullable(),
}).meta({ ref: "OAuthClientConfigResponse" })

const clientConfigDetailResponseSchema = z.object({
  providerId: z.string(),
  configured: z.boolean(),
  clientId: z.string().nullable(),
  features: z.array(z.string()),
  scopes: z.array(z.string()),
  redirectUri: z.string(),
  tenantId: z.string().nullable(),
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

const nativeOAuthIdentitySchema = z.object({
  email: z.string().trim().email().max(320),
})
const NATIVE_OAUTH_USERINFO_TIMEOUT_MS = 5_000

function emailFromIdToken(idToken: string | undefined): string | null {
  const segments = idToken?.split(".")
  if (segments?.length !== 3) return null
  const encodedPayload = segments[1]
  if (!encodedPayload) return null
  try {
    // Identity hint only: the token came directly from the configured token
    // endpoint over TLS and is never used here for authentication or authorization.
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
    const parsed = nativeOAuthIdentitySchema.safeParse(payload)
    return parsed.success ? parsed.data.email : null
  } catch {
    return null
  }
}

async function resolveExternalAccountId(input: {
  provider: NativeOAuthProviderConfig
  accessToken: string
  idToken?: string
  requestId: string
}): Promise<string | null> {
  const idTokenEmail = emailFromIdToken(input.idToken)
  if (idTokenEmail) return idTokenEmail
  if (!input.provider.userinfoUrl) return null

  try {
    const response = await fetch(input.provider.userinfoUrl, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(NATIVE_OAUTH_USERINFO_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn("native_oauth_identity_resolution_failed", {
        requestId: input.requestId,
        providerId: input.provider.providerId,
        status: response.status,
      })
      return null
    }
    const body: unknown = await response.json()
    const parsed = nativeOAuthIdentitySchema.safeParse(body)
    if (parsed.success) return parsed.data.email
    console.warn("native_oauth_identity_resolution_failed", {
      requestId: input.requestId,
      providerId: input.provider.providerId,
      code: "invalid_userinfo_response",
    })
  } catch (error) {
    console.warn("native_oauth_identity_resolution_failed", {
      requestId: input.requestId,
      providerId: input.provider.providerId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    })
  }
  return null
}

function callbackRedirectUri(request: Request, providerId: string) {
  const origin = resolvePublicOrigin(request, env.apiPublicUrl)
  return `${origin}/v1/oauth-providers/${encodeURIComponent(providerId)}/connect/callback`
}

const nativeConnectStartResponseSchema = z.object({
  status: z.enum(["connected", "needs_auth"]),
  authorizeUrl: z.string().nullable(),
}).meta({ ref: "NativeProviderConnectStartResponse" })

type OrgIds = { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member"> }

export async function beginNativeProviderConnect(input: OrgIds & {
  provider: NativeOAuthProviderConfig
  credentialProviderId: string
  request: Request
  teamIds: DenTypeId<"team">[]
}): Promise<{ authorizeUrl: string } | { error: "client_not_configured" | "client_configuration_invalid" | "forbidden"; message?: string }> {
  // The literal registry key is the legacy no-row alias and intentionally
  // remains implicitly org-wide. Connector rows always require a grant.
  if (input.credentialProviderId !== input.provider.providerId) {
    const usableConnections = await listUsableNativeProviderConnections({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      teamIds: input.teamIds,
    })
    const canUse = usableConnections.some((connection) => (
      connection.id === input.credentialProviderId
      && connection.nativeProviderKey === input.provider.providerId
    ))
    if (!canUse) return { error: "forbidden" }
  }

  const client = await getOrgOAuthClient(input.organizationId, input.credentialProviderId)
  if (!client) {
    return { error: "client_not_configured" }
  }

  const { verifier, challenge } = createPkcePair()
  const state = createOAuthStateToken({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.credentialProviderId,
    binding: input.provider.providerId,
    secret: env.betterAuthSecret,
  })

  let authorizeUrl: string
  try {
    authorizeUrl = buildAuthorizeUrl({
      provider: input.provider,
      client,
      state,
      redirectUri: callbackRedirectUri(input.request, input.provider.providerId),
      codeChallenge: challenge,
    })
  } catch (error) {
    if (error instanceof OAuthClientConfigurationError) {
      return { error: "client_configuration_invalid", message: error.message }
    }
    throw error
  }

  await upsertConnectedAccount({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.credentialProviderId,
    pendingCodeVerifier: verifier,
  })
  return { authorizeUrl }
}

async function resolveNativeProviderCredential(input: {
  organizationId: DenTypeId<"organization">
  providerOrConnectionId: string
}): Promise<{ provider: NativeOAuthProviderConfig; credentialProviderId: string } | null> {
  const registeredProvider = getNativeOAuthProvider(input.providerOrConnectionId)
  if (registeredProvider) {
    const credentialProviderId = await resolveManageableNativeProviderCredentialId({
      organizationId: input.organizationId,
      nativeProviderKey: registeredProvider.providerId,
    })
    return { provider: registeredProvider, credentialProviderId: credentialProviderId ?? registeredProvider.providerId }
  }

  let connectionId: DenTypeId<"externalMcpConnection">
  try {
    connectionId = normalizeDenTypeId("externalMcpConnection", input.providerOrConnectionId)
  } catch {
    return null
  }
  const connection = await getExternalMcpConnection({ organizationId: input.organizationId, connectionId })
  if (connection?.kind !== "native_provider" || !connection.nativeProviderKey) return null
  const provider = getNativeOAuthProvider(connection.nativeProviderKey)
  return provider ? { provider, credentialProviderId: connection.id } : null
}

async function resolveMemberNativeProviderCredential(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerOrConnectionId: string
  teamIds: DenTypeId<"team">[]
}): Promise<Awaited<ReturnType<typeof resolveNativeProviderCredential>> | "forbidden"> {
  const registeredProvider = getNativeOAuthProvider(input.providerOrConnectionId)
  if (registeredProvider) {
    const credentialProviderId = await resolveDefaultNativeProviderCredentialId({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      nativeProviderKey: registeredProvider.providerId,
      teamIds: input.teamIds,
    })
    return { provider: registeredProvider, credentialProviderId: credentialProviderId ?? registeredProvider.providerId }
  }

  const resolved = await resolveNativeProviderCredential(input)
  if (!resolved) return null
  const usableConnections = await listUsableNativeProviderConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    teamIds: input.teamIds,
  })
  return usableConnections.some((connection) => connection.id === resolved.credentialProviderId)
    ? resolved
    : "forbidden"
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
      const resolved = await resolveNativeProviderCredential({
        organizationId: payload.organization.id,
        providerOrConnectionId: providerId,
      })
      if (!resolved) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }
      const { provider, credentialProviderId } = resolved

      const body = c.req.valid("json")
      const existing = await getOrgOAuthClient(payload.organization.id, credentialProviderId)
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

      if (body.tenantId !== undefined && !provider.tenantIdExtraKey) {
        return c.json({ error: "invalid_request", message: `tenantId is not supported for "${providerId}".` }, 400)
      }

      const tenantId = provider.tenantIdExtraKey
        ? body.tenantId !== undefined
          ? normalizeEntraTenantId(body.tenantId)
          : readProviderTenantId(existing?.extra ?? null, provider.tenantIdExtraKey)
        : null
      if (provider.tenantIdExtraKey && !tenantId) {
        return c.json({ error: "invalid_request", message: "A valid Microsoft Entra tenant ID (GUID) or verified tenant domain is required." }, 400)
      }

      const clientId = body.clientId ?? existing?.clientId
      if (!clientId) {
        return c.json({ error: "invalid_request", message: "clientId is required for first-time setup." }, 400)
      }

      const extra = { ...(existing?.extra ?? {}) }
      if (body.features !== undefined) extra.features = body.features
      if (provider.tenantIdExtraKey && tenantId) extra[provider.tenantIdExtraKey] = tenantId

      const previousTenantId = provider.tenantIdExtraKey
        ? readProviderTenantId(existing?.extra ?? null, provider.tenantIdExtraKey)
        : null
      // Fail closed: old-tenant/client tokens are removed before the provider
      // identity changes, so a failed revoke can never leave them usable under
      // the new org configuration. A later save failure only requires reconnect.
      await revokeAccountsBeforeOAuthClientIdentityChange({
        hadExistingClient: Boolean(existing),
        previousClientId: existing?.clientId ?? null,
        nextClientId: clientId,
        previousTenantId,
        nextTenantId: tenantId,
        organizationId: payload.organization.id,
        providerId: credentialProviderId,
        revoke: disconnectProviderAccountsForOrganization,
      })

      const saved = await upsertOrgOAuthClient({
        organizationId: payload.organization.id,
        providerId: credentialProviderId,
        clientId,
        ...(body.clientSecret !== undefined ? { clientSecret: body.clientSecret } : {}),
        ...((body.features !== undefined || provider.tenantIdExtraKey) ? { extra } : {}),
        createdByOrgMembershipId: payload.currentMember.id,
      })

      return c.json({
        ok: true,
        providerId,
        clientId: saved.clientId,
        features: clientSelectedFeatures(provider, saved.extra),
        tenantId: provider.tenantIdExtraKey ? readProviderTenantId(saved.extra, provider.tenantIdExtraKey) : null,
      })
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
      const admin = ensureOrganizationAdmin(
        c,
        "Only workspace owners and admins can view an OAuth client configuration.",
        CONNECTIONS_READ_SESSION_MAX_AGE_MS,
      )
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { providerId } = c.req.valid("param")
      const resolved = await resolveNativeProviderCredential({
        organizationId: payload.organization.id,
        providerOrConnectionId: providerId,
      })
      if (!resolved) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }
      const { provider, credentialProviderId } = resolved

      const client = await getOrgOAuthClient(payload.organization.id, credentialProviderId)
      const features = clientSelectedFeatures(provider, client?.extra ?? null)
      return c.json({
        providerId,
        configured: Boolean(client),
        clientId: client?.clientId ?? null,
        features,
        scopes: resolveProviderScopes(provider, features),
        redirectUri: callbackRedirectUri(c.req.raw, provider.providerId),
        tenantId: provider.tenantIdExtraKey ? readProviderTenantId(client?.extra ?? null, provider.tenantIdExtraKey) : null,
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
    resolveMemberTeamsMiddleware,
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { providerId } = c.req.valid("param")
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const resolved = await resolveMemberNativeProviderCredential({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerOrConnectionId: providerId,
        teamIds: memberTeams.map((team) => team.id),
      })
      if (!resolved) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }
      if (resolved === "forbidden") {
        return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
      }

      const started = await beginNativeProviderConnect({
        provider: resolved.provider,
        credentialProviderId: resolved.credentialProviderId,
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        request: c.req.raw,
        teamIds: memberTeams.map((team) => team.id),
      })
      if ("error" in started) {
        if (started.error === "forbidden") {
          return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
        }
        if (started.error === "client_configuration_invalid") {
          return c.json({ error: "invalid_request", message: started.message ?? "OAuth client configuration is incomplete." }, 400)
        }
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
          400: jsonResponse("The OAuth client configuration is incomplete.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
          404: jsonResponse("The org has not configured an OAuth client for this provider yet.", clientNotConfiguredSchema),
        },
      }),
      orgMemberRoute(),
      resolveMemberTeamsMiddleware,
      async (c) => {
        const payload = c.get("organizationContext")
        const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
        const credentialProviderId = await resolveDefaultNativeProviderCredentialId({
          organizationId: payload.organization.id,
          orgMembershipId: payload.currentMember.id,
          nativeProviderKey: provider.providerId,
          teamIds: memberTeams.map((team) => team.id),
        }) ?? provider.providerId
        const started = await beginNativeProviderConnect({
          provider,
          credentialProviderId,
          organizationId: payload.organization.id,
          orgMembershipId: payload.currentMember.id,
          request: c.req.raw,
          teamIds: memberTeams.map((team) => team.id),
        })
        if ("error" in started) {
          if (started.error === "forbidden") {
            return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
          }
          if (started.error === "client_configuration_invalid") {
            return c.json({ error: "invalid_request", message: started.message ?? "OAuth client configuration is incomplete." }, 400)
          }
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
      if (!statePayload || (
        statePayload.binding !== providerId
        && !(statePayload.binding === undefined && statePayload.providerId === providerId)
      )) {
        return c.json({ error: "invalid_request", message: "Invalid or expired state." }, 400)
      }

      const memberTeams = await listTeamsForMember({
        organizationId: statePayload.organizationId,
        memberId: statePayload.orgMembershipId,
      })
      const resolved = await resolveMemberNativeProviderCredential({
        organizationId: statePayload.organizationId,
        orgMembershipId: statePayload.orgMembershipId,
        providerOrConnectionId: statePayload.providerId,
        teamIds: memberTeams.map((team) => team.id),
      })
      if (!resolved || resolved === "forbidden" || resolved.provider.providerId !== providerId || resolved.credentialProviderId !== statePayload.providerId) {
        return c.json({ error: "invalid_request", message: "Invalid or expired state." }, 400)
      }
      const credentialProviderId = resolved.credentialProviderId

      const client = await getOrgOAuthClient(statePayload.organizationId, credentialProviderId)
      const pending = await getConnectedAccount({
        organizationId: statePayload.organizationId,
        orgMembershipId: statePayload.orgMembershipId,
        providerId: credentialProviderId,
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
        const externalAccountId = await resolveExternalAccountId({
          provider,
          accessToken: tokens.access_token,
          idToken: tokens.id_token,
          requestId: c.get("requestId"),
        })

        const saved = await completeConnectedAccountForActiveMember({
          organizationId: statePayload.organizationId,
          orgMembershipId: statePayload.orgMembershipId,
          providerId: credentialProviderId,
          expectedAccountId: pending.id,
          expectedPendingCodeVerifier: pending.pendingCodeVerifier,
          externalAccountId,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          tokenType: tokens.token_type ?? null,
          expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
          scopes: tokens.scope ? tokens.scope.split(" ") : resolveProviderScopes(provider, clientSelectedFeatures(provider, client.extra)),
          pendingCodeVerifier: null,
        })
        if (!saved) {
          return c.html(connectCallbackPage({
            ok: false,
            name: provider.displayName,
            message: "This OpenWork connection request is no longer active.",
          }), 400)
        }
      } catch (error) {
        const requestId = c.get("requestId")
        if (error instanceof OAuthTokenExchangeError) {
          console.error("native_oauth_connect_callback_token_exchange_failed", {
            requestId,
            organizationId: statePayload.organizationId,
            providerId,
            phase: error.phase,
            code: error.code,
            ...error.details,
          })
          return c.html(connectCallbackPage({
            ok: false,
            name: provider.displayName,
            message: error.message,
            referenceId: requestId,
          }), 400)
        }

        console.error("native_oauth_connect_callback_failed", {
          requestId,
          organizationId: statePayload.organizationId,
          providerId,
          phase: "AUTH_TOKEN_ACQUISITION",
          code: "oauth_callback_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
        return c.html(connectCallbackPage({
          ok: false,
          name: provider.displayName,
          message: "OpenWork could not finish the OAuth connection. Try Connect again; if it still fails, contact support with the diagnostic reference.",
          referenceId: requestId,
        }), 400)
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
    resolveMemberTeamsMiddleware,
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { providerId } = c.req.valid("param")
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const resolved = await resolveMemberNativeProviderCredential({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerOrConnectionId: providerId,
        teamIds: memberTeams.map((team) => team.id),
      })
      if (!resolved) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }
      if (resolved === "forbidden") {
        return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
      }

      const account = await getConnectedAccount({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerId: resolved.credentialProviderId,
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
    resolveMemberTeamsMiddleware,
    paramValidator(providerParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { providerId } = c.req.valid("param")
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const resolved = await resolveMemberNativeProviderCredential({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerOrConnectionId: providerId,
        teamIds: memberTeams.map((team) => team.id),
      })
      if (!resolved) {
        return c.json({ error: "unknown_oauth_provider", message: `"${providerId}" is not a known native OAuth provider.` }, 404)
      }
      if (resolved === "forbidden") {
        return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
      }
      const removed = await disconnectAccount({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerId: resolved.credentialProviderId,
      })
      if (!removed) {
        return c.json({ error: "not_found", message: "Nothing was connected." }, 404)
      }
      return c.json({ ok: true })
    },
  )
}
