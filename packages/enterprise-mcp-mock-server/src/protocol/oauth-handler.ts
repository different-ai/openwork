import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import type { EnterpriseMcpScenario } from "../contracts/scenario.js"
import type { ProviderProfile } from "../contracts/profile.js"
import type { FaultDefinition } from "../contracts/fault.js"
import type { InstanceState } from "../runtime/instance-state.js"
import { readForm, readJson, redirect, sendJson, sendOAuthError } from "./http-utils.js"
import { oauthRedirectUriSchema } from "../contracts/oauth.js"

interface OAuthRequestContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
  readonly baseUrl: string
  readonly correlationId: string
  readonly scenario: EnterpriseMcpScenario
  readonly profile: ProviderProfile
  readonly state: InstanceState
  readonly activeFault: FaultDefinition | undefined
}

const registrationRequestSchema = z.object({
  redirect_uris: z.array(oauthRedirectUriSchema).min(1).max(10),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post"]).optional(),
  client_name: z.string().min(1).max(200).optional(),
})

const pkceVerifierPattern = /^[A-Za-z0-9._~-]{43,128}$/
const pkceS256ChallengePattern = /^[A-Za-z0-9_-]{43}$/
const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(Uint8Array.from(leftBuffer), Uint8Array.from(rightBuffer))
  )
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function faultApplies(context: OAuthRequestContext, effect: FaultDefinition["effect"]): boolean {
  return context.activeFault?.effect === effect && context.state.shouldApplyFault(context.activeFault, context.scenario)
}

function emitFault(context: OAuthRequestContext, summary: string): void {
  const fault = context.activeFault
  if (!fault) return
  context.state.emit({
    correlationId: context.correlationId,
    scenario: context.scenario,
    phase: fault.phase,
    direction: "outbound",
    kind: "fault",
    outcome: "applied",
    summary,
    details: { faultId: fault.id, category: fault.category },
  })
}

function sendInvalidClient(context: OAuthRequestContext): void {
  const { response, profile, scenario, state, correlationId } = context
  if (profile.provider === "microsoft") {
    const traceId = randomUUID()
    const timestamp = new Date(state.now()).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z")
    sendJson(response, 401, {
      error: "invalid_client",
      error_description: `AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${scenario.oauth.clientId}'. Trace ID: ${traceId} Correlation ID: ${correlationId} Timestamp: ${timestamp}`,
      error_codes: [7_000_215],
      timestamp,
      trace_id: traceId,
      correlation_id: correlationId,
    })
    return
  }

  if (profile.provider === "servicenow") {
    sendOAuthError(
      response,
      401,
      "invalid_client",
      "Client authentication failed. Verify the client ID and client secret configured for this ServiceNow OAuth application.",
    )
    return
  }

  sendOAuthError(response, 401, "invalid_client", "The synthetic OAuth client was rejected")
}

