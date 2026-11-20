// A LiteLLM proxy that only accepts sign-in tokens (JWT auth): each member signs
// in with Microsoft Entra ID, and the gateway renews and forwards their own
// access token for the API scope the provider configures. Microsoft Foundry
// sign-in and the key-based LiteLLM modes are unchanged.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { isInferenceCredentialKindSupported, liteLlmEntraScope } from "@openwork-ee/gateway-catalog"
import { microsoftRefreshScopes, microsoftSignInScopes, readMicrosoftTokens } from "@openwork-ee/utils/microsoft-entra"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { resolveFeatures, type FeatureContext } from "@openwork/features"
import { createLiteLlmEntraFeatureCheck } from "../src/litellm-entra-feature.js"
import { createOauthRefresher, providerHoldsRefreshableKind, sameOauthVersion, type OauthCredentialRow, type OauthRefreshStore, type RefreshMemberToken } from "../src/credentials/oauth-refresh.js"
import type { GatewayAccessRow, GatewayMemberAccessRow } from "../src/provider-access.js"
import { cursorModelsPath } from "../src/cursor.js"
import { claudeCodeModelsPath } from "../src/claude-code.js"
import { codexModelsPath } from "../src/codex.js"
import type { GatewayCredential, GatewayCredentialLookup, GatewayProvider } from "../src/provider-credentials.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes, gatewayPathPrefix, gatewayModelsPath } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const gatewayKeyId = createDenTypeId("gatewayKey")
const providerId = createDenTypeId("inferenceProvider")
const setId = createDenTypeId("gatewayCredentialSet")
const credentialId = createDenTypeId("inferenceProviderCredential")
const now = new Date("2026-11-17T12:00:00Z")
const model = "gpt-fixture"
const tenantId = "11111111-2222-4333-8444-555555555555"
const clientId = "66666666-7777-4888-8999-aaaaaaaaaaaa"
const apiScope = `api://${clientId}/access`
const revision = "r".repeat(43)

const COGNITIVE_SIGN_IN = "https://cognitiveservices.azure.com/.default offline_access openid profile email"
const COGNITIVE_REFRESH = "https://cognitiveservices.azure.com/.default offline_access"

function liteLlmSettings(keySource: "personal" | "issued" | "entra", mode: "org" | "member" = "member", scope: string | null = keySource === "entra" ? apiScope : null) {
  return { upstreamBaseUrl: "https://litellm.example.com/v1", litellm: { version: 1, mode, keySource, entraScope: scope } }
}

function tokenResponse(scope?: string) {
  return { token_type: "Bearer", expires_in: 3600, access_token: "entra-access-fixture", refresh_token: "entra-refresh-fixture", ...(scope === undefined ? {} : { scope }) }
}

test("Microsoft Foundry still requests the Azure Cognitive Services scope", () => {
  assert.equal(microsoftSignInScopes(), COGNITIVE_SIGN_IN)
  assert.equal(microsoftSignInScopes(null), COGNITIVE_SIGN_IN)
  assert.equal(microsoftRefreshScopes(), COGNITIVE_REFRESH)
  assert.equal(microsoftRefreshScopes(null), COGNITIVE_REFRESH)
})

test("a provider's own API scope is requested with offline access, and with the ID token only at sign-in", () => {
  assert.equal(microsoftSignInScopes(apiScope), `${apiScope} offline_access openid profile`)
  assert.equal(microsoftRefreshScopes(apiScope), `${apiScope} offline_access`)
})

