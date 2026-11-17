/**
 * LiteLLM with member Microsoft Entra sign-in (feature litellmEntraMemberSignIn): a proxy that accepts sign-in
 * tokens instead of LiteLLM keys. An admin stores an Entra app registration, one API scope and a model list; each
 * person signs in with Microsoft through the member sign-in flow Microsoft Foundry uses.
 *
 * Entra ID is a stand-in here: the token endpoint and the tenant's signing keys are answered by this file, so
 * these tests prove what OpenWork requests, stores and returns, not that a real tenant or a real LiteLLM proxy
 * accepts it. With the feature off, Microsoft Foundry sign-in and the key-based LiteLLM modes behave as before.
 */
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { after, test } from "node:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { bootDen, field, isRecord, list, startFakeHttpServer, strings, summary, text, type Call, type Member } from "./harness.js"

const FEATURE = "litellmEntraMemberSignIn"
const TENANT = "11111111-2222-4333-8444-555555555555"
const CLIENT = "66666666-7777-4888-8999-aaaaaaaaaaaa"
const CLIENT_SECRET = "entra-client-secret-fixture"
const API_SCOPE = `api://${CLIENT}/access`
const COGNITIVE_SIGN_IN = "https://cognitiveservices.azure.com/.default offline_access openid profile email"
const ACCESS_TOKEN = "entra-access-token-fixture"
const REFRESH_TOKEN = "entra-refresh-token-fixture"
const LITELLM_ADMIN_KEY = "sk-litellm-admin-fixture"
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`
const JWKS_URL = `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`

// A key-based LiteLLM proxy, for the modes that existed before.
const liteLlm = await startFakeHttpServer((request, _body, response) => {
  const path = (request.url ?? "/").split("?")[0]
  const body = path === "/v1/models" ? { data: [{ id: "gpt-fixture" }, { id: "claude-fixture" }] }
    : path === "/model_group/info" ? { data: [] }
      : path === "/team/list" ? []
        : path === "/key/info" ? { info: { team_id: null, user_id: null, models: [] } } : null
  response.statusCode = body === null ? 404 : 200
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body ?? { error: "not_found" }))
})

// The stand-in for Entra ID: one signing key, a token endpoint and the model catalog Den reads for Foundry.
const signing = await generateKeyPair("RS256")
const jwk = { ...(await exportJWK(signing.publicKey)), kid: "fixture-key", alg: "RS256", use: "sig" }
const tokenRequests: URLSearchParams[] = []
/** The `state` of the sign-in each test is completing, so the stand-in can answer with the nonce OpenWork expects. */
let signInState = ""
let grantedScope = API_SCOPE
let beforeTokenResponse: (() => Promise<void>) | undefined
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === "https://models.openworklabs.com/api.json") {
    return Response.json({ azure: { id: "azure", name: "Fixture Azure", npm: "@ai-sdk/azure", env: ["AZURE_API_KEY"], models: {
      "claude-fixture": { id: "claude-fixture", name: "Fixture Claude", limit: { context: 200000, output: 8000 },
        provider: { npm: "@ai-sdk/anthropic", api: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1" } },
    } } })
  }
  if (url === JWKS_URL) return Response.json({ keys: [jwk] })
  if (url === TOKEN_URL) {
    const body = new URLSearchParams(String(init?.body))
    tokenRequests.push(body)
    await beforeTokenResponse?.()
    const nonce = createHmac("sha256", body.get("code_verifier") ?? "").update(`gateway-microsoft-oidc-v1:${signInState}`).digest("base64url")
    const idToken = await new SignJWT({ tid: TENANT, oid: "object-id-fixture", nonce, preferred_username: "person@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" }).setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
      .setSubject("subject-fixture").setIssuedAt().setExpirationTime("5m").sign(signing.privateKey)
    return Response.json({ token_type: "Bearer", expires_in: 3600, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, id_token: idToken, scope: grantedScope })
  }
  return realFetch(input, init)
}

const den = await bootDen({ env: {
  GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:8791", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:8791",
  GATEWAY_EGRESS_ALLOWED_ORIGINS: liteLlm.url,
} })
after(async () => { globalThis.fetch = realFetch; await liteLlm.close(); await den.close() })

/** Everything Den answered, to prove no token or client secret is ever returned. */
const answered: string[] = []
function keep(call: Call): Call {
  answered.push(`${call.text}\n${[...call.headers].join("\n")}`)
  return call
}

const workspace = await den.createOrg(await den.signUp("Entra Owner"), "Entra workspace")
const owner = (...args: Parameters<ReturnType<typeof den.as>>) => den.as(workspace.owner, workspace.orgId)(...args).then(keep)
const person = await den.newMember(workspace.owner, workspace.orgId, "Entra Person")
const asPerson = (...args: Parameters<ReturnType<typeof den.as>>) => den.as(person, workspace.orgId)(...args).then(keep)

function entraProvider(overrides: Record<string, unknown> = {}) {
  return { name: "LiteLLM (Microsoft sign-in)", baseUrl: "https://litellm.example.com", mode: "entra", oauthTenantId: TENANT.toUpperCase(), oauthClientId: CLIENT, oauthClientSecret: CLIENT_SECRET,
    oauthScope: API_SCOPE, modelIds: ["gpt-fixture", "claude-fixture", "GPT-fixture", "openai/*"], allMembers: true, ...overrides }
}

/** The browser half of Connect, as the Den web connect page drives it with the person's session cookie. */
function browser(member: Member, path: string) {
  return den.request(null, "GET", path, { headers: { cookie: member.cookie, accept: "application/json" } }).then(keep)
}

async function startConnect(member: Member, providerId: string) {
  const started = keep(await den.as(member, workspace.orgId)("GET", `/v1/inference-providers/${providerId}/oauth/start`, undefined, { accept: "application/json" }))
  assert.equal(started.status, 200, summary(started))
  const attempt = new URL(text(field(started.body, "authUrl"), "connect page URL")).searchParams.get("attempt")
  return text(attempt, "attempt")
}

async function signIn(member: Member, providerId: string) {
  const attempt = await startConnect(member, providerId)
  const start = await browser(member, `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`)
  assert.equal(start.status, 200, summary(start))
  const authorize = new URL(text(field(start.body, "authUrl"), "authorize URL"))
  signInState = text(authorize.searchParams.get("state"), "state")
  const callback = await browser(member, `/v1/inference-providers/oauth/callback?code=fixture-code&state=${encodeURIComponent(signInState)}`)
  return { authorize, callback }
}

async function usable(member: Member, providerId: string) {
  const listed = keep(await den.as(member, workspace.orgId)("GET", "/v1/inference-providers"))
  assert.equal(listed.status, 200, summary(listed))
  return list(field(listed.body, "inferenceProviders")).find((provider) => provider.id === providerId)
}

let entraProviderId = ""

test("with the feature off, a LiteLLM provider cannot be added with Microsoft sign-in", async () => {
  const refused = await owner("POST", "/v1/inference-providers/litellm", entraProvider())
  assert.equal(refused.status, 403, summary(refused))
  assert.equal(field(refused.body, "error"), "feature_disabled")
  const providers = await owner("GET", "/v1/inference-providers?scope=manageable")
  assert.deepEqual(field(providers.body, "inferenceProviders"), [])
})

test("an admin adds the provider with an app registration, one API scope and a model list, and nothing is read from the proxy", async () => {
  assert.equal((await den.setFeature(workspace.orgId, FEATURE, true)).status, 200)

  // Scopes LiteLLM could never validate, and incomplete settings, are refused with what to enter instead.
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ oauthScope: "https://graph.microsoft.com/User.Read" }, "invalid_scope"],
    [{ oauthScope: "User.Read" }, "invalid_scope"],
    [{ oauthScope: "https://cognitiveservices.azure.com/.default" }, "invalid_scope"],
    [{ oauthScope: `api://${CLIENT}` }, "invalid_scope"],
    [{ oauthTenantId: "contoso.onmicrosoft.com" }, "invalid_tenant_id"],
    [{ modelIds: ["openai/*"] }, "model_required"],
  ]
  for (const [overrides, error] of invalid) {
    const refused = await owner("POST", "/v1/inference-providers/litellm", entraProvider(overrides))
    assert.equal(refused.status, 400, `${JSON.stringify(overrides)}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), error, summary(refused))
  }
  for (const missing of ["oauthTenantId", "oauthClientId", "oauthClientSecret", "oauthScope", "modelIds"]) {
    const refused = await owner("POST", "/v1/inference-providers/litellm", entraProvider({ [missing]: undefined }))
    assert.equal(refused.status, 400, `${missing}: ${summary(refused)}`)
  }
  // A LiteLLM key has no place in this mode.
  assert.equal((await owner("POST", "/v1/inference-providers/litellm", entraProvider({ apiKey: LITELLM_ADMIN_KEY }))).status, 400)

  const created = await owner("POST", "/v1/inference-providers/litellm", entraProvider())
  assert.equal(created.status, 201, summary(created))
  const provider = field(created.body, "inferenceProvider")
  entraProviderId = text(field(provider, "id"), "provider id")
  assert.equal(field(provider, "providerId"), "litellm")
  assert.equal(field(provider, "credentialMode"), "member")
  assert.deepEqual(field(created.body, "sync"), { modelCount: 2, groupCount: 1, teamCount: 0, members: { matched: 0, rejected: 0, unavailable: 0, removed: 0 }, warnings: [] })

  const status = field(provider, "litellm")
  assert.equal(field(status, "mode"), "member")
  assert.equal(field(status, "keySource"), "entra")
  assert.equal(field(status, "entraScope"), API_SCOPE)
  assert.equal(field(status, "hasSyncKey"), false)
  assert.equal(field(status, "spendTracking"), false)
  assert.equal(field(status, "modelCount"), 2)
  assert.equal(field(status, "lastSyncedAt"), null)

  // One member set holding the app registration; the secret is only ever reported as present.
  const sets = list(field(provider, "credentialSets"))
  assert.equal(sets.length, 1)
  assert.equal(sets[0]?.credentialMode, "member")
  assert.equal(sets[0]?.configured, true)
  assert.equal(sets[0]?.oauthTenantId, TENANT)
  assert.equal(sets[0]?.oauthClientId, CLIENT)
  assert.equal(sets[0]?.hasOauthClientSecret, true)
  assert.equal(field(provider, "oauthCallbackUrl"), "http://127.0.0.1:8790/v1/inference-providers/oauth/callback")

  // The admin's list is the catalog: case duplicates and wildcard routes are dropped.
  const groups = list(field(provider, "modelGroups"))
  assert.deepEqual(groups.map((group) => [group.name, strings(group.modelIds).sort()]), [["All LiteLLM models", ["claude-fixture", "gpt-fixture"]]])
  assert.deepEqual(list(field(provider, "accessGrants")).map((grant) => field(grant, "audience", "type")), ["organization"])
})

test("there is no key to sync with or to paste", async () => {
  const sync = await owner("POST", `/v1/inference-providers/${entraProviderId}/litellm/sync`)
  assert.equal(sync.status, 409, summary(sync))
  assert.equal(field(sync.body, "error"), "litellm_sync_unavailable")
  const key = await owner("PATCH", `/v1/inference-providers/${entraProviderId}/litellm`, { apiKey: LITELLM_ADMIN_KEY })
  assert.equal(key.status, 409, summary(key))
  assert.equal(field(key.body, "error"), "litellm_microsoft_sign_in")
  const pasted = await asPerson("PUT", `/v1/inference-providers/${entraProviderId}/litellm/member-key`, { apiKey: "sk-person-fixture" })
  assert.equal(pasted.status, 409, summary(pasted))
  assert.equal(field(pasted.body, "error"), "litellm_microsoft_sign_in")
  const attempt = await startConnect(person, entraProviderId)
  const browserKey = keep(await den.request(null, "POST", "/v1/inference-providers/oauth/browser-litellm-key", { headers: { cookie: person.cookie }, body: { attempt, apiKey: "sk-person-fixture" } }))
  assert.equal(browserKey.status, 409, summary(browserKey))
  assert.equal(field(browserKey.body, "error"), "litellm_microsoft_sign_in")
})

test("a person signs in with Microsoft for the configured API scope and gets the models", async () => {
  const before = await usable(person, entraProviderId)
  assert.equal(before?.credentialStatus, "member_auth_required")
  assert.deepEqual(before?.models, [])
  const request = list(before?.authorizationRequests)[0]
  assert.match(text(request?.authUrl, "authorization request URL"), new RegExp(`/v1/inference-providers/${entraProviderId}/oauth/start\\?credentialSetId=`))
  assert.equal(list(request?.models).length, 2)

  const attempt = await startConnect(person, entraProviderId)
  const status = await browser(person, `/v1/inference-providers/oauth/browser-status?attempt=${encodeURIComponent(attempt)}`)
  assert.equal(status.status, 200, summary(status))
  assert.equal(field(status.body, "status"), "ready")
  assert.equal(field(status.body, "method"), "microsoft")

  grantedScope = API_SCOPE
  tokenRequests.length = 0
  const { authorize, callback } = await signIn(person, entraProviderId)
  assert.equal(`${authorize.origin}${authorize.pathname}`, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`)
  assert.equal(authorize.searchParams.get("scope"), `${API_SCOPE} offline_access openid profile`)
  assert.equal(authorize.searchParams.get("client_id"), CLIENT)
  assert.equal(authorize.searchParams.get("response_type"), "code")
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:8790/v1/inference-providers/oauth/callback")
  assert.match(signInState, /^microsoft\.[A-Za-z0-9_-]{43}$/)

  assert.equal(callback.status, 200, summary(callback))
  assert.match(callback.text, /is connected to OpenWork/)
  // The code is exchanged at the tenant's token endpoint for the same scope, with the app registration's secret.
  assert.equal(tokenRequests.length, 1)
  assert.equal(tokenRequests[0]?.get("grant_type"), "authorization_code")
  assert.equal(tokenRequests[0]?.get("scope"), `${API_SCOPE} offline_access openid profile`)
  assert.equal(tokenRequests[0]?.get("client_id"), CLIENT)
  assert.equal(tokenRequests[0]?.get("client_secret"), CLIENT_SECRET)

  const after = await usable(person, entraProviderId)
  assert.equal(after?.credentialStatus, "ready")
  assert.deepEqual(list(after?.models).map((model) => model.upstreamModelId).sort(), ["claude-fixture", "gpt-fixture"])
  assert.deepEqual(after?.authorizationRequests, [])

  const connections = await asPerson("GET", "/v1/inference-providers/member-connections")
  const connection = list(field(connections.body, "connections")).find((entry) => entry.providerId === entraProviderId)
  assert.equal(connection?.signInMethod, "microsoft")
  assert.equal(connection?.ready, true)
  assert.equal(connection?.accountEmail, "person@example.test")

  // The admin sees that the person is connected, never their token.
  const details = await owner("GET", `/v1/inference-providers/${entraProviderId}`)
  const credentials = list(field(details.body, "inferenceProvider", "credentials"))
  assert.deepEqual(credentials.map((credential) => [credential.kind, credential.status, credential.orgMembershipId]), [["oauth_azure", "active", person.memberId]])
  assert.equal(field(details.body, "inferenceProvider", "litellm", "connectedMemberCount"), 1)
})

