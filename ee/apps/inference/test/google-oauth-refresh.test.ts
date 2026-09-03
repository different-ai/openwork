import assert from "node:assert/strict"
import { test } from "node:test"
import { createGoogleOauthRefresher, needsGoogleOauthRefresh } from "../src/credentials/google-oauth-refresh.js"
import type { GoogleOauthRefreshStore, OauthCredentialRow } from "../src/credentials/google-oauth-refresh.js"

const now = new Date("2026-09-03T12:00:00Z")
const provider = { oauth_client_id: "client-id", oauth_client_secret: "client-secret" }

function row(overrides: Partial<OauthCredentialRow> = {}): OauthCredentialRow {
  return {
    id: "ipc_test",
    kind: "oauth_google",
    secret: JSON.stringify({ accessToken: "old", refreshToken: "rt-1" }),
    expires_at: new Date(now.getTime() + 30_000),
    status: "active",
    ...overrides,
  }
}

// In-memory store mirroring the SQL lock semantics.
function memoryStore(initial: OauthCredentialRow) {
  const state: { row: OauthCredentialRow; refreshingUntil: Date | null; lastError: string | null; lastRefreshedAt: Date | null } = {
    row: initial,
    refreshingUntil: null,
    lastError: null,
    lastRefreshedAt: null,
  }
  const calls: string[] = []
  const store: GoogleOauthRefreshStore = {
    async tryAcquireRefreshLock(input) {
      calls.push("lock")
      if (state.refreshingUntil !== null && state.refreshingUntil.getTime() >= input.now.getTime()) return false
      state.refreshingUntil = input.until
      return true
    },
    async reloadCredential() {
      calls.push("reload")
      return state.row
    },
    async saveRefreshedToken(input) {
      calls.push("save")
      state.row = { ...state.row, secret: input.secret, expires_at: input.expiresAt, status: "active" }
      state.refreshingUntil = null
      state.lastError = null
      state.lastRefreshedAt = input.now
    },
    async recordRefreshFailure(input) {
      calls.push(input.permanent ? "fail:permanent" : "fail:transient")
      state.refreshingUntil = null
      state.lastError = input.error
      if (input.permanent) state.row = { ...state.row, status: "refresh_failed" }
    },
  }
  return { store, state, calls }
}

function tokenEndpoint(handler: (params: URLSearchParams) => Response) {
  const requests: URLSearchParams[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(input.toString(), "https://oauth2.googleapis.com/token")
    assert.ok(init?.body instanceof URLSearchParams)
    requests.push(init.body)
    return handler(init.body)
  }
  return { fetchImpl, requests }
}

test("needsGoogleOauthRefresh: within 60s of expiry (or past) with a refresh token", () => {
  const token = { accessToken: "a", refreshToken: "r" }
  assert.equal(needsGoogleOauthRefresh({ expires_at: new Date(now.getTime() + 61_000) }, token, now), false)
  assert.equal(needsGoogleOauthRefresh({ expires_at: new Date(now.getTime() + 60_000) }, token, now), true)
  assert.equal(needsGoogleOauthRefresh({ expires_at: new Date(now.getTime() - 1) }, token, now), true)
  assert.equal(needsGoogleOauthRefresh({ expires_at: null }, token, now), false)
  assert.equal(needsGoogleOauthRefresh({ expires_at: new Date(now.getTime() - 1) }, { accessToken: "a" }, now), false)
})

test("refresh: acquires the lock, posts refresh_token grant, stores new secret keeping the refresh token", async () => {
  const { store, state, calls } = memoryStore(row())
  const endpoint = tokenEndpoint(() => Response.json({ access_token: "new-access", expires_in: 3599, token_type: "Bearer" }))
  const refresh = createGoogleOauthRefresher({ fetch: endpoint.fetchImpl, store })
  const outcome = await refresh({ credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now })

  assert.equal(outcome.kind, "refreshed")
  assert.ok(outcome.kind === "refreshed")
  assert.deepEqual(JSON.parse(outcome.credential.secret), { accessToken: "new-access", refreshToken: "rt-1", tokenType: "Bearer" })
  assert.equal(outcome.credential.expires_at?.toISOString(), new Date(now.getTime() + 3599_000).toISOString())
  assert.equal(outcome.credential.status, "active")
  assert.deepEqual(calls, ["lock", "save"])
  assert.equal(state.refreshingUntil, null)
  assert.equal(state.lastRefreshedAt?.toISOString(), now.toISOString())
  const params = endpoint.requests[0]
  assert.ok(params)
  assert.equal(params.get("grant_type"), "refresh_token")
  assert.equal(params.get("refresh_token"), "rt-1")
  assert.equal(params.get("client_id"), "client-id")
  assert.equal(params.get("client_secret"), "client-secret")
})