test("a token response is accepted only for the API it was requested for", () => {
  // Foundry: unchanged.
  assert.ok(readMicrosoftTokens(tokenResponse("https://cognitiveservices.azure.com/user_impersonation https://cognitiveservices.azure.com/.default")))
  assert.ok(readMicrosoftTokens(tokenResponse()))
  assert.equal(readMicrosoftTokens(tokenResponse(apiScope)), null)
  assert.equal(readMicrosoftTokens(tokenResponse("https://graph.microsoft.com/User.Read")), null)

  // A provider's own API scope.
  assert.equal(readMicrosoftTokens(tokenResponse(apiScope), apiScope)?.scope, apiScope)
  assert.ok(readMicrosoftTokens(tokenResponse(`openid profile api://${clientId.toUpperCase()}/access`), apiScope))
  assert.equal(readMicrosoftTokens(tokenResponse(apiScope.toUpperCase()), apiScope), null)
  assert.ok(readMicrosoftTokens(tokenResponse(), apiScope))
  // A /.default request is answered with the API's individual scopes.
  assert.ok(readMicrosoftTokens(tokenResponse(`api://${clientId}/access api://${clientId}/models.read`), `api://${clientId}/.default`))
  assert.equal(readMicrosoftTokens(tokenResponse("https://cognitiveservices.azure.com/.default"), apiScope), null)
  assert.equal(readMicrosoftTokens(tokenResponse("https://graph.microsoft.com/User.Read"), apiScope), null)
  assert.equal(readMicrosoftTokens(tokenResponse("api://another-application/access"), apiScope), null)
})

test("only a LiteLLM provider in member Microsoft Entra sign-in mode has an API scope", () => {
  assert.equal(liteLlmEntraScope({ provider_id: "litellm", settings: liteLlmSettings("entra") }), apiScope)
  for (const settings of [liteLlmSettings("personal"), liteLlmSettings("issued"), liteLlmSettings("personal", "org"), liteLlmSettings("entra", "org"), liteLlmSettings("entra", "member", null), liteLlmSettings("entra", "member", " "), {}, null]) {
    assert.equal(liteLlmEntraScope({ provider_id: "litellm", settings }), null, JSON.stringify(settings))
  }
  // The mode belongs to LiteLLM providers: the same settings on another provider mean nothing.
  assert.equal(liteLlmEntraScope({ provider_id: "microsoft-foundry", settings: liteLlmSettings("entra") }), null)
  assert.equal(liteLlmEntraScope({ provider_id: "openai", settings: liteLlmSettings("entra") }), null)
})

test("a member's Entra ID token is a credential for Microsoft Foundry and for LiteLLM in member Entra sign-in mode only", () => {
  assert.equal(isInferenceCredentialKindSupported("oauth_azure", "microsoft-foundry"), true)
  assert.equal(isInferenceCredentialKindSupported("oauth_azure", "microsoft-foundry", { resourceName: "acme" }), true)
  assert.equal(isInferenceCredentialKindSupported("oauth_azure", "litellm", liteLlmSettings("entra")), true)
  assert.equal(isInferenceCredentialKindSupported("oauth_azure", "litellm"), false)
  for (const settings of [liteLlmSettings("personal"), liteLlmSettings("issued"), liteLlmSettings("personal", "org")]) {
    assert.equal(isInferenceCredentialKindSupported("oauth_azure", "litellm", settings), false, JSON.stringify(settings))
  }
  assert.equal(isInferenceCredentialKindSupported("oauth_azure", "openai", liteLlmSettings("entra")), false)
  // Every other kind is as before, whatever the settings.
  assert.equal(isInferenceCredentialKindSupported("api_key", "litellm", liteLlmSettings("entra")), true)
  assert.equal(isInferenceCredentialKindSupported("oauth_google", "litellm", liteLlmSettings("entra")), false)
  assert.equal(isInferenceCredentialKindSupported("aws_sso", "litellm", liteLlmSettings("entra")), false)
  assert.equal(isInferenceCredentialKindSupported("oauth_google", "google-vertex"), true)
  assert.equal(isInferenceCredentialKindSupported("aws_sso", "amazon-bedrock"), true)
})

test("the refresh allowlist adds LiteLLM for Entra ID tokens in that mode only", () => {
  assert.equal(providerHoldsRefreshableKind({ provider_id: "microsoft-foundry", settings: {} }, "oauth_azure"), true)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "litellm", settings: liteLlmSettings("entra") }, "oauth_azure"), true)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "litellm", settings: liteLlmSettings("personal") }, "oauth_azure"), false)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "litellm", settings: liteLlmSettings("issued") }, "oauth_azure"), false)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "litellm", settings: liteLlmSettings("entra") }, "oauth_google"), false)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "litellm", settings: liteLlmSettings("entra") }, "aws_sso"), false)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "google-vertex", settings: {} }, "oauth_google"), true)
  assert.equal(providerHoldsRefreshableKind({ provider_id: "google-vertex", settings: {} }, "oauth_azure"), false)
})