test("a sign-in answered for another API is not stored", async () => {
  const other = await den.newMember(workspace.owner, workspace.orgId, "Entra Other")
  grantedScope = "https://graph.microsoft.com/User.Read"
  const { callback } = await signIn(other, entraProviderId)
  grantedScope = API_SCOPE
  assert.equal(callback.status, 400, summary(callback))
  assert.equal((await usable(other, entraProviderId))?.credentialStatus, "member_auth_required")
})

test("an admin edits the model list and the sign-in settings; changing the scope signs everyone out", async () => {
  // A person who may only view providers sees no upstream configuration.
  const viewOnly = await asPerson("GET", `/v1/inference-providers/${entraProviderId}`)
  assert.ok(viewOnly.status === 403 || field(viewOnly.body, "inferenceProvider", "litellm", "entraScope") === undefined, summary(viewOnly))

  const models = await owner("PATCH", `/v1/inference-providers/${entraProviderId}/litellm`, { modelIds: ["gpt-fixture", "sonnet-fixture"] })
  assert.equal(models.status, 200, summary(models))
  assert.equal(field(models.body, "sync", "modelCount"), 2)
  assert.deepEqual(list(field(models.body, "inferenceProvider", "modelGroups")).map((group) => strings(group.modelIds).sort()), [["gpt-fixture", "sonnet-fixture"]])
  // Still signed in: a model list change is not a sign-in change.
  const listed = await usable(person, entraProviderId)
  assert.equal(listed?.credentialStatus, "ready")
  assert.deepEqual(list(listed?.models).map((model) => model.upstreamModelId).sort(), ["gpt-fixture", "sonnet-fixture"])

  const invalid: Array<[Record<string, unknown>, string]> = [[{ oauthScope: "https://graph.microsoft.com/.default" }, "invalid_scope"], [{ oauthTenantId: "not-a-tenant" }, "invalid_tenant_id"], [{ modelIds: ["*"] }, "model_required"]]
  for (const [body, error] of invalid) {
    const refused = await owner("PATCH", `/v1/inference-providers/${entraProviderId}/litellm`, body)
    assert.equal(refused.status, 400, summary(refused))
    assert.equal(field(refused.body, "error"), error)
  }

  // The app registration and scope belong to the LiteLLM route; the generic credential-set route only renames or disables.
  const setId = text(list(field(models.body, "inferenceProvider", "credentialSets"))[0]?.id, "set id")
  const generic = await owner("PATCH", `/v1/inference-providers/${entraProviderId}/credential-sets/${setId}`, { oauthClientSecret: "another-secret-fixture" })
  assert.equal(generic.status, 400, summary(generic))
  assert.equal(field(generic.body, "error"), "litellm_entra_managed")
  assert.equal((await owner("PATCH", `/v1/inference-providers/${entraProviderId}/credential-sets/${setId}`, { name: "Microsoft sign-in (production)" })).status, 200)
  assert.equal((await usable(person, entraProviderId))?.credentialStatus, "ready")

  const rescoped = await owner("PATCH", `/v1/inference-providers/${entraProviderId}/litellm`, { oauthScope: `api://${CLIENT}/models` })
  assert.equal(rescoped.status, 200, summary(rescoped))
  assert.equal(field(rescoped.body, "inferenceProvider", "litellm", "entraScope"), `api://${CLIENT}/models`)
  assert.deepEqual(list(field(rescoped.body, "inferenceProvider", "credentials")).map((credential) => credential.status), ["revoked"])
  const signedOut = await usable(person, entraProviderId)
  assert.equal(signedOut?.credentialStatus, "member_auth_required")
  assert.deepEqual(signedOut?.models, [])

  // Signing in again requests the new scope.
  grantedScope = `api://${CLIENT}/models`
  const { authorize, callback } = await signIn(person, entraProviderId)
  grantedScope = API_SCOPE
  assert.equal(authorize.searchParams.get("scope"), `api://${CLIENT}/models offline_access openid profile`)
  assert.equal(callback.status, 200, summary(callback))
  assert.equal((await usable(person, entraProviderId))?.credentialStatus, "ready")
})

