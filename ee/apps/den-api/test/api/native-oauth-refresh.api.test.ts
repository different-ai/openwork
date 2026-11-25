import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { after, before, beforeEach, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, startFakeHttpServer } from "./harness.js"

const den = await bootDen()
const { getValidAccessToken } = await import("../../src/capability-sources/generic-oauth.js")
const { disconnectAccount, getConnectedAccount, upsertConnectedAccount, upsertOrgOAuthClient } = await import("../../src/capability-sources/oauth-credentials.js")
const { getNativeOAuthProvider } = await import("../../src/capability-sources/provider-registry.js")

const originalRefresh = "fake-original-refresh"
const rotatedRefresh = "fake-rotated-refresh"
const freshAccess = "fake-fresh-access"
let currentRefresh: string | null
let tokenRequests: number
let unavailable: boolean
let pauseReply: (() => Promise<void>) | undefined
const endpoint = await startFakeHttpServer(async (request, body, response) => {
  if (request.method !== "POST" || request.url !== "/token") {
    response.writeHead(404).end()
    return
  }
  tokenRequests++
  const params = new URLSearchParams(body)
  const reply = (status: number, payload: object) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
  }
  if (params.get("grant_type") !== "refresh_token") {
    reply(400, { error: "unsupported_grant_type" })
    return
  }
  if (unavailable) {
    reply(503, { error: "temporarily_unavailable" })
    return
  }
  if (!currentRefresh || params.get("refresh_token") !== currentRefresh) {
    // Reuse invalidates the whole family, not just the submitted token.
    currentRefresh = null
    reply(400, { error: "invalid_grant" })
    return
  }
  currentRefresh = rotatedRefresh
  await pauseReply?.()
  if (!currentRefresh) {
    reply(400, { error: "invalid_grant" })
    return
  }
  reply(200, { access_token: freshAccess, refresh_token: rotatedRefresh, expires_in: 3600 })
})
after(async () => {
  await endpoint.close()
  await den.close()
})

const providerId = "google-workspace"
const provider = getNativeOAuthProvider(providerId)
assert.ok(provider)
const { orgId, owner } = await den.createOrg(await den.signUp("Refresh Test Owner"), "Native OAuth refresh test")
const accountKey = {
  organizationId: normalizeDenTypeId("organization", orgId),
  orgMembershipId: normalizeDenTypeId("member", owner.memberId),
  providerId,
}
const tokenInput = { ...accountKey, credentialProviderId: providerId, provider: { ...provider, tokenUrl: `${endpoint.url}/token` } }

before(async () => {
  await upsertOrgOAuthClient({ ...accountKey, clientId: "fake-client", createdByOrgMembershipId: accountKey.orgMembershipId })
})
beforeEach(async () => {
  currentRefresh = originalRefresh
  tokenRequests = 0
  unavailable = false
  pauseReply = undefined
  await upsertConnectedAccount({ ...accountKey, accessToken: "fake-expired-access", refreshToken: originalRefresh, tokenType: "Bearer", expiresAt: new Date(Date.now() - 120_000) })
})

test("concurrent native refreshes do not replay a rotating refresh token", async () => {
  // Keep the first provider response open while both callers read the expired row.
  pauseReply = () => delay(250)
  const results = await Promise.all([getValidAccessToken(tokenInput), getValidAccessToken(tokenInput)])
  assert.equal(tokenRequests, 1)
  assert.equal(currentRefresh, rotatedRefresh)
  for (const result of results) {
    assert.ok("accessToken" in result)
    assert.equal(result.accessToken, freshAccess)
  }
  const saved = await getConnectedAccount(accountKey)
  assert.equal(saved?.refreshToken, rotatedRefresh)
  assert.equal(saved?.tokenType, "Bearer")
})

test("a revoked grant is cleared and reports not connected", async () => {
  currentRefresh = null
  assert.deepEqual(await getValidAccessToken(tokenInput), { error: "not_connected" })
  const saved = await getConnectedAccount(accountKey)
  assert.equal(saved?.accessToken, null)
  assert.equal(saved.refreshToken, null)
  assert.equal(saved.expiresAt, null)
})

test("a temporary provider error leaves the account unchanged", async () => {
  unavailable = true
  const previous = await getConnectedAccount(accountKey)
  assert.ok(previous)
  await assert.rejects(getValidAccessToken(tokenInput), { code: "oauth_provider_unavailable" })
  assert.deepEqual(await getConnectedAccount(accountKey), previous)
})

test("disconnect during an in-flight refresh still deletes the account", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  pauseReply = () => {
    started.resolve()
    return release.promise
  }
  const refreshing = getValidAccessToken(tokenInput)
  await Promise.race([started.promise, refreshing])
  const disconnecting = disconnectAccount(accountKey)
  release.resolve()
  const [, disconnected] = await Promise.all([refreshing, disconnecting])
  assert.equal(disconnected, true)
  assert.equal(await getConnectedAccount(accountKey), null)
  assert.deepEqual(await getValidAccessToken(tokenInput), { error: "not_connected" })
  assert.equal(tokenRequests, 1)
})