function accessRow(): GatewayAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  return {
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "All LiteLLM models", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Microsoft sign-in", credential_mode: "member", oauth_client_id: clientId, oauth_client_secret: "client-secret-fixture", oauth_tenant_id: tenantId, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: { id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: model, name: model, created_at: now, model_config: { id: model, name: model } },
  }
}

function memberSecret(identityScope: string | undefined, accessToken = "entra-access-old") {
  return JSON.stringify({ accessToken, refreshToken: "entra-refresh-old", tokenType: "Bearer", microsoftIdentity: {
    tenantId, objectId: "object-fixture", userName: "person@example.test", clientId, authorizationRevision: revision, ...(identityScope === undefined ? {} : { scope: identityScope }),
  } })
}

/** One credential row, written the way the database store writes it. */
function memoryStore(initial: OauthCredentialRow) {
  let row = initial
  let revisions = 0
  let authorized = true
  const store: OauthRefreshStore = {
    async reloadCredential() { return authorized ? { ...row } : null },
    async tryAcquireRefreshLock(input) {
      if (!authorized || !sameOauthVersion(row, input.credential) || (row.refreshing_until && row.refreshing_until >= input.now)) return null
      row = { ...row, refreshing_until: input.until, updated_at: new Date(row.updated_at.getTime() + 1) }
      return { scope: input.scope, credential: { ...row } }
    },
    async saveRefreshedToken(input) {
      if (!authorized || !sameOauthVersion(row, input.lock.credential) || !row.refreshing_until || row.refreshing_until <= input.now) return false
      row = { ...row, secret: input.secret, expires_at: input.expiresAt, last_refreshed_at: input.now, refreshing_until: null, last_error: null, updated_at: new Date(row.updated_at.getTime() + 1), secret_revision: `revision-${++revisions}` }
      return true
    },
    async recordRefreshFailure(input) {
      if (!authorized || !sameOauthVersion(row, input.lock.credential) || !row.refreshing_until || row.refreshing_until <= input.now) return false
      row = { ...row, refreshing_until: null, last_error: input.error, updated_at: new Date(row.updated_at.getTime() + 1), status: input.permanent ? "refresh_failed" : row.status }
      return true
    },
  }
  return { store, current: () => row, replace: (next: OauthCredentialRow) => { row = next }, revokeAccess: () => { authorized = false } }
}

function expiringRow(secret: string): OauthCredentialRow {
  return {
    id: credentialId, kind: "oauth_azure", secret, status: "active", last_error: null, secret_revision: "revision-0",
    gateway_provider_id: providerId, credential_set_id: setId, organization_id: organizationId, subject: orgMembershipId, org_membership_id: orgMembershipId,
    // Thirty seconds left: inside the refresh window.
    expires_at: new Date(now.getTime() + 30_000), updated_at: new Date(now.getTime() - 3_600_000), last_refreshed_at: new Date(now.getTime() - 3_570_000), refreshing_until: null,
  }
}

function refreshInput(secret = memberSecret(apiScope)) {
  const row = accessRow()
  const authorization: GatewayCredentialLookup = {
    scope: { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId, gatewayProviderId: providerId },
    selection: { row, requestedModel: model, upstreamModel: model },
    subject: orgMembershipId,
  }
  return {
    credential: expiringRow(secret), provider: { ...row.credentialSet, api_scope: apiScope },
    authorization, subject: orgMembershipId, now, clock: () => now,
  }
}

async function refresh(input: { secret: string; configuredScope: string | null; granted?: string }) {
  const requests: Array<{ url: string; body: URLSearchParams }> = []
  const { store, current } = memoryStore(expiringRow(input.secret))
  const refresher = createOauthRefresher({
    store,
    tokenFetch: async (url, init) => {
      requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) })
      return Response.json({ token_type: "Bearer", expires_in: 3600, access_token: "entra-access-new", refresh_token: "entra-refresh-new", ...(input.granted === undefined ? {} : { scope: input.granted }) })
    },
  })
  const row = accessRow()
  const authorization: GatewayCredentialLookup = {
    scope: { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId, gatewayProviderId: providerId },
    selection: { row, requestedModel: model, upstreamModel: model },
    subject: orgMembershipId,
  }
  const outcome = await refresher({
    credential: { id: credentialId, kind: "oauth_azure", secret: input.secret, expires_at: new Date(now.getTime() + 30_000), status: "active" },
    provider: { ...row.credentialSet, api_scope: input.configuredScope },
    authorization, subject: orgMembershipId, now, clock: () => now,
  })
  return { outcome, requests, current }
}

