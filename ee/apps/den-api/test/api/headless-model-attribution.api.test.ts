/** Headless credentials carry only the current, opted-in member's authoritative identity. */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, summary, text, type Call, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const CALLBACK_TOKEN = `callback-${randomBytes(24).toString("hex")}`
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: CALLBACK_TOKEN } })
after(async () => { restoreFetch(); await den.close() })

let orgId = ""
let member: Member
let peer: Member
const tokens = new Map<string, string>()
let turn = 0

before(async () => {
  const created = await den.createOrg(await den.signUp("Attribution Owner"), "Headless attribution org")
  orgId = created.orgId
  member = await den.newMember(created.owner, orgId, "Attribution Member")
  peer = await den.newMember(created.owner, orgId, "Attribution Peer")
  await grantGatewayModels(den, created.owner, orgId, [member, peer])
  const enabled = await den.setFeature(orgId, "workbot", true)
  assert.equal(enabled.status, 200, summary(enabled))
  for (const person of [member, peer]) tokens.set(person.memberId, await den.mintMcpToken(person, orgId))
})

async function setAttribution(enabled: boolean) {
  const saved = await den.setFeature(orgId, "headlessModelAttribution", enabled)
  assert.equal(saved.status, 200, summary(saved))
}

async function setMemberAttribution(person: Member, enabled: boolean | null) {
  const saved = await den.asPlatformAdmin("PUT", `/v1/admin/organizations/${orgId}/members/${person.memberId}/capabilities`, {
    capabilities: { headlessModelAttribution: enabled },
  })
  assert.equal(saved.status, 200, summary(saved))
}

async function runToken(person: Member) {
  const token = tokens.get(person.memberId)
  assert.ok(token)
  const ids = { sessionId: `hs_attribution_test_${++turn}`, messageId: `msg-${turn}` }
  const minted = await den.request(token, "POST", "/v1/workbot/run-token", { body: ids })
  assert.equal(minted.status, 200, summary(minted))
  text(field(minted.body, "token"), "headless MCP token")
  const grant = text(field(minted.body, "resumeGrant"), "resume grant")
  return { minted, grant, ...ids }
}

async function exchange(turn: { grant: string; sessionId: string; messageId: string }) {
  const fresh = await den.request(null, "POST", "/v1/headless/resume-token", {
    headers: { authorization: `Bearer ${CALLBACK_TOKEN}` },
    body: { grant: turn.grant, sessionId: turn.sessionId, messageId: turn.messageId },
  })
  assert.equal(fresh.status, 200, summary(fresh))
  const token = text(field(fresh.body, "mcpToken"), "fresh headless MCP token")
  return { fresh, token }
}

function assertIdentity(call: Call, person: Member, email = person.email) {
  assert.deepEqual(field(call.body, "modelAttribution"), {
    memberId: person.memberId,
    userId: person.userId,
    organizationId: orgId,
    email,
  }, "identity comes from this authenticated member, not the org owner or another member")
}

function assertNoIdentity(call: Call) {
  assert.equal(field(call.body, "modelAttribution"), undefined, "disabled attribution is omitted entirely")
}

test("attribution off omits identity from Workbot issuance and resume exchange", async () => {
  await setAttribution(false)
  for (const person of [member, peer]) {
    const issued = await runToken(person)
    assertNoIdentity(issued.minted)
    assertNoIdentity((await exchange(issued)).fresh)
  }
})

test("attribution on issues each active member's own identity through Workbot and resume", async () => {
  await setAttribution(true)
  for (const person of [member, peer]) {
    const issued = await runToken(person)
    assertIdentity(issued.minted, person)
    const { fresh, token } = await exchange(issued)
    assertIdentity(fresh, person)
    assert.notEqual(token, field(issued.minted.body, "token"), "resume mints a new MCP token")
  }
})

test("resume exchange reloads current identity rather than replaying issuance metadata", async () => {
  await setAttribution(true)
  const issued = await runToken(member)
  assertIdentity(issued.minted, member)
  const changedEmail = `updated-attribution+${den.stamp}@example.test`
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("API test requires isolated MySQL")
  // ARRANGE ONLY: a profile change after the original turn was authorized.
  await client.execute("UPDATE user SET email = ? WHERE id = ?", [changedEmail, member.userId])
  try {
    const first = await exchange(issued)
    assertIdentity(first.fresh, member, changedEmail)
    const second = await exchange(issued)
    assertIdentity(second.fresh, member, changedEmail)
    assert.notEqual(first.token, field(issued.minted.body, "token"))
    assert.notEqual(second.token, first.token, "each exchange issues fresh credentials")
  } finally {
    await client.execute("UPDATE user SET email = ? WHERE id = ?", [member.email, member.userId])
  }
})

test("turning attribution off clears identity from existing grants and new turns", async () => {
  await setAttribution(true)
  const issued = await runToken(member)
  assertIdentity(issued.minted, member)
  assertIdentity((await exchange(issued)).fresh, member)
  await setAttribution(false)
  assertNoIdentity((await exchange(issued)).fresh)
  const next = await runToken(member)
  assertNoIdentity(next.minted)
  assertNoIdentity((await exchange(next)).fresh)
})

test("member overrides apply to issuance and an existing grant without leaking to peers", async () => {
  await setAttribution(false)
  const issued = await runToken(member)
  assertNoIdentity(issued.minted)
  await setMemberAttribution(member, true)
  try {
    assertIdentity((await runToken(member)).minted, member)
    assertIdentity((await exchange(issued)).fresh, member)
    const other = await runToken(peer)
    assertNoIdentity(other.minted)
    assertNoIdentity((await exchange(other)).fresh)

    await setAttribution(true)
    await setMemberAttribution(member, false)
    assertNoIdentity((await runToken(member)).minted)
    assertNoIdentity((await exchange(issued)).fresh)
    const inherited = await runToken(peer)
    assertIdentity(inherited.minted, peer)
    assertIdentity((await exchange(inherited)).fresh, peer)

    await setMemberAttribution(member, null)
    assertIdentity((await exchange(issued)).fresh, member)
  } finally {
    await setMemberAttribution(member, null)
    await setAttribution(false)
  }
})
