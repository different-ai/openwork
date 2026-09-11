import { createHash, generateKeyPairSync } from "node:crypto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createGoogleOauthRefresher, sameOauthVersion } from "../src/credentials/google-oauth-refresh.js"
import { createGcpServiceAccountTokenMinter, GCP_TOKEN_CACHE_LIMIT } from "../src/credentials/gcp-service-account.js"
import { signAwsRequest } from "../src/credentials/aws-sigv4.js"
import { pickApiKeyFromMap, resolveUpstreamCredential, type GatewayCredential } from "../src/provider-credentials.js"
import { authorization, credentialSet, deferred, memoryStore, now, provider, refreshInput, row } from "./google-oauth-refresh-fixture.js"

// Offline state-machine witnesses. SQL serialization is separately covered by
// the opt-in scratch-MySQL suite; this spec does not claim real database proof.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const serviceAccount = {
  client_email: "fixture@project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
}
const tokenResponse = () => Response.json({ access_token: "winner", refresh_token: "rotated", expires_in: 3600 })

test("two concurrent callers share the winner and a delayed stale caller never refreshes the obsolete token", async () => {
  const { store, state } = memoryStore()
  const entered = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async (_url, init) => {
    calls++
    assert.ok(String(init?.body).includes("refresh_token=rt-1"))
    entered.resolve()
    await release.promise
    return tokenResponse()
  }, pollMs: 1, waitMs: 1000 })
  const first = refresh(refreshInput())
  await entered.promise
  const second = refresh(refreshInput())
  release.resolve()
  const outcomes = await Promise.all([first, second])
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["refreshed", "refreshed"])
  const delayed = await refresh(refreshInput())
  assert.ok(delayed.kind === "refreshed")
  assert.equal(delayed.credential.secret, state.row?.secret)
  assert.deepEqual(JSON.parse(state.row!.secret), { accessToken: "winner", refreshToken: "rotated" })
  assert.equal(calls, 1)
  assert.equal(state.saves, 1)
  assert.equal(state.failures, 0)
})

for (const result of ["success", "invalid_grant", "transient"]) {
  for (const change of ["revoke", "client_rotation", "replacement", "delete"]) {
    test(`${result} arriving after ${change} never resurrects or overwrites the credential`, async () => {
      const { store, state } = memoryStore()
      const entered = deferred<void>()
      const release = deferred<void>()
      const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => {
        entered.resolve()
        await release.promise
        if (result === "transient") throw new Error("SECRET_MARKER")
        return result === "success" ? tokenResponse() : Response.json({ error: "invalid_grant", error_description: "SECRET_MARKER" }, { status: 400 })
      } })
      const pending = refresh(refreshInput())
      await entered.promise
      if (change === "delete") state.row = null
      else if (change === "replacement") state.row = row({ secret: JSON.stringify({ accessToken: "replacement", refreshToken: "replacement-refresh" }), expires_at: new Date(now.getTime() + 3600_000) })
      else {
        state.row = row({ status: "revoked" })
        if (change === "client_rotation") state.client = { ...credentialSet, oauth_client_secret: "new-client-secret" }
      }
      const snapshot = JSON.stringify(state.row)
      release.resolve()
      const outcome = await pending
      assert.equal(outcome.kind, change === "replacement" ? "refreshed" : "auth_required")
      assert.equal(JSON.stringify(state.row), snapshot)
      assert.equal(state.saves, 0)
      assert.equal(state.failures, 0)
      assert.equal(state.lastError, null)
    })
  }
}

test("post-acquisition reread rejects a changed row without an external request", async () => {
  const { store, state } = memoryStore()
  const acquire = store.tryAcquireRefreshLock
  store.tryAcquireRefreshLock = async (input) => {
    const lock = await acquire(input)
    state.row = row({ status: "revoked" })
    return lock
  }
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return tokenResponse() } })
  assert.deepEqual(await refresh(refreshInput()), { kind: "auth_required" })
  assert.equal(calls, 0)
  assert.equal(state.saves, 0)
})

test("a winner appearing before acquisition is reused without refreshing the loser's token", async () => {
  const { store, state } = memoryStore()
  const acquire = store.tryAcquireRefreshLock
  store.tryAcquireRefreshLock = async (input) => {
    state.row = row({ secret: '{"accessToken":"fresh-winner","refreshToken":"fresh-refresh"}', expires_at: new Date(now.getTime() + 3600_000) })
    return acquire(input)
  }
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return tokenResponse() } })
  const outcome = await refresh(refreshInput())
  assert.ok(outcome.kind === "refreshed")
  assert.equal(outcome.credential.secret, state.row?.secret)
  assert.equal(calls, 0)
  assert.equal(state.failures, 0)
})