test("a LiteLLM member's token is renewed with the provider's configured API scope", async () => {
  const { outcome, requests, current } = await refresh({ secret: memberSecret(apiScope), configuredScope: apiScope, granted: apiScope })
  assert.equal(outcome.kind, "refreshed")
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`)
  assert.equal(requests[0]?.body.get("grant_type"), "refresh_token")
  assert.equal(requests[0]?.body.get("scope"), `${apiScope} offline_access`)
  assert.equal(requests[0]?.body.get("refresh_token"), "entra-refresh-old")
  assert.equal(requests[0]?.body.get("client_id"), clientId)
  const stored: unknown = JSON.parse(current().secret)
  assert.deepEqual(stored, { accessToken: "entra-access-new", refreshToken: "entra-refresh-new", tokenType: "Bearer", microsoftIdentity: {
    tenantId, objectId: "object-fixture", userName: "person@example.test", clientId, authorizationRevision: revision, scope: apiScope,
  } })
})

test("a Microsoft Foundry member's token is still renewed for Azure Cognitive Services", async () => {
  const { outcome, requests, current } = await refresh({ secret: memberSecret(undefined), configuredScope: null, granted: "https://cognitiveservices.azure.com/user_impersonation" })
  assert.equal(outcome.kind, "refreshed")
  assert.equal(requests[0]?.body.get("scope"), COGNITIVE_REFRESH)
  // The stored secret gains no scope: it is exactly what Foundry sign-in has always stored.
  assert.deepEqual(JSON.parse(current().secret), { accessToken: "entra-access-new", refreshToken: "entra-refresh-new", tokenType: "Bearer", microsoftIdentity: {
    tenantId, objectId: "object-fixture", userName: "person@example.test", clientId, authorizationRevision: revision,
  } })
})

test("a token signed in for another API scope is never renewed", async () => {
  const bindings: Array<[string | undefined, string | null]> = [[`api://${clientId}/older`, apiScope], [undefined, apiScope], [apiScope, null]]
  for (const [identityScope, configuredScope] of bindings) {
    const { outcome, requests, current } = await refresh({ secret: memberSecret(identityScope), configuredScope })
    assert.equal(requests.length, 0, `${identityScope} -> ${configuredScope}`)
    assert.equal(outcome.kind, "auth_required")
    assert.equal(current().status, "refresh_failed")
    assert.equal(current().last_error, "invalid_token_secret")
  }
})

test("a renewal answered for another API is not stored", async () => {
  const { outcome, requests, current } = await refresh({ secret: memberSecret(apiScope), configuredScope: apiScope, granted: "https://graph.microsoft.com/User.Read" })
  assert.equal(requests.length, 1)
  assert.equal(outcome.kind, "retry")
  assert.equal(current().last_error, "invalid_token_response")
  assert.doesNotMatch(current().secret, /entra-access-new/)
})

test("concurrent renewals exchange one refresh token and both reuse the winner", async () => {
  const input = refreshInput()
  const memory = memoryStore(input.credential)
  let requests = 0
  let release = () => {}
  const ready = new Promise<void>((resolve) => { release = resolve })
  const refresher = createOauthRefresher({
    store: memory.store, pollMs: 1, waitMs: 20,
    sleep: async () => { release(); await Promise.resolve() },
    tokenFetch: async () => {
      requests++
      await ready
      return Response.json(tokenResponse(apiScope))
    },
  })
  const outcomes = await Promise.all([refresher(input), refresher(input)])
  assert.equal(requests, 1)
  for (const outcome of outcomes) {
    assert.equal(outcome.kind, "refreshed")
    if (outcome.kind === "refreshed") assert.equal(outcome.credential.secret, memory.current().secret)
  }
  assert.equal(memory.current().refreshing_until, null)
})

