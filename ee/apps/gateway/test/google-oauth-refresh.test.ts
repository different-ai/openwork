import assert from "node:assert/strict"
import { test } from "node:test"
import { createGoogleOauthRefresher, needsGoogleOauthRefresh } from "../src/credentials/google-oauth-refresh.js"
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
    return Response.json({ access_token: "new", expires_in: 3600, ...(rotated ? { refresh_token: "rt-2" } : {}) })
  } })
  const outcome = await refresh(refreshInput())
  assert.equal(outcome.kind, "refreshed")
  assert.deepEqual(JSON.parse(state.row!.secret), { accessToken: "new", refreshToken: rotated ? "rt-2" : "rt-1" })
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

test("database failures are redacted retry outcomes rather than authentication failures", async () => {
  const { store } = memoryStore()
  store.reloadCredential = async () => { throw new Error("SQL parameters: SECRET_MARKER") }
  let calls = 0
  const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return Response.json({}) } })
  assert.deepEqual(await refresh(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
  assert.equal(calls, 0)
})
