import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenDb, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable, GatewayKeyTable, GatewayModelGroupTable, GatewayCredentialSetTable, MemberTable } from "@openwork-ee/den-db"
import { eq } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createDbGoogleOauthRefreshStore, createGoogleOauthRefresher } from "../src/credentials/google-oauth-refresh.js"
import { createGatewayBearerKey, gatewayBearerKeyStorageDigest } from "@openwork-ee/utils/gateway-bearer-key"
import { matrixRow } from "./google-oauth-refresh-fixture.js"
import type { GatewayCredentialLookup } from "../src/provider-credentials.js"

const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL?.trim()
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"

test("scratch MySQL: fenced leases persist rotation, reject stale/revoked writes and stale client acquisition", { skip: !mysqlUrl, timeout: 60_000 }, async () => {
  assert.ok(mysqlUrl)
  const url = new URL(mysqlUrl)
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && /^\/(?:openwork_eval_|openwork_test_)/.test(url.pathname), "Refusing non-scratch database")
  const { db, client } = createDenDb({ databaseUrl: mysqlUrl, mode: "mysql" })
  const id = createDenTypeId("inferenceProviderCredential")
  const providerId = createDenTypeId("inferenceProvider")
  const memberId = createDenTypeId("member")
  const orgId = createDenTypeId("organization")
  const now = new Date()
  const entry = matrixRow()
  entry.group = { ...entry.group, id: createDenTypeId("gatewayModelGroup"), gateway_provider_id: providerId }
  entry.credentialSet = { ...entry.credentialSet, id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: providerId, oauth_client_id: "cid", oauth_client_secret: "cs" }
  entry.grant = { ...entry.grant, id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId,
    model_group_id: entry.group.id, credential_set_id: entry.credentialSet.id, org_membership_id: memberId, audience_key: `member:${memberId}` }
  entry.model = null
  const gatewayKeyId = createDenTypeId("gatewayKey")
  const authorization: GatewayCredentialLookup = {
    scope: { kind: "gateway", gatewayProviderId: providerId, organizationId: orgId, orgMembershipId: memberId, gatewayKeyId },
    selection: { row: entry, requestedModel: null, upstreamModel: null }, subject: memberId,
  }
  const provider = entry.credentialSet
  const scope = { credentialId: id, provider, subject: memberId, authorization }
  const table = GatewayProviderCredentialTable
  const store = createDbGoogleOauthRefreshStore(db)
  try {
    await db.insert(MemberTable).values({ id: memberId, organizationId: orgId, userId: createDenTypeId("user") })
    await db.insert(GatewayProviderTable).values({ id: providerId, organization_id: orgId, created_by_org_membership_id: memberId, provider_id: "google-vertex", name: "scratch", provider_config: {}, settings: {} })
    const key = createGatewayBearerKey()
    await db.insert(GatewayKeyTable).values({ id: gatewayKeyId, organization_id: orgId, org_membership_id: memberId, encrypted_key: key.value, key_hash: await gatewayBearerKeyStorageDigest(key), key_prefix: key.value.slice(0, 16) })
    await db.insert(GatewayModelGroupTable).values(entry.group)
    await db.insert(GatewayCredentialSetTable).values(entry.credentialSet)
    await db.insert(GatewayProviderAccessTable).values(entry.grant)
    await db.insert(table).values({ id, gateway_provider_id: providerId, credential_set_id: provider.id, organization_id: orgId, subject: memberId, org_membership_id: memberId, kind: "oauth_google", secret: '{"accessToken":"old","refreshToken":"rt-1"}', expires_at: new Date(now.getTime() - 1), status: "active" })
    const credential = await store.reloadCredential(scope)
    assert.ok(credential)
    const until = new Date(now.getTime() + 30_000)
    const locks = await Promise.all([1, 2].map(() => store.tryAcquireRefreshLock({ scope, credential, now, until })))
    const lock = locks.find((lock) => lock !== null)
    assert.ok(lock)
    assert.equal(locks.filter(Boolean).length, 1)
    assert.equal(await store.recordRefreshFailure({ lock, error: null, permanent: false, now }), true)
    const current = await store.reloadCredential(scope)
    assert.ok(current)
    const next = await store.tryAcquireRefreshLock({ scope, credential: current, now, until })
    assert.ok(next)
    assert.notEqual(next.credential.updated_at.getTime(), lock.credential.updated_at.getTime())
    assert.equal(await store.saveRefreshedToken({ lock, secret: "stale", expiresAt: now, now }), false)
    assert.equal(await store.recordRefreshFailure({ lock, error: "invalid_grant", permanent: true, now }), false)
    await store.recordRefreshFailure({ lock: next, error: null, permanent: false, now })
    let calls = 0
    const refresh = createGoogleOauthRefresher({ store, tokenFetch: async () => { calls++; return Response.json({ access_token: "new", refresh_token: "rt-2", expires_in: 3600 }) } })
    const input = { credential, token: { accessToken: "old", refreshToken: "rt-1" }, provider, subject: memberId, now, authorization }
    assert.equal((await refresh(input)).kind, "refreshed")
    assert.equal((await refresh(input)).kind, "refreshed")
    assert.equal(calls, 1)
    const saved = await store.reloadCredential(scope)
    assert.ok(saved)
    assert.deepEqual(JSON.parse(saved.secret), { accessToken: "new", refreshToken: "rt-2" })
    const revokeLock = await store.tryAcquireRefreshLock({ scope, credential: saved, now, until })
    assert.ok(revokeLock)
    // Preserve all timestamps and lock fields: a new ciphertext alone must fence
    // replacement, even when reauthorization returns identical plaintext.
    await db.update(table).set({ secret: saved.secret, updated_at: revokeLock.credential.updated_at }).where(eq(table.id, id))
    assert.equal(await store.saveRefreshedToken({ lock: revokeLock, secret: "same-tick-overwrite", expiresAt: now, now }), false)
    assert.equal(await store.recordRefreshFailure({ lock: revokeLock, error: "invalid_grant", permanent: true, now }), false)
    await db.update(table).set({ status: "revoked", refreshing_until: null }).where(eq(table.id, id))
    assert.equal(await store.saveRefreshedToken({ lock: revokeLock, secret: "resurrect", expiresAt: now, now }), false)
    assert.equal(await store.recordRefreshFailure({ lock: revokeLock, error: "invalid_grant", permanent: true, now }), false)
    assert.equal((await store.reloadCredential(scope))?.status, "revoked")
    await db.update(GatewayCredentialSetTable).set({ oauth_client_secret: "rotated" }).where(eq(GatewayCredentialSetTable.id, provider.id))
    assert.equal(await store.reloadCredential(scope), null)
  } finally {
    await db.delete(table).where(eq(table.id, id))
    await db.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, providerId))
    await db.delete(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, provider.id))
    await db.delete(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, entry.group.id))
    await db.delete(GatewayKeyTable).where(eq(GatewayKeyTable.id, gatewayKeyId))
    await db.delete(GatewayProviderTable).where(eq(GatewayProviderTable.id, providerId))
    await db.delete(MemberTable).where(eq(MemberTable.id, memberId))
    if ("end" in client) await client.end()
  }
})