test("renewal failures distinguish member reauthorization, admin repair and retryable outages", async () => {
  for (const scenario of [
    { status: 400, error: "invalid_grant", outcome: "auth_required", storedStatus: "refresh_failed", storedError: "invalid_grant" },
    { status: 401, error: "invalid_client", outcome: "configuration_required", storedStatus: "active", storedError: "invalid_client" },
    { status: 429, error: "invalid_grant", outcome: "retry", storedStatus: "active", storedError: "token_endpoint_unavailable" },
    { status: 503, error: "invalid_client", outcome: "retry", storedStatus: "active", storedError: "token_endpoint_unavailable" },
  ]) {
    const input = refreshInput()
    const memory = memoryStore(input.credential)
    const refresher = createOauthRefresher({ store: memory.store, tokenFetch: async () => Response.json({ error: scenario.error, error_description: "untrusted-response-fixture" }, { status: scenario.status }) })
    assert.equal((await refresher(input)).kind, scenario.outcome)
    assert.equal(memory.current().status, scenario.storedStatus)
    assert.equal(memory.current().last_error, scenario.storedError)
    assert.equal(memory.current().secret, input.credential.secret)
    assert.equal(memory.current().refreshing_until, null)
  }
})

test("late renewal success and failure never overwrite a replacement sign-in revision", async () => {
  for (const status of [200, 400, 401]) {
    const input = refreshInput()
    const memory = memoryStore(input.credential)
    const replacement = { ...input.credential, secret: memberSecret(apiScope, "replacement-access-fixture"), secret_revision: "replacement-revision", expires_at: new Date(now.getTime() + 3_600_000) }
    const refresher = createOauthRefresher({ store: memory.store, tokenFetch: async () => {
      // Reauthorization can occur in the same millisecond: the ciphertext revision is the fence.
      memory.replace({ ...replacement, updated_at: memory.current().updated_at })
      return Response.json(status === 200 ? tokenResponse(apiScope) : { error: status === 400 ? "invalid_grant" : "invalid_client" }, { status })
    } })
    const outcome = await refresher(input)
    assert.equal(outcome.kind, "refreshed")
    assert.equal(memory.current().status, "active")
    assert.equal(memory.current().last_error, null)
    assert.equal(memory.current().secret, replacement.secret)
    assert.equal(memory.current().secret_revision, replacement.secret_revision)
  }
})

test("access revocation during renewal neither stores nor returns the new token", async () => {
  for (const status of [200, 400]) {
    const input = refreshInput()
    const memory = memoryStore(input.credential)
    const refresher = createOauthRefresher({ store: memory.store, tokenFetch: async () => {
      memory.revokeAccess()
      return Response.json(status === 200 ? tokenResponse(apiScope) : { error: "invalid_grant" }, { status })
    } })
    assert.deepEqual(await refresher(input), { kind: "auth_required" })
    assert.equal(memory.current().secret, input.credential.secret)
    assert.equal(memory.current().last_error, null)
  }
})