test("refresh: a rotated refresh_token from Google replaces the stored one", async () => {
  const { store } = memoryStore(row())
  const endpoint = tokenEndpoint(() => Response.json({ access_token: "new", expires_in: 3600, refresh_token: "rt-2" }))
  const refresh = createGoogleOauthRefresher({ fetch: endpoint.fetchImpl, store })
  const outcome = await refresh({ credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now })
  assert.ok(outcome.kind === "refreshed")
  assert.equal(JSON.parse(outcome.credential.secret).refreshToken, "rt-2")
})

test("refresh: invalid_grant → refresh_failed + last_error, lock cleared, auth_required", async () => {
  const { store, state, calls } = memoryStore(row())
  const endpoint = tokenEndpoint(() => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }))
  const refresh = createGoogleOauthRefresher({ fetch: endpoint.fetchImpl, store })
  const outcome = await refresh({ credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now })
  assert.deepEqual(outcome, { kind: "auth_required" })
  assert.deepEqual(calls, ["lock", "fail:permanent"])
  assert.equal(state.row.status, "refresh_failed")
  assert.equal(state.lastError, "invalid_grant: Token has been expired or revoked.")
  assert.equal(state.refreshingUntil, null)
})

test("refresh: transient endpoint failure → lock cleared, stale token used, status stays active", async () => {
  const { store, state, calls } = memoryStore(row())
  const refresh = createGoogleOauthRefresher({
    store,
    fetch: async () => {
      throw new Error("ECONNRESET")
    },
  })
  const outcome = await refresh({ credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now })
  assert.deepEqual(outcome, { kind: "stale" })
  assert.deepEqual(calls, ["lock", "fail:transient"])
  assert.equal(state.row.status, "active")
  assert.equal(state.refreshingUntil, null)
  assert.match(state.lastError ?? "", /ECONNRESET/)
})

test("refresh: lock contention — the second caller waits and picks up the first caller's result", async () => {
  const { store, calls } = memoryStore(row())
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const endpoint = tokenEndpoint(() => Response.json({ access_token: "shared-new", expires_in: 3600 }))
  const refresh = createGoogleOauthRefresher({
    store,
    // The first caller's token request blocks on `gate`; the second caller's
    // poll-sleep opens it and yields so the first caller can finish.
    fetch: async (input, init) => {
      await gate
      return endpoint.fetchImpl(input, init)
    },
    sleep: async () => {
      release?.()
      await new Promise((resolve) => setImmediate(resolve))
    },
    pollMs: 100,
    waitMs: 500,
  })
  const input = { credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now }
  const first = refresh(input)
  await new Promise((resolve) => setImmediate(resolve))
  const second = refresh(input)
  const [a, b] = await Promise.all([first, second])
  assert.ok(a.kind === "refreshed" && b.kind === "refreshed")
  assert.equal(JSON.parse(a.credential.secret).accessToken, "shared-new")
  assert.equal(JSON.parse(b.credential.secret).accessToken, "shared-new")
  assert.equal(endpoint.requests.length, 1)
  assert.deepEqual(calls, ["lock", "lock", "save", "reload"])
})

test("refresh: lock contention that never resolves → stale after the wait budget", async () => {
  const { store, state } = memoryStore(row())
  state.refreshingUntil = new Date(now.getTime() + 30_000)
  let sleeps = 0
  const refresh = createGoogleOauthRefresher({
    store,
    fetch: async () => {
      throw new Error("must not be called")
    },
    sleep: async () => {
      sleeps += 1
    },
    pollMs: 250,
    waitMs: 1000,
  })
  const outcome = await refresh({ credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now })
  assert.deepEqual(outcome, { kind: "stale" })
  assert.equal(sleeps, 4)
})

test("refresh: contention where the holder ends in refresh_failed → auth_required", async () => {
  const { store, state } = memoryStore(row({ status: "refresh_failed" }))
  state.refreshingUntil = new Date(now.getTime() + 30_000)
  const refresh = createGoogleOauthRefresher({ store, fetch: async () => Response.json({}), sleep: async () => {} })
  const outcome = await refresh({ credential: row(), token: { accessToken: "old", refreshToken: "rt-1" }, provider, now })
  assert.deepEqual(outcome, { kind: "auth_required" })
})

test("refresh: provider without an OAuth client cannot refresh → stale, no lock taken", async () => {
  const { store, calls } = memoryStore(row())
  const refresh = createGoogleOauthRefresher({ store, fetch: async () => Response.json({}) })
  const outcome = await refresh({
    credential: row(),
    token: { accessToken: "old", refreshToken: "rt-1" },
    provider: { oauth_client_id: null, oauth_client_secret: null },
    now,
  })
  assert.deepEqual(outcome, { kind: "stale" })
  assert.deepEqual(calls, [])
})