test("sign-in cannot be transferred between members or redirected to an untrusted site", async () => {
  const attempt = await startConnect(person, entraProviderId)
  const mismatch = await browser(workspace.owner, `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`)
  assert.equal(mismatch.status, 403, summary(mismatch))
  assert.equal(field(mismatch.body, "error"), "browser_account_mismatch")
  const redirected = await asPerson("GET", `/v1/inference-providers/${entraProviderId}/oauth/start?redirectTo=${encodeURIComponent("https://untrusted.example.test/return")}`)
  assert.equal(redirected.status, 400, summary(redirected))
  assert.equal(field(redirected.body, "error"), "invalid_redirect")
  assert.equal((await asPerson("POST", "/v1/inference-providers/litellm", entraProvider())).status, 403)
  assert.equal((await asPerson("PATCH", `/v1/inference-providers/${entraProviderId}/litellm`, { oauthClientSecret: "unauthorized-secret-fixture" })).status, 403)
})

test("changing each app registration setting revokes tokens and cancels an in-flight exchange", async () => {
  const changes = [
    { oauthTenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { oauthClientId: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff" },
    { oauthClientSecret: "rotated-client-secret-fixture" },
    { oauthScope: `api://${CLIENT}/revised` },
  ]
  for (const change of changes) {
    const created = await owner("POST", "/v1/inference-providers/litellm", entraProvider())
    assert.equal(created.status, 201, summary(created))
    const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
    grantedScope = API_SCOPE
    assert.equal((await signIn(person, providerId)).callback.status, 200)
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    beforeTokenResponse = async () => { entered.resolve(); await released.promise }
    const pending = signIn(person, providerId)
    try {
      await entered.promise
      const changed = await owner("PATCH", `/v1/inference-providers/${providerId}/litellm`, change)
      assert.equal(changed.status, 200, summary(changed))
      assert.deepEqual(list(field(changed.body, "inferenceProvider", "credentials")).map((credential) => credential.status), ["revoked"])
    } finally {
      released.resolve()
    }
    try {
      const { callback } = await pending
      assert.equal(callback.status, 400, summary(callback))
      assert.equal((await usable(person, providerId))?.credentialStatus, "member_auth_required")
    } finally {
      beforeTokenResponse = undefined
    }
  }
})

test("turning the feature off stops new sign-ins and edits, and keeps what people already have", async () => {
  const attempt = await startConnect(person, entraProviderId)
  assert.equal((await den.setFeature(workspace.orgId, FEATURE, false)).status, 200)

  const status = await browser(person, `/v1/inference-providers/oauth/browser-status?attempt=${encodeURIComponent(attempt)}`)
  assert.equal(status.status, 403, summary(status))
  assert.equal(field(status.body, "error"), "feature_disabled")
  assert.match(text(field(status.body, "message"), "message"), /turned off/)
  const start = await browser(person, `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`)
  assert.equal(start.status, 403, summary(start))
  assert.equal(field(start.body, "error"), "feature_disabled")
  assert.equal(field(start.body, "authUrl"), undefined)

  const edit = await owner("PATCH", `/v1/inference-providers/${entraProviderId}/litellm`, { modelIds: ["gpt-fixture"] })
  assert.equal(edit.status, 403, summary(edit))
  assert.equal(field(edit.body, "error"), "feature_disabled")

  // People who signed in keep their models, and the provider can still be read and its access managed.
  assert.equal((await usable(person, entraProviderId))?.credentialStatus, "ready")
  const details = await owner("GET", `/v1/inference-providers/${entraProviderId}`)
  assert.equal(details.status, 200, summary(details))
  assert.equal(field(details.body, "inferenceProvider", "litellm", "keySource"), "entra")

  // Back on: the attempt that was refused continues to Microsoft.
  assert.equal((await den.setFeature(workspace.orgId, FEATURE, true)).status, 200)
  const again = await browser(person, `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`)
  assert.equal(again.status, 200, summary(again))
  assert.equal(new URL(text(field(again.body, "authUrl"), "authorize URL")).searchParams.get("scope"), `api://${CLIENT}/models offline_access openid profile`)
})

test("turning the feature off during the token exchange prevents storing the sign-in", async () => {
  const connecting = await den.newMember(workspace.owner, workspace.orgId, "Connecting member")
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  beforeTokenResponse = async () => { entered.resolve(); await released.promise }
  grantedScope = `api://${CLIENT}/models`
  const pending = signIn(connecting, entraProviderId)
  try {
    await entered.promise
    assert.equal((await den.setFeature(workspace.orgId, FEATURE, false)).status, 200)
  } finally {
    released.resolve()
  }
  try {
    const { callback } = await pending
    assert.equal(callback.status, 400, summary(callback))
    assert.match(callback.text, /Provider access changed/)
    assert.equal((await usable(connecting, entraProviderId))?.credentialStatus, "member_auth_required")
    const details = await owner("GET", `/v1/inference-providers/${entraProviderId}`)
    assert.equal(list(field(details.body, "inferenceProvider", "credentials")).some((credential) => credential.orgMembershipId === connecting.memberId), false)
  } finally {
    beforeTokenResponse = undefined
    grantedScope = API_SCOPE
    assert.equal((await den.setFeature(workspace.orgId, FEATURE, true)).status, 200)
  }
})

test("with the feature off, a person can still disconnect and an admin can still disable and remove the provider", async () => {
  assert.equal((await den.setFeature(workspace.orgId, FEATURE, false)).status, 200)
  const disconnected = await asPerson("DELETE", `/v1/inference-providers/${entraProviderId}/oauth`)
  assert.equal(disconnected.status, 204, summary(disconnected))
  assert.equal((await usable(person, entraProviderId))?.credentialStatus, "member_auth_required")

  const disabled = await owner("PATCH", `/v1/inference-providers/${entraProviderId}`, { status: "disabled" })
  assert.equal(disabled.status, 200, summary(disabled))
  assert.equal(await usable(person, entraProviderId), undefined)
  const removed = await owner("DELETE", `/v1/inference-providers/${entraProviderId}`)
  assert.equal(removed.status, 204, summary(removed))
  assert.equal((await owner("GET", `/v1/inference-providers/${entraProviderId}`)).status, 404)
})

for (const enabled of [false, true]) {
  test(`with the feature ${enabled ? "on" : "off"}, a key-based LiteLLM provider and Microsoft Foundry sign-in work as before`, async () => {
    const org = await den.createOrg(await den.signUp(`Existing Owner ${enabled ? "On" : "Off"}`), `Existing ${enabled ? "on" : "off"}`)
    assert.equal((await den.setFeature(org.orgId, FEATURE, enabled)).status, 200)
    const admin = (...args: Parameters<ReturnType<typeof den.as>>) => den.as(org.owner, org.orgId)(...args).then(keep)
    const connect = async (providerId: string) => {
      const started = await admin("GET", `/v1/inference-providers/${providerId}/oauth/start`, undefined, { accept: "application/json" })
      assert.equal(started.status, 200, summary(started))
      return text(new URL(text(field(started.body, "authUrl"), "connect page URL")).searchParams.get("attempt"), "attempt")
    }

    // LiteLLM, each person's own key: synced from the proxy with the admin key, connected by pasting a key.
    const personal = await admin("POST", "/v1/inference-providers/litellm", { baseUrl: liteLlm.url, mode: "member", apiKey: LITELLM_ADMIN_KEY, allMembers: true })
    assert.equal(personal.status, 201, summary(personal))
    const personalId = text(field(personal.body, "inferenceProvider", "id"), "provider id")
    const status = field(personal.body, "inferenceProvider", "litellm")
    assert.equal(field(status, "keySource"), "personal")
    assert.equal(field(status, "hasSyncKey"), true)
    assert.ok(isRecord(status))
    assert.deepEqual(Object.keys(status).sort(), ["attention", "attentionCount", "baseUrl", "connectedMemberCount", "hasSyncKey", "issueStrategy", "issuedMemberCount", "keySource", "lastSyncError", "lastSyncedAt", "mirrorFallback", "mode", "modelCount", "spendTracking", "teamCount"])
    const personalAttempt = await connect(personalId)
    const personalStatus = await browser(org.owner, `/v1/inference-providers/oauth/browser-status?attempt=${encodeURIComponent(personalAttempt)}`)
    assert.equal(field(personalStatus.body, "method"), "litellm_key", summary(personalStatus))
    const personalStart = await browser(org.owner, `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(personalAttempt)}`)
    assert.equal(personalStart.status, 400, summary(personalStart))
    assert.equal(field(personalStart.body, "error"), "litellm_key_required")
    // Its sets take no Microsoft sign-in settings, and it has none of that mode's settings to change.
    const personalSetId = text(list(field(personal.body, "inferenceProvider", "credentialSets"))[0]?.id, "set id")
    const oauthOnKeySet = await admin("PATCH", `/v1/inference-providers/${personalId}/credential-sets/${personalSetId}`, { oauthClientId: CLIENT, oauthClientSecret: CLIENT_SECRET })
    assert.equal(field(oauthOnKeySet.body, "error"), "unsupported_oauth_client", summary(oauthOnKeySet))
    const entraOnKeyProvider = await admin("PATCH", `/v1/inference-providers/${personalId}/litellm`, { oauthScope: API_SCOPE })
    assert.equal(entraOnKeyProvider.status, 409, summary(entraOnKeyProvider))
    assert.equal(field(entraOnKeyProvider.body, "error"), "litellm_not_entra")
    assert.equal((await admin("POST", `/v1/inference-providers/${personalId}/litellm/sync`)).status, 200)

    // Microsoft Foundry: the same sign-in flow, for Azure Cognitive Services.
    const foundry = await admin("POST", "/v1/inference-providers", { name: "Foundry", providerId: "microsoft-foundry", modelIds: ["claude-fixture"], settings: { resourceName: "acme-foundry" },
      credentialMode: "member", oauthTenantId: TENANT, oauthClientId: CLIENT, oauthClientSecret: CLIENT_SECRET, allMembers: true })
    assert.equal(foundry.status, 201, summary(foundry))
    const foundryId = text(field(foundry.body, "inferenceProvider", "id"), "provider id")
    const foundryAttempt = await connect(foundryId)
    const foundryStatus = await browser(org.owner, `/v1/inference-providers/oauth/browser-status?attempt=${encodeURIComponent(foundryAttempt)}`)
    assert.equal(field(foundryStatus.body, "method"), "microsoft", summary(foundryStatus))
    const foundryStart = await browser(org.owner, `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(foundryAttempt)}`)
    assert.equal(foundryStart.status, 200, summary(foundryStart))
    const authorize = new URL(text(field(foundryStart.body, "authUrl"), "authorize URL"))
    assert.equal(authorize.searchParams.get("scope"), COGNITIVE_SIGN_IN)

    signInState = text(authorize.searchParams.get("state"), "state")
    grantedScope = "https://cognitiveservices.azure.com/user_impersonation https://cognitiveservices.azure.com/.default"
    tokenRequests.length = 0
    const callback = await browser(org.owner, `/v1/inference-providers/oauth/callback?code=fixture-code&state=${encodeURIComponent(signInState)}`)
    grantedScope = API_SCOPE
    assert.equal(callback.status, 200, summary(callback))
    assert.equal(tokenRequests[0]?.get("scope"), COGNITIVE_SIGN_IN)
    const listed = await admin("GET", "/v1/inference-providers")
    assert.equal(list(field(listed.body, "inferenceProviders")).find((provider) => provider.id === foundryId)?.credentialStatus, "ready")
  })
}

test("no API response carries a token or the client secret", () => {
  const everything = answered.join("\n")
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, LITELLM_ADMIN_KEY, "another-secret-fixture"]) {
    assert.equal(everything.includes(secret), false, `${secret} was returned`)
  }
  assert.ok(answered.length > 40)
})