function app(input: {
  settings: Record<string, unknown>
  credential: GatewayCredential
  credentialSet?: Partial<GatewayAccessRow["credentialSet"]>
  reloadedProvider?: Partial<GatewayProvider>
  featureEnabled?: () => Promise<boolean>
  refreshMemberToken?: RefreshMemberToken
  onCredentialRead?: () => void
  memberRows?: GatewayMemberAccessRow[]
}) {
  const sent: Request[] = []
  const row = accessRow()
  Object.assign(row.credentialSet, input.credentialSet)
  let providerReads = 0
  const providerConsistencies: Array<"primary" | undefined> = []
  const accessConsistencies: Array<"primary" | undefined> = []
  const credentialConsistencies: Array<"primary" | undefined> = []
  const provider: GatewayProvider = {
    id: providerId, organization_id: organizationId, provider_id: "litellm", status: "active", settings: input.settings,
    provider_config: { id: "litellm", name: "LiteLLM", npm: "@ai-sdk/openai-compatible", env: ["LITELLM_API_KEY"] },
  }
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  registerGatewayRoutes(api, {
    fetch: async (request, init) => {
      sent.push(new Request(request, init))
      return Response.json({ id: "chatcmpl_1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => { throw new Error("per-member LiteLLM sign-in is budgeted by LiteLLM, not OpenWork") },
    loadGatewayProvider: async (lookup) => {
      providerConsistencies.push(lookup.consistency)
      return ++providerReads <= 2 ? provider : { ...provider, ...input.reloadedProvider }
    },
    checkLiteLlmEntraFeature: input.featureEnabled ?? (async () => true),
    loadMemberGatewayAccess: async () => input.memberRows ?? [],
    autoRouterRoutingConfigured: false,
    refreshMemberToken: input.refreshMemberToken,
    loadGatewayAccess: async (_scope, consistency) => { accessConsistencies.push(consistency); return [row] },
    loadProviderCredential: async (lookup) => { credentialConsistencies.push(lookup.consistency); input.onCredentialRead?.(); return input.credential },
    catalog: createProviderCatalog({ litellm: { npm: "@ai-sdk/openai-compatible", env: ["LITELLM_API_KEY"] }, "microsoft-foundry": { npm: "@ai-sdk/anthropic", env: [] } }),
    now: () => now,
  })
  const send = () => api.request(`${gatewayPathPrefix}/${providerId}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ow_gw_caller_key_fixture" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  })
  return { sent, send, api, providerReads: () => providerReads, providerConsistencies, accessConsistencies, credentialConsistencies }
}

function entraCredential(identityScope: string | undefined): GatewayCredential {
  return { id: credentialId, kind: "oauth_azure", status: "active", expires_at: new Date(now.getTime() + 3_600_000), secret: memberSecret(identityScope, "entra-member-access-fixture") }
}

test("a member's own Entra access token is the bearer LiteLLM receives", async () => {
  const { sent, send, providerConsistencies, accessConsistencies, credentialConsistencies } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(apiScope) })
  const response = await send()
  assert.equal(response.status, 200)
  assert.deepEqual(providerConsistencies, [undefined, "primary", "primary"])
  assert.deepEqual(accessConsistencies, ["primary", "primary"])
  assert.ok(credentialConsistencies.length > 0)
  assert.ok(credentialConsistencies.every((value) => value === "primary"))
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, "https://litellm.example.com/v1/chat/completions")
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer entra-member-access-fixture")
  // The refresh token and the caller's own Gateway key never leave the gateway.
  const forwarded = `${[...(sent[0]?.headers ?? [])].join("\n")}\n${await sent[0]?.text()}`
  assert.doesNotMatch(forwarded, /entra-refresh-old|ow_gw_caller_key_fixture/)
  assert.doesNotMatch(await response.text(), /entra-member-access-fixture|entra-refresh-old/)
})

test("a token signed in for another API scope is not sent to LiteLLM", async () => {
  for (const identityScope of [`api://${clientId}/older`, undefined]) {
    const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(identityScope) })
    const response = await send()
    assert.equal(response.status, 401, String(identityScope))
    assert.equal(response.headers.get("x-openwork-auth-required"), "1")
    assert.equal(sent.length, 0)
    assert.doesNotMatch(await response.text(), /entra-member-access-fixture/)
  }
})

test("fresh Microsoft tokens are bound to the selected tenant, client and member set", async () => {
  const sets: Array<Partial<GatewayAccessRow["credentialSet"]>> = [
    { oauth_tenant_id: "99999999-2222-4333-8444-555555555555" },
    { oauth_client_id: "another-client" },
    { oauth_tenant_id: null },
    { oauth_client_id: null },
    { credential_mode: "org" },
  ]
  for (const credentialSet of sets) {
    const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(apiScope), credentialSet })
    const response = await send()
    assert.notEqual(response.status, 200, JSON.stringify(credentialSet))
    assert.equal(sent.length, 0)
    assert.doesNotMatch(await response.text(), /entra-member-access-fixture|entra-refresh-old/)
  }
  const { send } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(apiScope), credentialSet: { oauth_tenant_id: tenantId.toUpperCase() } })
  assert.equal((await send()).status, 200)
})

