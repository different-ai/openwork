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

/** The join link in the most recent invitation email, as the invited mailbox receives it. */
async function emailedJoinLink(): Promise<URL> {
  const email = await den.request(null, "GET", "/v1/dev/emails/last?template=organizationInvite")
  assert.equal(email.status, 200, summary(email))
  const link = /https?:\/\/[^"'\s<]*\/join-org\?[^"'\s<]*/.exec(email.text)?.[0]
  return new URL(text(link, "emailed join link").replaceAll("&amp;", "&"))
}

async function signUpThroughInvitation(name: string, email: string, query: string) {
  const created = await den.request(null, "POST", `/api/auth/sign-up/email?${query}`, { body: { email, name, password: den.password } })
  assert.equal(created.status, 200, summary(created))
  const signedIn = await den.signIn(email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  return text(field(signedIn.body, "token"), "session token")
}

test("the join token an inviter can read does not verify the invited address", async () => {
  const email = `not-their-inbox+${den.stamp}@example.test`
  const invited = await den.request(org.owner.token, "POST", "/v1/invitations", { orgId: org.orgId, body: { email, role: "member" } })
  assert.ok(invited.status < 300, summary(invited))
  const inviteToken = text(field(invited.body, "inviteToken"), "invite token")

  // Whoever holds only the token (the inviter, or anyone the link was copied to) signs up unverified.
  const token = await signUpThroughInvitation("Not Their Inbox", email, `invite=${encodeURIComponent(inviteToken)}`)
  const listed = await den.request(token, "GET", "/v1/me/invitations")
  assert.equal(listed.status, 200, summary(listed))
  assert.deepEqual(field(listed.body, "invitations"), [])
  const [rows] = await client.query("SELECT email_verified FROM user WHERE email = ?", [email])
  assert.equal(Number(field(list(rows)[0], "email_verified")), 0)
})

test("the link in the invitation email verifies the invited address, and no API returns its proof", async () => {
  const email = `their-inbox+${den.stamp}@example.test`
  const invited = await den.request(org.owner.token, "POST", "/v1/invitations", { orgId: org.orgId, body: { email, role: "member" } })
  assert.ok(invited.status < 300, summary(invited))
  const inviteToken = text(field(invited.body, "inviteToken"), "invite token")
  const emailed = await emailedJoinLink()
  assert.equal(emailed.searchParams.get("invite"), inviteToken)
  const proof = text(emailed.searchParams.get("inviteProof"), "emailed proof")

  // The inviter sees the token and the shareable link, never the proof.
  assert.ok(!invited.text.includes(proof))
  const invitationId = text(field(invited.body, "invitationId"), "invitation id")
  const shared = await den.request(org.owner.token, "GET", `/v1/invitations/${invitationId}/link`, { orgId: org.orgId })
  assert.ok(!shared.text.includes(proof), summary(shared))

  // A proof made for another address is not accepted for this one.
  const otherEmail = `other-inbox+${den.stamp}@example.test`
  const otherInvited = await den.request(org.owner.token, "POST", "/v1/invitations", { orgId: org.orgId, body: { email: otherEmail, role: "member" } })
  const otherToken = text(field(otherInvited.body, "inviteToken"), "other invite token")
  const mismatched = await signUpThroughInvitation("Other Inbox", otherEmail, `invite=${encodeURIComponent(otherToken)}&inviteProof=${encodeURIComponent(proof)}`)
  assert.deepEqual(field((await den.request(mismatched, "GET", "/v1/me/invitations")).body, "invitations"), [])

  const token = await signUpThroughInvitation("Their Inbox", email, `invite=${encodeURIComponent(inviteToken)}&inviteProof=${encodeURIComponent(proof)}`)
  const listed = await den.request(token, "GET", "/v1/me/invitations")
  assert.equal(listed.status, 200, summary(listed))
  assert.equal(field(list(field(listed.body, "invitations"))[0], "organization", "id"), org.orgId)
})
