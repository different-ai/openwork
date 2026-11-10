/**
 * AI Gateway API keys for 3rd party tools (feature gatewayMemberApiKeys): an admin allows them in Settings,
 * members create, list and revoke their own keys, and admins see and revoke every key in the organization.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
const { gatewayBearerKey, gatewayBearerKeyLookupDigest } = await import("@openwork-ee/utils/gateway-bearer-key")

const { orgId, owner } = await den.createOrg(await den.signUp("Gia Owner"), "Gateway API keys org")
const member = await den.newMember(owner, orgId, "Max Member")
const other = await den.newMember(owner, orgId, "Ola Other")
const asOwner = den.as(owner, orgId)
const asMember = den.as(member, orgId)
const asOther = den.as(other, orgId)

const { orgId: otherOrgId, owner: otherOwner } = await den.createOrg(await den.signUp("Zed Elsewhere"), "Another org")
const asOtherOrgOwner = den.as(otherOwner, otherOrgId)

test("every route answers as if it did not exist while the feature is off", async () => {
  for (const [method, path] of [
    ["GET", "/v1/org/ai-gateway-settings"],
    ["GET", "/v1/org/ai-gateway/api-keys/mine"],
    ["GET", "/v1/org/ai-gateway/api-keys"],
  ] as const) {
    const call = await asOwner(method, path)
    assert.equal(call.status, 404, `${method} ${path}: ${summary(call)}`)
    assert.equal(field(call.body, "error"), "feature_disabled")
  }
  assert.equal((await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Claude Code" })).status, 404)
})

test("member keys are off until someone who can edit organization settings turns them on", async () => {
  assert.equal((await den.setFeature(orgId, "gatewayMemberApiKeys", true)).status, 200)

  const read = await asMember("GET", "/v1/org/ai-gateway-settings")
  assert.equal(read.status, 200, summary(read))
  assert.deepEqual(field(read.body, "settings"), { memberApiKeys: false })

  const mine = await asMember("GET", "/v1/org/ai-gateway/api-keys/mine")
  assert.equal(mine.status, 200, summary(mine))
  assert.equal(field(mine.body, "enabled"), false)
  assert.match(String(field(mine.body, "baseUrl")), /\/api\/v1$/)

  const refused = await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Claude Code" })
  assert.equal(refused.status, 409, summary(refused))
  assert.equal(field(refused.body, "error"), "member_api_keys_disabled")

  assert.equal((await asMember("PUT", "/v1/org/ai-gateway-settings", { memberApiKeys: true })).status, 403)
  assert.equal((await asOwner("PUT", "/v1/org/ai-gateway-settings", {})).status, 400)
  const saved = await asOwner("PUT", "/v1/org/ai-gateway-settings", { memberApiKeys: true })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings"), { memberApiKeys: true })
})

test("a member creates a key that is shown once and stored only as a digest", async () => {
  const created = await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "  Claude Code  " })
  assert.equal(created.status, 201, summary(created))
  const key = String(field(created.body, "key"))
  assert.match(key, /^ow_gw_/)
  assert.equal(field(created.body, "apiKey", "name"), "Claude Code")
  assert.equal(field(created.body, "apiKey", "prefix"), key.slice(0, 16))
  assert.equal(field(created.body, "apiKey", "lastUsedAt"), null)

  const [rows] = await client.execute("SELECT key_hash, key_prefix, org_membership_id FROM gateway_api_keys WHERE id = ?", [field(created.body, "apiKey", "id")]) as unknown as [Array<{ key_hash: string; key_prefix: string; org_membership_id: string }>]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.org_membership_id, member.memberId)
  assert.equal(rows[0]?.key_hash, await gatewayBearerKeyLookupDigest(gatewayBearerKey(key)))
  assert.ok(!JSON.stringify(rows).includes(key), "the key itself is never stored")

  const mine = await asMember("GET", "/v1/org/ai-gateway/api-keys/mine")
  assert.equal(field(mine.body, "enabled"), true)
  const keys = list(field(mine.body, "apiKeys"))
  assert.deepEqual(keys.map((entry) => entry.name), ["Claude Code"])
  assert.ok(!mine.text.includes(key), "listing never returns the key")

  assert.equal(list(field((await asOther("GET", "/v1/org/ai-gateway/api-keys/mine")).body, "apiKeys")).length, 0, "other members do not see it")
})

test("a key can expire: the expiry is returned, must be in the future, and never expires when left out", async () => {
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const expiring = await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Expiring", expiresAt })
  assert.equal(expiring.status, 201, summary(expiring))
  assert.equal(field(expiring.body, "apiKey", "expiresAt"), expiresAt)
  const past = await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Past", expiresAt: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(past.status, 400, summary(past))
  assert.equal((await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Bad", expiresAt: "next week" })).status, 400)
  const listed = list(field((await asMember("GET", "/v1/org/ai-gateway/api-keys/mine")).body, "apiKeys"))
  assert.equal(listed.find((entry) => entry.name === "Expiring")?.expiresAt, expiresAt)
  assert.equal(listed.find((entry) => entry.name === "Claude Code")?.expiresAt, null, "no expiry given: never expires")
  await asMember("DELETE", `/v1/org/ai-gateway/api-keys/mine/${String(field(expiring.body, "apiKey", "id"))}`)
})

test("names are required and bounded", async () => {
  assert.equal((await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "   " })).status, 400)
  assert.equal((await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "x".repeat(65) })).status, 400)
})

test("admins see every key with its member; members cannot list the organization's keys", async () => {
  await asOther("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Cursor" })
  assert.equal((await asMember("GET", "/v1/org/ai-gateway/api-keys")).status, 403)
  const all = await asOwner("GET", "/v1/org/ai-gateway/api-keys")
  assert.equal(all.status, 200, summary(all))
  const keys = list(field(all.body, "apiKeys"))
  assert.deepEqual(keys.map((entry) => [entry.name, field(entry, "member", "email")]).sort(), [["Claude Code", member.email], ["Cursor", other.email]])
  assert.ok(!all.text.includes("key_hash"))
})

test("a member revokes only their own keys; admins revoke anyone's", async () => {
  const otherKeyId = String(list(field((await asOther("GET", "/v1/org/ai-gateway/api-keys/mine")).body, "apiKeys"))[0]?.id)
  const memberKeyId = String(list(field((await asMember("GET", "/v1/org/ai-gateway/api-keys/mine")).body, "apiKeys"))[0]?.id)

  assert.equal((await asMember("DELETE", `/v1/org/ai-gateway/api-keys/mine/${otherKeyId}`)).status, 404, "not someone else's key")
  assert.equal((await asMember("DELETE", `/v1/org/ai-gateway/api-keys/${otherKeyId}`)).status, 403)
  assert.equal((await asOtherOrgOwner("DELETE", `/v1/org/ai-gateway/api-keys/${otherKeyId}`)).status, 404, "another organization cannot reach it")

  assert.equal((await asMember("DELETE", `/v1/org/ai-gateway/api-keys/mine/${memberKeyId}`)).status, 204)
  assert.equal((await asMember("DELETE", `/v1/org/ai-gateway/api-keys/mine/${memberKeyId}`)).status, 404, "already revoked")
  assert.equal(list(field((await asMember("GET", "/v1/org/ai-gateway/api-keys/mine")).body, "apiKeys")).length, 0)

  const revoked = await asOwner("DELETE", `/v1/org/ai-gateway/api-keys/${otherKeyId}`)
  assert.equal(revoked.status, 204, summary(revoked))
  const [rows] = await client.execute("SELECT status, revoked_by_org_membership_id FROM gateway_api_keys WHERE id = ?", [otherKeyId]) as unknown as [Array<{ status: string; revoked_by_org_membership_id: string }>]
  assert.deepEqual(rows[0], { status: "revoked", revoked_by_org_membership_id: owner.memberId })
  assert.equal(list(field((await asOwner("GET", "/v1/org/ai-gateway/api-keys")).body, "apiKeys")).length, 0)
})

test("members can still list and revoke keys after the setting is turned off", async () => {
  const created = await asMember("POST", "/v1/org/ai-gateway/api-keys/mine", { name: "Codex" })
  assert.equal(created.status, 201, summary(created))
  assert.equal((await asOwner("PUT", "/v1/org/ai-gateway-settings", { memberApiKeys: false })).status, 200)
  const mine = await asMember("GET", "/v1/org/ai-gateway/api-keys/mine")
  assert.equal(field(mine.body, "enabled"), false)
  assert.equal(list(field(mine.body, "apiKeys")).length, 1)
  assert.equal((await asMember("DELETE", `/v1/org/ai-gateway/api-keys/mine/${String(field(created.body, "apiKey", "id"))}`)).status, 204)
})