test("provider changes during authorization never dispatch a token to the obsolete route", async () => {
  const changes: Array<Partial<GatewayProvider>> = [
    { settings: { ...liteLlmSettings("entra"), upstreamBaseUrl: "https://replacement.example/v1" } },
    { settings: liteLlmSettings("entra", "member", `api://${clientId}/replacement`) },
    { settings: liteLlmSettings("personal") },
    { provider_id: "openai" },
    { status: "disabled" },
    { organization_id: createDenTypeId("organization") },
    { provider_config: { id: "litellm", options: { baseURL: "https://replacement.example/v1" } } },
  ]
  for (const reloadedProvider of changes) {
    const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(apiScope), reloadedProvider })
    const response = await send()
    assert.equal(response.status, 503, JSON.stringify(reloadedProvider))
    assert.equal(sent.length, 0)
    assert.doesNotMatch(await response.text(), /entra-member-access-fixture|entra-refresh-old/)
  }
})

test("a key-based LiteLLM provider never forwards an Entra ID token", async () => {
  const sources: Array<"personal" | "issued"> = ["personal", "issued"]
  for (const keySource of sources) {
    const { sent, send } = app({ settings: liteLlmSettings(keySource), credential: entraCredential(apiScope) })
    const response = await send()
    assert.equal(response.status, 502, keySource)
    assert.equal(sent.length, 0)
    assert.doesNotMatch(await response.text(), /entra-member-access-fixture/)
  }
})

test("a member's own LiteLLM key keeps its read path without feature or extra provider reads", async () => {
  let featureReads = 0
  const { sent, send, providerReads, providerConsistencies, accessConsistencies, credentialConsistencies } = app({ settings: liteLlmSettings("personal"), credential: { id: credentialId, kind: "api_key", secret: "sk-member-litellm-fixture", expires_at: null, status: "active" },
    featureEnabled: async () => { featureReads++; throw new Error("feature storage unavailable") } })
  assert.equal((await send()).status, 200)
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer sk-member-litellm-fixture")
  assert.equal(featureReads, 0)
  assert.equal(providerReads(), 1)
  assert.deepEqual(providerConsistencies, [undefined])
  assert.ok(accessConsistencies.every((value) => value === undefined))
  assert.ok(credentialConsistencies.every((value) => value === undefined))
})

test("disabled, killed, organization and member overrides stop Entra before credential work", async () => {
  const enabled: FeatureContext = { deployment: "cloud", locks: {}, overrides: {}, rollouts: { litellmEntraMemberSignIn: { enabled: true, killed: false } } }
  const states: FeatureContext[] = [
    { ...enabled, rollouts: {} },
    { ...enabled, overrides: { litellmEntraMemberSignIn: false } },
    { ...enabled, memberOverrides: { litellmEntraMemberSignIn: false } },
    { ...enabled, locks: { litellmEntraMemberSignIn: false }, memberOverrides: { litellmEntraMemberSignIn: true } },
    { ...enabled, rollouts: { litellmEntraMemberSignIn: { enabled: true, killed: true } }, overrides: { litellmEntraMemberSignIn: true }, memberOverrides: { litellmEntraMemberSignIn: true } },
  ]
  const userId = createDenTypeId("user")
  for (const state of states) {
    let credentialReads = 0
    let refreshes = 0
    const featureEnabled = createLiteLlmEntraFeatureCheck({
      loadActiveMember: async (scope) => {
        assert.equal(scope.organizationId, organizationId)
        assert.equal(scope.orgMembershipId, orgMembershipId)
        return { userId }
      },
      readMemberFeatures: async (org, user) => {
        assert.equal(org, organizationId)
        assert.equal(user, userId)
        assert.notEqual(user, orgMembershipId)
        return resolveFeatures(state)
      },
    })
    const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: { ...entraCredential(apiScope), expires_at: new Date(now.getTime() + 1_000) }, featureEnabled,
      onCredentialRead: () => { credentialReads++ }, refreshMemberToken: async () => { refreshes++; return { kind: "auth_required" } } })
    const response = await send()
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, "feature_disabled")
    assert.equal(credentialReads, 0)
    assert.equal(refreshes, 0)
    assert.equal(sent.length, 0)
  }
})

