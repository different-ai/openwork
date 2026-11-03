import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Invitation fixtures require the disposable MySQL harness")
const verify = (userId: string) => client.execute("UPDATE user SET email_verified = true WHERE id = ?", [userId])
const org = await den.createOrg(await den.signUp("Invite Owner"), "Inviting workspace")

test("a person invited before signing up sees the invitation and joins through it", async () => {
  const email = `invited-first+${den.stamp}@example.test`
  const invited = await den.request(org.owner.token, "POST", "/v1/invitations", { orgId: org.orgId, body: { email: email.toUpperCase(), role: "member" } })
  assert.ok(invited.status < 300, summary(invited))
  const person = await den.signUp("Invited First", email)
  await verify(person.userId)

  const pending = await den.request(person.token, "GET", "/v1/me/invitations")
  assert.equal(pending.status, 200, summary(pending))
  const [invitation] = list(field(pending.body, "invitations"))
  assert.equal(field(invitation, "organization", "id"), org.orgId)
  assert.equal(field(invitation, "organization", "name"), "Inviting workspace")
  assert.equal(field(invitation, "role"), "member")

  const accepted = await den.request(person.token, "POST", "/v1/orgs/invitations/accept", { body: { id: text(field(invitation, "id"), "invitation id") } })
  assert.equal(accepted.status, 200, summary(accepted))
  const orgs = await den.request(person.token, "GET", "/v1/me/orgs")
  assert.deepEqual(list(field(orgs.body, "orgs")).map((entry) => entry.id), [org.orgId])
  const remaining = await den.request(person.token, "GET", "/v1/me/invitations")
  assert.deepEqual(field(remaining.body, "invitations"), [])
})

test("an unverified account with the invited email sees no invitations, even with verification off", async () => {
  const email = `claimed-inbox+${den.stamp}@example.test`
  const invited = await den.request(org.owner.token, "POST", "/v1/invitations", { orgId: org.orgId, body: { email, role: "member" } })
  assert.ok(invited.status < 300, summary(invited))
  const claimant = await den.signUp("Claimed Inbox", email)
  const listed = await den.request(claimant.token, "GET", "/v1/me/invitations")
  assert.equal(listed.status, 200, summary(listed))
  assert.deepEqual(field(listed.body, "invitations"), [])
})

test("other people and signed-out callers see no invitations", async () => {
  await den.request(org.owner.token, "POST", "/v1/invitations", { orgId: org.orgId, body: { email: `someone-else+${den.stamp}@example.test`, role: "member" } })
  const stranger = await den.signUp("Not Invited")
  await verify(stranger.userId)
  const listed = await den.request(stranger.token, "GET", "/v1/me/invitations")
  assert.equal(listed.status, 200, summary(listed))
  assert.deepEqual(field(listed.body, "invitations"), [])
  assert.equal((await den.request(null, "GET", "/v1/me/invitations")).status, 401)
})
