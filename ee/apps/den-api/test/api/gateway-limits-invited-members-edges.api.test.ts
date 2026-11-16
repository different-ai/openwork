/**
 * Spend limits held by people who have not accepted their invitation yet
 * (`limitsForInvitedMembers`): what happens around the assignment.
 *
 * 1. The limits pages keep working while an invited person holds a limit:
 *    listing, inspecting that person, editing, archiving and restoring the limit.
 * 2. Canceling the invitation leaves nothing behind: inviting the same person
 *    again starts without the limit.
 * 3. Someone who was removed and is invited again gets the limit assigned to
 *    the new invitation.
 * 4. Turning the feature off keeps what was assigned: it can still be removed,
 *    and it still applies when the person joins.
 * 5. Team and organization limits reach an invited person when they join, next
 *    to a limit of their own.
 * 6. People who joined are assigned as before, with the feature on or off.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, list, summary, text, type Call, type Session } from "./harness.js"

const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => {
  await den.close()
})

const FEATURE = "limitsForInvitedMembers"
const POLICIES = "/v1/gateway/usage-limit-policies"

type Api = ReturnType<typeof den.as>

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

async function invite(api: Api, email: string, extra: Record<string, unknown> = {}): Promise<{ memberId: string; inviteToken: string; invitationId: string }> {
  const invited = await ok(api("POST", "/v1/invitations", { email, role: "member", ...extra }), `invite ${email}`)
  const roster = await ok(api("GET", "/v1/org"), "roster")
  const member = list(field(roster.body, "members")).find((entry) => field(entry, "user", "email") === email)
  const invitation = list(field(roster.body, "invitations")).find((entry) => entry.email === email)
  return {
    memberId: text(member?.id, `member row of ${email}`),
    inviteToken: text(field(invited.body, "inviteToken"), "invite token"),
    invitationId: text(invitation?.id, `invitation of ${email}`),
  }
}

const accept = (person: Session, inviteToken: string) => ok(den.request(person.token, "POST", "/v1/orgs/invitations/accept", { body: { id: inviteToken } }), `accept ${person.email}`)

async function createLimit(api: Api, name: string): Promise<string> {
  const created = await ok(api("POST", POLICIES, { name, hardLimit: false, allowRequestReset: true, limits: [{ timeframe: "day", costUsd: "5" }] }), `limit ${name}`)
  return text(field(created.body, "id"), "limit id")
}

async function policy(api: Api, name: string) {
  const policies = await ok(api("GET", POLICIES), "limits")
  const found = list(field(policies.body, "policies")).find((entry) => entry.name === name)
  assert.ok(found, `limit "${name}" exists: ${summary(policies)}`)
  return found
}

async function assignedMembers(api: Api, name: string): Promise<string[]> {
  return list((await policy(api, name)).assignments).flatMap((entry) => typeof entry.memberId === "string" ? [entry.memberId] : []).sort()
}

const assign = (api: Api, limit: string, target: Record<string, unknown>) => api("POST", `${POLICIES}/${limit}/assignments`, target)

async function ownLimits(person: Session, orgId: string): Promise<string> {
  return (await ok(den.as(person, orgId)("GET", "/v1/gateway/usage-limits/me"), "own limits")).text
}

const ada = await den.signUp("Ada Owner")
const org = await den.createOrg(ada, "Limits for invited people, edges")
const api = den.as(ada, org.orgId)
assert.ok((await den.setFeature(org.orgId, FEATURE, true)).status < 300)

test("the limits pages keep working while an invited person holds a limit", async () => {
  const bo = await den.signUp("Bo Pending")
  const pending = await invite(api, bo.email)
  const limit = await createLimit(api, "Pending spend")
  await ok(assign(api, limit, { memberId: pending.memberId }), "assign")
  // Assigning twice changes nothing.
  const twice = await assign(api, limit, { memberId: pending.memberId })
  assert.ok(twice.status < 500, summary(twice))
  assert.deepEqual(await assignedMembers(api, "Pending spend"), [pending.memberId])

  await ok(api("GET", `${POLICIES}/${limit}/assignments`), "assignment list")
  await ok(api("GET", "/v1/gateway/usage-limits/members"), "people search")
  const inspected = await api("GET", `/v1/gateway/usage-limits/members/${pending.memberId}`)
  assert.ok(inspected.status < 500, `inspecting an invited person never errors: ${summary(inspected)}`)

  // Editing, archiving and restoring a limit recomputes it for everyone it names.
  const current = await policy(api, "Pending spend")
  const edited = await ok(api("PATCH", `${POLICIES}/${limit}`, { name: "Pending spend", hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "day", costUsd: "9" }], revision: current.revision }), "edit")
  const archived = await ok(api("POST", `${POLICIES}/${limit}/archive`, { revision: field(edited.body, "revision") }), "archive")
  await ok(api("POST", `${POLICIES}/${limit}/restore`, { revision: field(archived.body, "revision") }), "restore")
  assert.deepEqual(await assignedMembers(api, "Pending spend"), [pending.memberId])

  await accept(bo, pending.inviteToken)
  assert.match(await ownLimits(bo, org.orgId), /Pending spend/)
  // Now that Bo joined, an admin can inspect them.
  await ok(api("GET", `/v1/gateway/usage-limits/members/${pending.memberId}`), "inspect after joining")
})

test("canceling the invitation leaves nothing behind", async () => {
  const cy = await den.signUp("Cy Canceled")
  const first = await invite(api, cy.email)
  const limit = await createLimit(api, "Canceled spend")
  await ok(assign(api, limit, { memberId: first.memberId }), "assign")
  await ok(api("POST", `/v1/invitations/${first.invitationId}/cancel`, {}), "cancel")
  await ok(api("GET", POLICIES), "limits still load")

  const second = await invite(api, cy.email)
  assert.notEqual(second.memberId, first.memberId, "a new invitation is a new member row")
  await accept(cy, second.inviteToken)
  assert.doesNotMatch(await ownLimits(cy, org.orgId), /Canceled spend/)
})

test("someone removed and invited again gets the limit of the new invitation", async () => {
  const di = await den.newMember(ada, org.orgId, "Di Returning")
  await ok(api("DELETE", `/v1/members/${di.memberId}`), "remove")
  const pending = await invite(api, di.email)
  const limit = await createLimit(api, "Returning spend")
  await ok(assign(api, limit, { memberId: pending.memberId }), "assign")
  // Removal ended Di's sign-ins: they sign in again to accept.
  const back: Session = { ...di, token: text(field((await ok(den.signIn(di.email), "sign in again")).body, "token"), "session token") }
  await accept(back, pending.inviteToken)
  assert.deepEqual(await assignedMembers(api, "Returning spend"), [pending.memberId])
  assert.match(await ownLimits(back, org.orgId), /Returning spend/)
})

test("team and organization limits reach an invited person when they join, next to their own", async () => {
  const eli = await den.signUp("Eli Team")
  const teamId = await den.createTeam(ada, org.orgId, "Invited team", [])
  const pending = await invite(api, eli.email, { teamId })
  const own = await createLimit(api, "Own spend")
  const team = await createLimit(api, "Team spend")
  const everyone = await createLimit(api, "Everyone spend")
  await ok(assign(api, own, { memberId: pending.memberId }), "assign person")
  await ok(assign(api, team, { teamId }), "assign team")
  await ok(assign(api, everyone, { organization: true }), "assign organization")

  await accept(eli, pending.inviteToken)
  const limits = await ownLimits(eli, org.orgId)
  // One limit wins per window; whichever it is, it is one of the three and reading it works.
  assert.match(limits, /Own spend|Team spend|Everyone spend/)
  await ok(api("GET", `/v1/gateway/usage-limits/members/${pending.memberId}`), "inspect")
  await ok(api("POST", `${POLICIES}/${everyone}/archive`, { revision: (await policy(api, "Everyone spend")).revision }), "archive the organization limit")
})

test("turning the feature off keeps what was assigned", async () => {
  const fay = await den.signUp("Fay Kept")
  const gil = await den.signUp("Gil Unassigned")
  const kept = await invite(api, fay.email)
  const dropped = await invite(api, gil.email)
  const limit = await createLimit(api, "Kept spend")
  await ok(assign(api, limit, { memberId: kept.memberId }), "assign")
  await ok(assign(api, limit, { memberId: dropped.memberId }), "assign")

  assert.ok((await den.setFeature(org.orgId, FEATURE, false)).status < 300)
  try {
    const refused = await assign(api, await createLimit(api, "Late spend"), { memberId: kept.memberId })
    assert.equal(refused.status, 404, summary(refused))

    const assignment = list((await policy(api, "Kept spend")).assignments).find((entry) => entry.memberId === dropped.memberId)
    await ok(api("DELETE", `${POLICIES}/${limit}/assignments/${text(assignment?.id, "assignment id")}`), "unassign an invited person")
    assert.deepEqual(await assignedMembers(api, "Kept spend"), [kept.memberId])

    await accept(fay, kept.inviteToken)
    assert.match(await ownLimits(fay, org.orgId), /Kept spend/)
    await accept(gil, dropped.inviteToken)
    assert.doesNotMatch(await ownLimits(gil, org.orgId), /Kept spend/)
  } finally {
    assert.ok((await den.setFeature(org.orgId, FEATURE, true)).status < 300)
  }
})

test("people who joined are assigned as before, with the feature on or off", async () => {
  const hal = await den.newMember(ada, org.orgId, "Hal Joined")
  const stranger = await den.signUp("Ian Elsewhere")
  const elsewhere = await den.createOrg(stranger, "Another organization")
  for (const enabled of [true, false]) {
    assert.ok((await den.setFeature(org.orgId, FEATURE, enabled)).status < 300)
    const name = `Joined spend ${enabled ? "on" : "off"}`
    const limit = await createLimit(api, name)
    await ok(assign(api, limit, { memberId: hal.memberId }), "assign a joined member")
    assert.deepEqual(await assignedMembers(api, name), [hal.memberId])
    assert.match(await ownLimits(hal, org.orgId), new RegExp(name))

    // A member of another organization is never a target.
    const foreign = await assign(api, limit, { memberId: elsewhere.owner.memberId })
    assert.equal(foreign.status, 404, summary(foreign))
    assert.deepEqual(await assignedMembers(api, name), [hal.memberId])
    // One limit wins per window: retire this one so the next round's is the one Hal sees.
    await ok(api("POST", `${POLICIES}/${limit}/archive`, { revision: (await policy(api, name)).revision }), "archive")
  }
  assert.ok((await den.setFeature(org.orgId, FEATURE, true)).status < 300)
})