test("missing active user and failed feature reads fail closed", async () => {
  const checks = [
    createLiteLlmEntraFeatureCheck({ loadActiveMember: async () => null, readMemberFeatures: async () => { throw new Error("must not read") } }),
    createLiteLlmEntraFeatureCheck({ loadActiveMember: async () => ({ userId: null }), readMemberFeatures: async () => { throw new Error("must not read") } }),
    createLiteLlmEntraFeatureCheck({ loadActiveMember: async () => ({ userId: createDenTypeId("user") }), readMemberFeatures: async () => { throw new Error("unavailable") } }),
    async () => { throw new Error("unavailable") },
  ]
  for (const featureEnabled of checks) {
    const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(apiScope), featureEnabled })
    assert.equal((await send()).status, 403)
    assert.equal(sent.length, 0)
  }
})

test("disabling Entra while credentials prepare stops the final dispatch", async () => {
  let enabled = true
  let reads = 0
  let credentialReads = 0
  const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: entraCredential(apiScope),
    featureEnabled: async () => { reads++; return enabled }, onCredentialRead: () => { if (++credentialReads === 3) enabled = false } })
  const response = await send()
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, "feature_disabled")
  assert.equal(reads, 4)
  assert.equal(sent.length, 0)
})

function discoveryRow(keySource: string | null, modelId: string, providerType = "litellm", mode: "org" | "member" = "member"): GatewayMemberAccessRow {
  const row = accessRow()
  const id = createDenTypeId("inferenceProvider")
  return {
    ...row,
    provider: { id, provider_id: providerType, name: providerType, litellmKeySource: keySource },
    grant: { ...row.grant, gateway_provider_id: id },
    group: { ...row.group, gateway_provider_id: id },
    credentialSet: { ...row.credentialSet, gateway_provider_id: id, credential_mode: mode },
    model: { id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: id, model_id: modelId, name: modelId, created_at: now,
      model_config: { id: modelId, name: modelId } },
  }
}

for (const path of [gatewayModelsPath, cursorModelsPath, claudeCodeModelsPath, codexModelsPath]) {
  test(`${path} hides retained Entra models while off or unavailable, without hiding existing modes`, async () => {
    const checks = [async () => false, async () => { throw new Error("feature storage unavailable") }, async () => true]
    for (const [index, check] of checks.entries()) {
      let featureReads = 0
      const { api, providerReads, sent } = app({ settings: liteLlmSettings("personal"), credential: entraCredential(apiScope),
        memberRows: [discoveryRow("entra", "retained-entra-model"), discoveryRow("personal", "existing-personal-model"),
          discoveryRow("issued", "existing-issued-model"), discoveryRow("personal", "existing-org-model", "litellm", "org"), discoveryRow("entra", "existing-foundry-model", "microsoft-foundry")],
        featureEnabled: async () => { featureReads++; return check() } })
      const response = await api.request(path)
      assert.equal(response.status, 200)
      const body = await response.text()
      if (index === 2) assert.match(body, /retained-entra-model/)
      else assert.doesNotMatch(body, /retained-entra-model/)
      for (const modelId of ["existing-personal-model", "existing-issued-model", "existing-org-model", "existing-foundry-model"]) assert.ok(body.includes(modelId), modelId)
      assert.equal(featureReads, 1)
      assert.equal(providerReads(), 0)
      assert.equal(sent.length, 0)
    }
  })

  test(`${path} does not read features or providers for ordinary discovery rows`, async () => {
    let featureReads = 0
    const { api, providerReads } = app({ settings: liteLlmSettings("personal"), credential: entraCredential(apiScope),
      memberRows: [discoveryRow("personal", "existing-model"), discoveryRow("entra", "existing-foundry-model", "microsoft-foundry")],
      featureEnabled: async () => { featureReads++; throw new Error("must not read") } })
    const response = await api.request(path)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /existing-model/)
    assert.equal(featureReads, 0)
    assert.equal(providerReads(), 0)
  })
}

test("disabling Entra during credential lookup stops renewal before its network call", async () => {
  let enabled = true
  let refreshes = 0
  const { sent, send } = app({ settings: liteLlmSettings("entra"), credential: { ...entraCredential(apiScope), expires_at: new Date(now.getTime() + 1_000) },
    featureEnabled: async () => enabled, onCredentialRead: () => { enabled = false },
    refreshMemberToken: async () => { refreshes++; return { kind: "auth_required" } } })
  assert.equal((await send()).status, 403)
  assert.equal(refreshes, 0)
  assert.equal(sent.length, 0)
})