test("a reacquired lease rejects both old success and old failure even with the same caller clock", async () => {
  const { store, state } = memoryStore()
  const scope = { credentialId: row().id, provider: credentialSet, subject: row().subject, authorization: authorization() }
  const first = await store.tryAcquireRefreshLock({ scope, credential: row(), now, until: new Date(now.getTime() + 30_000) })
  assert.ok(first)
  assert.equal(await store.recordRefreshFailure({ lock: first, error: null, permanent: false, now }), true)
  const second = await store.tryAcquireRefreshLock({ scope, credential: state.row!, now, until: new Date(now.getTime() + 30_000) })
  assert.ok(second)
  assert.equal(sameOauthVersion(first.credential, second.credential), false)
  assert.equal(await store.saveRefreshedToken({ lock: first, secret: "obsolete", expiresAt: now, now }), false)
  assert.equal(await store.recordRefreshFailure({ lock: first, error: "invalid_grant", permanent: true, now }), false)
  assert.equal(state.row?.status, "active")
  assert.equal(state.row?.secret, row().secret)
  const afterExpiry = new Date(now.getTime() + 31_000)
  assert.equal(await store.saveRefreshedToken({ lock: second, secret: "expired-owner", expiresAt: afterExpiry, now: afterExpiry }), false)
  assert.equal(await store.recordRefreshFailure({ lock: second, error: "invalid_grant", permanent: true, now: afterExpiry }), false)
  assert.equal(state.row?.status, "active")
})

test("wrong provider or member and missing/revoked rows cannot acquire or send tokens", async () => {
  for (const change of ["provider", "member", "missing", "revoked"]) {
    const { store, state } = memoryStore()
    if (change === "missing") state.row = null
    if (change === "revoked") state.row = row({ status: "revoked" })
    let calls = 0
    const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return tokenResponse() } })
    const input = refreshInput()
    if (change === "provider") input.provider = { ...credentialSet, id: "gcs_other" }
    if (change === "member") input.subject = "om_other"
    assert.deepEqual(await refresh(input), { kind: "auth_required" })
    assert.equal(calls, 0)
    assert.equal(state.saves, 0)
  }
})

test("same plaintext replacement within a timestamp tick still fences an in-flight refresh", async () => {
  const { store, state } = memoryStore()
  const entered = deferred<void>()
  const release = deferred<void>()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { entered.resolve(); await release.promise; return tokenResponse() } })
  const pending = refresh(refreshInput())
  await entered.promise
  assert.ok(state.row)
  const locked = structuredClone(state.row)
  state.row.secret_revision = "new-ciphertext-same-plaintext"
  assert.equal(sameOauthVersion(locked, state.row), false)
  release.resolve()
  assert.deepEqual(await pending, { kind: "retry", reason: "credential_changed" })
  assert.equal(state.saves, 0)
  assert.equal(state.row.secret, row().secret)
})

test("expired tokens on contention and transient outages yield retry, never credentials or reauth", async () => {
  for (const busy of [true, false]) {
    const { store, state } = memoryStore(row({ refreshing_until: busy ? new Date(now.getTime() + 30_000) : null }))
    const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { throw new Error("SECRET_MARKER") }, sleep: async () => {}, pollMs: 1, waitMs: 1 })
    const result = await resolveUpstreamCredential({ provider, ...authorization(), envNames: [], loadProviderCredential: async () => state.row, refreshGoogleOauthToken: refresh, now })
    assert.deepEqual(result, { kind: "retry", credentialId: row().id, reason: busy ? "refresh_busy" : "refresh_unavailable" })
    assert.equal(state.row?.status, "active")
    assert.ok(!(JSON.stringify(result) + state.lastError).includes("SECRET_MARKER"))
  }
})

test("service-account assertions are refused for private and public attacker token endpoints", async () => {
  let calls = 0
  const mint = createGcpServiceAccountTokenMinter({ tokenFetch: async () => { calls++; return tokenResponse() } })
  for (const token_uri of ["http://127.0.0.1/token", "https://attacker.example/token", "https://oauth2.googleapis.com.attacker.example/token", "https://oauth2.googleapis.com/token?redirect=attacker", "https://oauth2.googleapis.com/token#fragment", "https://user@oauth2.googleapis.com/token", "https://oauth2.googleapis.com:444/token"]) {
    assert.deepEqual(await mint({ credentialId: "ipc_test", serviceAccount: { ...serviceAccount, token_uri }, now }), { kind: "error", message: "service account token_uri is not permitted" })
  }
  assert.equal(calls, 0)
})

test("service-account cache and in-flight deduplication are isolated by secret revision and bounded", async () => {
  let calls = 0
  const release = deferred<void>()
  const mint = createGcpServiceAccountTokenMinter({ tokenFetch: async () => { const id = ++calls; await release.promise; return Response.json({ access_token: `mint-${id}`, expires_in: 3600 }) } })
  const input = { credentialId: "ipc_test", serviceAccount, now }
  const first = mint(input)
  const shared = mint(input)
  const rotatedKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const rotated = mint({ ...input, serviceAccount: { ...serviceAccount, private_key: rotatedKey } })
  assert.equal(calls, 2)
  release.resolve()
  assert.deepEqual(await first, { kind: "token", accessToken: "mint-1" })
  assert.deepEqual(await shared, { kind: "token", accessToken: "mint-1" })
  assert.deepEqual(await rotated, { kind: "token", accessToken: "mint-2" })
  for (let i = 0; i < GCP_TOKEN_CACHE_LIMIT; i++) await mint({ ...input, credentialId: `ipc_${i}` })
  assert.equal((await mint(input)).kind, "token")
  assert.equal(calls, GCP_TOKEN_CACHE_LIMIT + 3)
})

