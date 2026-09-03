// Refresh-lock semantics against a real MySQL database. Skipped unless
// DEN_DB_MYSQL_TEST_URL points at a database with the den-db schema applied.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenDb, InferenceProviderCredentialTable } from "@openwork-ee/den-db"
import { eq } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createDbGoogleOauthRefreshStore, createGoogleOauthRefresher } from "../src/credentials/google-oauth-refresh.js"

const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL?.trim()
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"

test("refresh lock: only one claimant wins until the row is released; refresh persists the new secret", { skip: !mysqlUrl, timeout: 60_000 }, async () => {
  assert.ok(mysqlUrl)
  const { db, client } = createDenDb({ databaseUrl: mysqlUrl, mode: "mysql" })
  const credentialId = createDenTypeId("inferenceProviderCredential")
  const now = new Date("2026-09-03T12:00:00.000Z")
  const table = InferenceProviderCredentialTable
  const store = createDbGoogleOauthRefreshStore(db)

  try {
    await db.insert(table).values({
      id: credentialId,
      inference_provider_id: createDenTypeId("inferenceProvider"),
      organization_id: createDenTypeId("organization"),
      subject: createDenTypeId("member"),
      org_membership_id: null,
      kind: "oauth_google",
      secret: JSON.stringify({ accessToken: "old", refreshToken: "rt-1" }),
      expires_at: new Date(now.getTime() + 30_000),
      status: "active",
    })

    const until = new Date(now.getTime() + 30_000)
    assert.equal(await store.tryAcquireRefreshLock({ credentialId, now, until }), true)
    assert.equal(await store.tryAcquireRefreshLock({ credentialId, now, until }), false)
    // An expired lock can be re-claimed.
    assert.equal(await store.tryAcquireRefreshLock({ credentialId, now: new Date(until.getTime() + 1000), until }), true)

    await store.recordRefreshFailure({ credentialId, error: "transient", permanent: false })
    let [row] = await db.select().from(table).where(eq(table.id, credentialId))
    assert.ok(row)
    assert.equal(row.refreshing_until, null)
    assert.equal(row.last_error, "transient")
    assert.equal(row.status, "active")

    // Full refresh through the refresher: lock → token endpoint → save.
    const refresh = createGoogleOauthRefresher({
      store,
      fetch: async () => Response.json({ access_token: "new-access", expires_in: 3600 }),
    })
    const outcome = await refresh({
      credential: { id: credentialId, kind: "oauth_google", secret: row.secret, expires_at: row.expires_at, status: "active" },
      token: { accessToken: "old", refreshToken: "rt-1" },
      provider: { oauth_client_id: "cid", oauth_client_secret: "cs" },
      now,
    })
    assert.equal(outcome.kind, "refreshed")
    ;[row] = await db.select().from(table).where(eq(table.id, credentialId))
    assert.ok(row)
    assert.deepEqual(JSON.parse(row.secret), { accessToken: "new-access", refreshToken: "rt-1" })
    assert.equal(row.expires_at?.getTime(), now.getTime() + 3600_000)
    assert.equal(row.last_refreshed_at?.getTime(), now.getTime())
    assert.equal(row.refreshing_until, null)
    assert.equal(row.last_error, null)
    const reloaded = await store.reloadCredential(credentialId)
    assert.equal(reloaded?.expires_at?.getTime(), now.getTime() + 3600_000)

    // invalid_grant marks the row refresh_failed.
    const failing = createGoogleOauthRefresher({ store, fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) })
    const failed = await failing({
      credential: { id: credentialId, kind: "oauth_google", secret: row.secret, expires_at: row.expires_at, status: "active" },
      token: { accessToken: "new-access", refreshToken: "rt-1" },
      provider: { oauth_client_id: "cid", oauth_client_secret: "cs" },
      now,
    })
    assert.deepEqual(failed, { kind: "auth_required" })
    ;[row] = await db.select().from(table).where(eq(table.id, credentialId))
    assert.equal(row?.status, "refresh_failed")
    assert.equal(row?.last_error, "invalid_grant")
    assert.equal(row?.refreshing_until, null)
  } finally {
    await db.delete(table).where(eq(table.id, credentialId))
    if ("end" in client) await client.end()
  }
})