export async function handleOAuthRequest(context: OAuthRequestContext): Promise<boolean> {
  const { request, response, url, baseUrl, scenario, profile, state, correlationId } = context
  const mcpUrl = new URL(profile.endpointPath, baseUrl).href
  const resourceMetadataPath = `/.well-known/oauth-protected-resource${profile.endpointPath}`

  if (request.method === "GET" && (url.pathname === resourceMetadataPath || url.pathname === "/.well-known/oauth-protected-resource")) {
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_RESOURCE_DISCOVERY",
      direction: "inbound",
      kind: "request",
      outcome: "started",
      summary: "Protected-resource metadata requested",
      details: { path: url.pathname },
    })
    if (faultApplies(context, "malformed-resource-metadata")) {
      emitFault(context, "Returned mismatched protected-resource metadata")
      sendJson(response, 200, { resource: `${mcpUrl}/wrong-resource`, authorization_servers: [baseUrl] })
      return true
    }
    sendJson(response, 200, {
      resource: mcpUrl,
      authorization_servers: [baseUrl],
      scopes_supported: scenario.oauth.requiredResourceScopes,
      bearer_methods_supported: ["header"],
    })
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_RESOURCE_DISCOVERY",
      direction: "outbound",
      kind: "response",
      outcome: "passed",
      summary: "Returned coherent protected-resource metadata",
      details: { resourceOrigin: new URL(mcpUrl).origin, scopeCount: scenario.oauth.authorizationScopes.length },
    })
    return true
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")
  ) {
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_ISSUER_DISCOVERY",
      direction: "inbound",
      kind: "request",
      outcome: "started",
      summary: "Authorization-server metadata requested",
    })
    const issuer = faultApplies(context, "issuer-mismatch") ? `${baseUrl}/mismatched-issuer` : baseUrl
    if (issuer !== baseUrl) emitFault(context, "Published an intentionally mismatched OAuth issuer")
    const pkceMethods = faultApplies(context, "omit-pkce-s256") ? ["plain"] : ["S256"]
    if (!pkceMethods.includes("S256")) emitFault(context, "Omitted PKCE S256 from authorization-server metadata")
    sendJson(response, 200, {
      issuer,
      authorization_endpoint: new URL(profile.oauth.authorizationPath, baseUrl).href,
      token_endpoint: new URL(profile.oauth.tokenPath, baseUrl).href,
      registration_endpoint:
        scenario.oauth.registration === "dynamic" && profile.oauth.registrationPath
          ? new URL(profile.oauth.registrationPath, baseUrl).href
          : undefined,
      revocation_endpoint: new URL(profile.oauth.revocationPath, baseUrl).href,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: pkceMethods,
      token_endpoint_auth_methods_supported: profile.oauth.clientAuthenticationMethods,
      scopes_supported: scenario.oauth.authorizationScopes,
    })
    return true
  }

  if (request.method === "POST" && profile.oauth.registrationPath && url.pathname === profile.oauth.registrationPath) {
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_CLIENT_REGISTRATION",
      direction: "inbound",
      kind: "request",
      outcome: "started",
      summary: "Dynamic client registration requested",
    })
    if (scenario.oauth.registration !== "dynamic" || faultApplies(context, "reject-registration")) {
      if (context.activeFault?.effect === "reject-registration") emitFault(context, "Rejected dynamic client registration")
      sendJson(response, 404, { error: "registration_not_supported" })
      return true
    }
    const registration = registrationRequestSchema.parse(await readJson(request))
    const tokenEndpointAuthMethod = registration.token_endpoint_auth_method ?? "none"
    if (!profile.oauth.clientAuthenticationMethods.includes(tokenEndpointAuthMethod)) {
      sendJson(response, 400, { error: "invalid_client_metadata", error_description: "Unsupported token endpoint authentication method" })
      return true
    }
    const clientId = state.issueOpaque("client")
    const clientSecret = tokenEndpointAuthMethod === "client_secret_post" ? state.issueOpaque("client-secret") : ""
    state.putClient({
      clientId,
      clientSecret,
      redirectUris: registration.redirect_uris,
      tokenEndpointAuthMethod,
      createdAt: state.now(),
      expiresAt: state.now() + 3_600_000,
    })
    sendJson(response, 201, {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      redirect_uris: registration.redirect_uris,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    })
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_CLIENT_REGISTRATION",
      direction: "outbound",
      kind: "response",
      outcome: "passed",
      summary: "Registered a synthetic OAuth client",
      details: { clientIdHash: createHash("sha256").update(clientId).digest("hex"), redirectCount: registration.redirect_uris.length },
    })
    return true
  }

  if (request.method === "GET" && url.pathname === profile.oauth.authorizationPath) {
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_USER_OR_WORKLOAD",
      direction: "inbound",
      kind: "request",
      outcome: "started",
      summary: "Synthetic authorization requested",
    })
    const clientId = url.searchParams.get("client_id") ?? ""
    const responseType = url.searchParams.get("response_type") ?? ""
    const redirectUri = url.searchParams.get("redirect_uri") ?? ""
    const codeChallenge = url.searchParams.get("code_challenge") ?? ""
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? ""
    const resource = url.searchParams.get("resource") ?? ""
    const oauthState = url.searchParams.get("state") ?? ""
    const scope = url.searchParams.get("scope") ?? ""
    const requestedScopes = scope.split(" ").filter(Boolean)
    const client = state.clients.get(clientId)
    if (
      responseType !== "code" ||
      !client ||
      !client.redirectUris.includes(redirectUri) ||
      resource !== mcpUrl ||
      codeChallengeMethod !== "S256" ||
      !pkceS256ChallengePattern.test(codeChallenge)
    ) {
      sendOAuthError(response, 400, "invalid_request", "Client, redirect URI, resource, and PKCE S256 must match the active scenario")
      return true
    }
    if (
      requestedScopes.length === 0 ||
      requestedScopes.some((requestedScope) => !scenario.oauth.authorizationScopes.includes(requestedScope)) ||
      scenario.oauth.requiredResourceScopes.some((requiredScope) => !requestedScopes.includes(requiredScope))
    ) {
      sendOAuthError(response, 400, "invalid_scope", "Requested scopes must be a non-empty subset of the active scenario")
      return true
    }
    const code = state.issueOpaque("authorization-code")
    state.putAuthorizationCode({
      code,
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scopes: requestedScopes,
      expiresAt: state.now() + 60_000,
    })
    const destination = new URL(redirectUri)
    destination.searchParams.set("code", code)
    destination.searchParams.set("state", oauthState)
    redirect(response, destination.href)
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_USER_OR_WORKLOAD",
      direction: "outbound",
      kind: "response",
      outcome: "passed",
      summary: "Synthetic user authorization completed",
      details: { redirectOrigin: destination.origin },
    })
    return true
  }

  if (request.method === "POST" && url.pathname === profile.oauth.tokenPath) {
    state.emit({
      correlationId,
      scenario,
      phase: "AUTH_TOKEN_ACQUISITION",
      direction: "inbound",
      kind: "request",
      outcome: "started",
      summary: "OAuth token exchange requested",
    })
    const form = await readForm(request)
    const clientId = form.get("client_id") ?? ""
    const clientSecret = form.get("client_secret") ?? ""
    const client = state.clients.get(clientId)
    const clientAuthenticationValid =
      client?.tokenEndpointAuthMethod === "none"
        ? clientSecret.length === 0
        : client?.tokenEndpointAuthMethod === "client_secret_post" && safeEqual(client.clientSecret, clientSecret)
    if (faultApplies(context, "reject-client") || !client || !clientAuthenticationValid) {
      if (context.activeFault?.effect === "reject-client") emitFault(context, "Rejected the OAuth client during token exchange")
      sendInvalidClient(context)
      return true
    }

    const grantType = form.get("grant_type") ?? ""
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? ""
      const codeRecord = state.authorizationCodes.get(code)
      const verifier = form.get("code_verifier") ?? ""
      const invalidGrant =
        faultApplies(context, "reject-grant") ||
        !codeRecord ||
        codeRecord.expiresAt < state.now() ||
        codeRecord.clientId !== clientId ||
        codeRecord.redirectUri !== (form.get("redirect_uri") ?? "") ||
        codeRecord.resource !== (form.get("resource") ?? "") ||
        !pkceVerifierPattern.test(verifier) ||
        !safeEqual(codeRecord.codeChallenge, pkceChallenge(verifier))
      if (invalidGrant) {
        if (context.activeFault?.effect === "reject-grant") emitFault(context, "Rejected the authorization grant during token exchange")
        sendOAuthError(response, 400, "invalid_grant", "The authorization code or PKCE verifier was rejected")
        return true
      }
      state.authorizationCodes.delete(code)
      issueTokenResponse(context, clientId, codeRecord.resource, codeRecord.scopes)
      return true
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? ""
      const existing = state.refreshTokens.get(refreshToken)
      if (!existing || existing.clientId !== clientId) {
        sendOAuthError(response, 400, "invalid_grant", "The synthetic refresh token was rejected")
        return true
      }
      revokeTokenFamily(state, existing.familyId)
      issueTokenResponse(context, clientId, existing.resource, existing.scopes, existing.familyId)
      return true
    }

    sendOAuthError(response, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported")
    return true
  }

  if (request.method === "POST" && url.pathname === profile.oauth.revocationPath) {
    const form = await readForm(request)
    const tokenValue = form.get("token") ?? ""
    const accessToken = state.tokens.get(tokenValue)
    const refreshToken = state.refreshTokens.get(tokenValue)
    const targetClientId = accessToken?.clientId ?? refreshToken?.clientId
    const clientId = form.get("client_id") ?? ""
    const clientSecret = form.get("client_secret") ?? ""
    const client = state.clients.get(clientId)
    const clientAuthenticationValid =
      client?.tokenEndpointAuthMethod === "none"
        ? clientSecret.length === 0
        : client?.tokenEndpointAuthMethod === "client_secret_post" && safeEqual(client.clientSecret, clientSecret)
    if (!client || !clientAuthenticationValid || (targetClientId !== undefined && targetClientId !== clientId)) {
      sendInvalidClient(context)
      return true
    }
    const familyId = accessToken?.familyId ?? refreshToken?.familyId
    if (familyId) revokeTokenFamily(state, familyId)
    response.writeHead(200, { "cache-control": "no-store" })
    response.end()
    return true
  }

  return false
}

