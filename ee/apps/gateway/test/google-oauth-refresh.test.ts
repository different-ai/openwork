import assert from "node:assert/strict"
import { test } from "node:test"
import { createGoogleOauthRefresher, GOOGLE_OAUTH_MAX_EXPIRES_IN_SECONDS, needsGoogleOauthRefresh } from "../src/credentials/google-oauth-refresh.js"
import { memoryStore, now, refreshInput, row } from "./google-oauth-refresh-fixture.js"

test("refresh window requires a refresh token and expiry within 60 seconds", () => {
  for (const [ms, expected] of [[61_000, false], [60_000, true], [-1, true]]) {
    assert.equal(needsGoogleOauthRefresh({ expires_at: new Date(now.getTime() + Number(ms)) }, { accessToken: "a", refreshToken: "r" }, now), expected)
  }
  assert.equal(needsGoogleOauthRefresh({ expires_at: null }, { accessToken: "a", refreshToken: "r" }, now), false)
  assert.equal(needsGoogleOauthRefresh(row(), { accessToken: "a" }, now), false)
})

for (const rotated of [true, false]) test(`refresh persists tokens with rotation=${rotated}`, async () => {
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token")
    assert.equal(init?.redirect, "error")
    assert.ok(init?.body instanceof URLSearchParams)
    assert.equal(init.body.get("refresh_token"), "rt-1")
    return Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, ...(rotated ? { refresh_token: "rt-2" } : {}) })
  } })
  const outcome = await refresh(refreshInput())
  assert.equal(outcome.kind, "refreshed")
  assert.deepEqual(JSON.parse(state.row!.secret), { accessToken: "new", refreshToken: rotated ? "rt-2" : "rt-1", tokenType: "Bearer" })
  assert.equal(state.row?.refreshing_until, null)
  assert.equal(state.saves, 1)
})

test("invalid_grant is permanent and descriptions are redacted", async () => {
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => Response.json({ error: "invalid_grant", error_description: "SECRET" }, { status: 400 }) })
  assert.deepEqual(await refresh(refreshInput()), { kind: "auth_required" })
  assert.equal(state.lastError, "invalid_grant")
  assert.equal(state.row?.status, "refresh_failed")
})

test("transient errors retry without sending expired tokens or prompting reauth", async () => {
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { throw new Error("SECRET") } })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(state.lastError, "token_endpoint_unavailable")
  assert.equal(state.row?.status, "active")
})

test("an unchanged lock timeout produces a structured retry", async () => {
  const { store } = memoryStore(row({ refreshing_until: new Date(now.getTime() + 30_000) }))
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { throw new Error("Must not call") }, sleep: async () => {}, waitMs: 1, pollMs: 1 })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_busy" })
})

const validTokenResponse = { access_token: "new", token_type: "Bearer", expires_in: 3600 }

const invalidResponses: Array<{ name: string; fields: Record<string, unknown> }> = [
  ...[undefined, null, 0, -1, 0.5, 3600.5, Infinity, NaN, "3600", GOOGLE_OAUTH_MAX_EXPIRES_IN_SECONDS + 1].map((expires_in) => ({ name: `expiry ${String(expires_in)}`, fields: { expires_in } })),
  ...[undefined, null, "", "MAC", " Bearer"].map((token_type) => ({ name: `token type ${String(token_type)}`, fields: { token_type } })),
  ...[undefined, null, "", " ", "token\r\ninjection", "token\u0000injection"].map((access_token) => ({ name: `access token ${JSON.stringify(access_token)}`, fields: { access_token } })),
  ...[null, "", "openid email", 123, ["https://www.googleapis.com/auth/cloud-platform"]].map((scope) => ({ name: `scope ${JSON.stringify(scope)}`, fields: { scope } })),
  ...[null, "", " ", 123, "rt\u0000invalid", "rt\u001finvalid", "rt\u007finvalid", "rt\tinvalid", "rt\r\ninvalid", "rt\u0080invalid"].map((refresh_token) => ({ name: `refresh token ${JSON.stringify(refresh_token)}`, fields: { refresh_token } })),
]

for (const fixture of invalidResponses) test(`refresh rejects invalid ${fixture.name} without overwriting the durable grant`, async () => {
  const { store, state } = memoryStore()
  const original = state.row?.secret
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => Response.json({ ...validTokenResponse, ...fixture.fields, error_description: "SECRET_MARKER" }) })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(state.saves, 0)
  assert.equal(state.row?.secret, original)
  assert.equal(state.row?.status, "active")
  assert.equal(state.row?.refreshing_until, null)
  assert.equal(state.lastError, "invalid_token_response")
})