test("service-account in-flight work is bounded and failures do not poison the cache or expose secrets", async () => {
  const release = deferred<void>()
  let calls = 0
  const mint = createGcpServiceAccountTokenMinter({ tokenFetch: async () => { calls++; await release.promise; throw new Error("SECRET_MARKER") } })
  const pending = Array.from({ length: GCP_TOKEN_CACHE_LIMIT }, (_, i) => mint({ credentialId: `ipc_${i}`, serviceAccount, now }))
  assert.deepEqual(await mint({ credentialId: "ipc_overflow", serviceAccount, now }), { kind: "error", message: "token mint capacity exceeded; retry later" })
  assert.equal(calls, GCP_TOKEN_CACHE_LIMIT)
  release.resolve()
  const results = await Promise.all(pending)
  assert.equal(results.every((result) => result.kind === "error"), true)
  assert.ok(!JSON.stringify(results).includes("SECRET_MARKER"))
  await mint({ credentialId: "ipc_0", serviceAccount, now })
  assert.equal(calls, GCP_TOKEN_CACHE_LIMIT + 1)
})

test("provider compatibility is enforced before minting; settings are never guessed as tokens", async () => {
  let calls = 0
  const credential: GatewayCredential = { id: "ipc_sa", kind: "gcp_service_account", secret: JSON.stringify(serviceAccount), status: "active", expires_at: null }
  const access = authorization()
  access.selection.row.credentialSet.credential_mode = "org"
  const result = await resolveUpstreamCredential({ provider: { ...provider, provider_id: "openai" }, ...access, envNames: [], loadProviderCredential: async () => credential, mintGcpAccessToken: async () => { calls++; return { kind: "token", accessToken: "must-not-leak" } }, now })
  assert.equal(result.kind, "invalid_secret")
  assert.equal(calls, 0)
  assert.equal(pickApiKeyFromMap({ GOOGLE_VERTEX_PROJECT: "secret-project" }, ["GOOGLE_VERTEX_PROJECT"]), null)
  assert.equal(pickApiKeyFromMap({ AWS_SECRET_ACCESS_KEY: "not-a-bearer" }, ["AWS_SECRET_ACCESS_KEY"]), null)
  assert.equal(pickApiKeyFromMap({ RANDOM_TOKEN: "not-explicit" }, ["RANDOM_TOKEN"]), null)
  assert.equal(pickApiKeyFromMap({ AZURE_RESOURCE_NAME: "resource", AZURE_API_KEY: "key" }, ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"]), "key")
})

for (const change of ["revoke", "rotate"]) test(`service-account ${change} during mint prevents returning stale access`, async () => {
  let credential: GatewayCredential = { id: "ipc_sa", kind: "gcp_service_account", secret: JSON.stringify(serviceAccount), status: "active", expires_at: null }
  const release = deferred<void>()
  const entered = deferred<void>()
  const access = authorization()
  access.selection.row.credentialSet.credential_mode = "org"
  const input = { provider, ...access, envNames: [], loadProviderCredential: async () => credential, now }
  const pending = resolveUpstreamCredential({ ...input, mintGcpAccessToken: async () => { entered.resolve(); await release.promise; return { kind: "token", accessToken: "old-mint" } } })
  await entered.promise
  credential = change === "revoke" ? { ...credential, status: "revoked" } : { ...credential, secret: JSON.stringify({ ...serviceAccount, client_email: "new@example.com" }) }
  release.resolve()
  const result = await pending
  assert.equal(result.kind, "retry")
  assert.ok(!JSON.stringify(result).includes("old-mint"))
  let calls = 0
  if (change === "revoke") {
    assert.equal((await resolveUpstreamCredential({ ...input, mintGcpAccessToken: async () => { calls++; return { kind: "token", accessToken: "cached" } } })).kind, "org_credential_missing")
    assert.equal(calls, 0)
  }
})

test("SigV4 hashes raw binary views and ArrayBuffers and preserves canonical encoded query/path semantics", () => {
  const bytes = new Uint8Array([255, 254, 0, 128])
  const backing = new Uint8Array([1, ...bytes, 2])
  for (const body of [bytes.buffer, backing.subarray(1, -1)]) {
    const result = signAwsRequest({ method: "POST", url: new URL("https://bedrock-runtime.us-east-1.amazonaws.com/a//b/../model/x%3A0?x=2&x=1&q=%2B&q=+"), headers: new Headers(), body,
      credentials: { accessKeyId: "AKID", secretAccessKey: "test-secret" }, region: "us-east-1", service: "bedrock", now })
    const lines = result.canonicalRequest.split("\n")
    assert.equal(lines[1], "/a/model/x%253A0")
    assert.equal(lines[2], "q=%20&q=%2B&x=1&x=2")
    assert.equal(lines.at(-1), createHash("sha256").update(bytes).digest("hex"))
    assert.notEqual(lines.at(-1), createHash("sha256").update(new TextDecoder().decode(bytes)).digest("hex"))
  }
})