function issueTokenResponse(
  context: OAuthRequestContext,
  clientId: string,
  resource: string,
  scopes: readonly string[],
  existingFamilyId?: string,
): void {
  const accessToken = context.state.issueOpaque("access-token")
  const refreshToken = context.state.issueOpaque("refresh-token")
  const familyId = existingFamilyId ?? context.state.issueOpaque("token-family")
  context.state.putToken({
    accessToken,
    familyId,
    clientId,
    resource,
    scopes,
    subject: "synthetic-enterprise-user@example.invalid",
    expiresAt: context.state.now() + 3_600_000,
  })
  context.state.putRefreshToken({
    refreshToken,
    familyId,
    clientId,
    resource,
    scopes,
    subject: "synthetic-enterprise-user@example.invalid",
    expiresAt: context.state.now() + refreshTokenLifetimeMs,
  })
  sendJson(context.response, 200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: scopes.join(" "),
  })
  context.state.emit({
    correlationId: context.correlationId,
    scenario: context.scenario,
    phase: "AUTH_TOKEN_ACQUISITION",
    direction: "outbound",
    kind: "response",
    outcome: "passed",
    summary: "Issued bounded synthetic OAuth tokens",
    details: { scopeCount: scopes.length, resourceOrigin: new URL(resource).origin },
  })
}

function revokeTokenFamily(state: InstanceState, familyId: string): void {
  for (const [accessToken, record] of state.tokens) {
    if (record.familyId === familyId) state.tokens.delete(accessToken)
  }
  for (const [refreshToken, record] of state.refreshTokens) {
    if (record.familyId === familyId) state.refreshTokens.delete(refreshToken)
  }
}