for (const expires_in of [1, 30, 60, 3601, GOOGLE_OAUTH_MAX_EXPIRES_IN_SECONDS]) test(`refresh accepts integer lifetime ${expires_in} within the defensive bound`, async () => {
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => Response.json({ ...validTokenResponse, expires_in }) })
  assert.equal((await refresh({ ...refreshInput(), clock: () => now })).kind, "refreshed")
  assert.equal(state.row?.expires_at?.getTime(), now.getTime() + expires_in * 1000)
  assert.equal(state.saves, 1)
})

for (const field of ["access_token", "refresh_token"]) test(`refresh rejects oversized ${field} without persisting token material`, async () => {
  const { store, state } = memoryStore()
  const original = state.row?.secret
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => Response.json({ ...validTokenResponse, [field]: "a".repeat(16_385) }) })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(state.row?.secret, original)
  assert.equal(state.lastError, "invalid_token_response")
  assert.equal(state.saves, 0)
})

for (const code of [0, 9, 10, 13, 31, 32, 127, 128]) test(`stored refresh material with character code ${code} is rejected before token exchange`, async () => {
  const original = row({ secret: JSON.stringify({ accessToken: "old", refreshToken: `rt${String.fromCharCode(code)}invalid` }) })
  const { store, state } = memoryStore(original)
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return Response.json(validTokenResponse) } })
  assert.deepEqual(await refresh(refreshInput(original)), { kind: "auth_required" })
  assert.equal(calls, 0)
  assert.equal(state.row?.status, "refresh_failed")
  assert.equal(state.lastError, "invalid_token_secret")
  assert.equal(state.saves, 0)
})

test("opaque printable ASCII refresh tokens retain punctuation and are form encoded", async () => {
  const refreshToken = "rt:opaque/with+punctuation=~!"
  const original = row({ secret: JSON.stringify({ accessToken: "old", refreshToken }) })
  const { store, state } = memoryStore(original)
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async (_url, init) => {
    assert.ok(init?.body instanceof URLSearchParams)
    assert.equal(new URLSearchParams(init.body.toString()).get("refresh_token"), refreshToken)
    return Response.json({ ...validTokenResponse, refresh_token: refreshToken })
  } })
  assert.equal((await refresh(refreshInput(original))).kind, "refreshed")
  assert.equal(JSON.parse(state.row!.secret).refreshToken, refreshToken)
})

for (const scope of [undefined, "https://www.googleapis.com/auth/cloud-platform", "openid email https://www.googleapis.com/auth/cloud-platform"]) test(`refresh accepts inherited or explicit cloud scope: ${scope ?? "omitted"}`, async () => {
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => Response.json({ ...validTokenResponse, token_type: "bEaReR", scope }) })
  assert.equal((await refresh(refreshInput())).kind, "refreshed")
  assert.equal(state.saves, 1)
  assert.equal(JSON.parse(state.row!.secret).tokenType, "Bearer")
})

for (const rotated of [true, false]) test(`refresh retains stored Google identity, not response metadata, with rotation=${rotated}`, async () => {
  const googleIdentity = { subject: "fixture-subject", email: "member@example.test", emailVerified: true, clientId: "fixture-client", authorizationRevision: "A".repeat(43) }
  const original = row({ secret: JSON.stringify({ accessToken: "old", refreshToken: "rt-1", googleIdentity }) })
  const { store, state } = memoryStore(original)
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => Response.json({ ...validTokenResponse,
    ...(rotated ? { refresh_token: "rt-2" } : {}), googleIdentity: { ...googleIdentity, authorizationRevision: "B".repeat(43) }, id_token: "UNTRUSTED_ID_TOKEN" }) })
  assert.equal((await refresh(refreshInput(original))).kind, "refreshed")
  assert.deepEqual(JSON.parse(state.row!.secret), { accessToken: "new", refreshToken: rotated ? "rt-2" : "rt-1", tokenType: "Bearer", googleIdentity })
})

for (const expires_at of [null, new Date(NaN)]) test(`refresh fails closed for ${expires_at === null ? "missing" : "invalid"} legacy expiry`, async () => {
  const original = row({ expires_at })
  const { store, state } = memoryStore(original)
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return Response.json(validTokenResponse) } })
  assert.deepEqual(await refresh(refreshInput(original)), { kind: "auth_required" })
  assert.equal(calls, 0)
  assert.equal(state.saves, 0)
  assert.equal(state.row?.refreshing_until, null)
})

for (const fixture of [
  { status: 400, error: "invalid_client", outcome: "configuration_required", storedError: "invalid_client", credentialStatus: "active" },
  { status: 401, error: "invalid_client", outcome: "configuration_required", storedError: "invalid_client", credentialStatus: "active" },
  { status: 400, error: "invalid_grant", error_subtype: "invalid_rapt", outcome: "auth_required", storedError: "invalid_rapt", credentialStatus: "refresh_failed" },
  { status: 429, error: "invalid_grant", outcome: "retry", storedError: "token_endpoint_unavailable", credentialStatus: "active" },
  { status: 503, error: "invalid_client", outcome: "retry", storedError: "token_endpoint_unavailable", credentialStatus: "active" },
  { status: 400, error: "UNKNOWN_SECRET_MARKER", outcome: "retry", storedError: "token_endpoint_unavailable", credentialStatus: "active" },
]) test(`refresh safely classifies ${fixture.status} ${fixture.error} ${fixture.error_subtype ?? ""}`, async () => {
  const { store, state } = memoryStore()
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => {
    calls++
    return Response.json({ error: fixture.error, error_subtype: fixture.error_subtype, error_description: "SECRET_MARKER" }, { status: fixture.status })
  } })
  const outcome = await refresh(refreshInput())
  assert.equal(outcome.kind, fixture.outcome)
  assert.equal(state.lastError, fixture.storedError)
  assert.equal(state.row?.status, fixture.credentialStatus)
  assert.equal(state.row?.refreshing_until, null)
  assert.equal(state.saves, 0)
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify([outcome, state.lastError]), /SECRET_MARKER/)
})

for (const mode of ["invalid_json", "timeout"]) test(`refresh ${mode} is transient and redacted`, async () => {
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => {
    if (mode === "timeout") throw new DOMException("SECRET_MARKER", "TimeoutError")
    return new Response("SECRET_MARKER", { status: 502 })
  } })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(state.lastError, "token_endpoint_unavailable")
  assert.equal(state.row?.status, "active")
})

test("current clock determines the lease and conservative token expiry, not stale request start", async () => {
  let currentTime = new Date(now.getTime() + 120_000)
  const requestedAt = currentTime.getTime()
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => {
    assert.equal(state.row?.refreshing_until?.getTime(), requestedAt + 30_000)
    currentTime = new Date(requestedAt + 5_000)
    return Response.json(validTokenResponse)
  } })
  assert.equal((await refresh({ ...refreshInput(), clock: () => currentTime })).kind, "refreshed")
  assert.equal(state.row?.expires_at?.getTime(), requestedAt + 3600_000)
  assert.equal(state.row?.last_refreshed_at?.getTime(), currentTime.getTime())
})

test("a lease that expires during the acquisition reread sends no refresh token", async () => {
  let currentTime = now
  const { store, state } = memoryStore()
  const acquire = store.tryAcquireRefreshLock
  store.tryAcquireRefreshLock = async (input) => {
    const lock = await acquire(input)
    currentTime = new Date(now.getTime() + 30_001)
    return lock
  }
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return Response.json(validTokenResponse) } })
  assert.deepEqual(await refresh({ ...refreshInput(), clock: () => currentTime }), { kind: "retry", reason: "refresh_busy" })
  assert.equal(calls, 0)
  assert.equal(state.saves, 0)
})

test("token expiry elapsed at the endpoint is rejected without inventing a fresh lifetime", async () => {
  let currentTime = now
  const { store, state } = memoryStore()
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => {
    currentTime = new Date(now.getTime() + 5_000)
    return Response.json({ ...validTokenResponse, expires_in: 1 })
  } })
  assert.deepEqual(await refresh({ ...refreshInput(), clock: () => currentTime }), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(state.saves, 0)
  assert.equal(state.lastError, "invalid_token_expiry")
})

test("database failures are redacted retry outcomes rather than authentication failures", async () => {
  const { store } = memoryStore()
  store.reloadCredential = async () => { throw new Error("SQL parameters: SECRET_MARKER") }
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return Response.json({}) } })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(calls, 0)
})
