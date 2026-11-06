/**
 * An identity provider can provision someone again after a Den admin removed
 * them from the organization while they stayed assigned in the IdP. Den keeps
 * the removed member row and the global user, which used to make the IdP's
 * POST /Users fail with 409 "User already exists" until someone cleared
 * member.removed_at in the database.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())

const platformAdmin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
const API_ORIGIN = "http://127.0.0.1:8790"

async function scimOrg(label: string) {
  const { orgId, owner } = await den.createOrg(await den.signUp(`${label} Owner`), `${label} SCIM org`)
  const plan = await den.request(platformAdmin.token, "PATCH", `/v1/admin/organizations/${orgId}/plan`, { body: { tier: "enterprise", seatLimit: 50 } })
  assert.equal(plan.status, 200, summary(plan))
  const domain = `${label.toLowerCase()}-${den.stamp}.test`
  const saml = await den.as(owner, orgId)("POST", "/v1/sso/saml", {
    issuer: `http://127.0.0.1/entra/${label}-${den.stamp}`,
    domain,
    entryPoint: `https://login.example.test/${label}-${den.stamp}/saml2`,
    cert: "entra-test-signing-certificate",
    audience: API_ORIGIN,
  })
  assert.equal(saml.status, 201, summary(saml))
  await den.arrangeSsoConnectionEnabled(orgId)
  const issued = await den.as(owner, orgId)("POST", "/v1/scim/token")
  assert.equal(issued.status, 201, summary(issued))
  return { orgId, owner, domain, bearer: text(field(issued.body, "scimToken"), "SCIM token") }
}

function scim(bearer: string, method: "POST" | "PATCH" | "GET", pathname: string, body?: unknown) {
  return den.request(null, method, `/api/auth/scim/v2${pathname}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/scim+json, application/json", "content-type": "application/scim+json" },
    rawBody: body === undefined ? undefined : JSON.stringify(body),
  })
}

function scimCreate(bearer: string, email: string, externalId: string) {
  const [local] = email.split("@")
  return scim(bearer, "POST", "/Users", {
    schemas: [SCIM_USER_SCHEMA], userName: email, name: { givenName: local, familyName: "Entra" },
    emails: [{ primary: true, value: email, type: "work" }], externalId, active: true,
  })
}

async function activeMember(owner: Member, orgId: string, email: string) {
  const roster = await den.as(owner, orgId)("GET", "/v1/org")
  assert.equal(roster.status, 200, summary(roster))
  return list(field(roster.body, "members")).find((entry) => field(entry, "user", "email") === email) ?? null
}

async function removeInDen(owner: Member, orgId: string, email: string) {
  const member = await activeMember(owner, orgId, email)
  assert.ok(member, `${email} is a member before removal`)
  const removed = await den.as(owner, orgId)("DELETE", `/v1/members/${text(member.id, "member id")}`)
  assert.equal(removed.status < 300, true, summary(removed))
  assert.equal(await activeMember(owner, orgId, email), null, "removed in Den")
  return text(member.id, "member id")
}

test("a SCIM-provisioned user an admin removed in Den is provisioned again by the IdP", async () => {
  const { orgId, owner, domain, bearer } = await scimOrg("Reprovision")
  const email = `ada@${domain}`
  const created = await scimCreate(bearer, email, "entra-ada")
  assert.equal(created.status, 201, summary(created))
  const userId = text(field(created.body, "id"), "SCIM user id")
  const removedMemberId = await removeInDen(owner, orgId, email)

  const again = await scimCreate(bearer, email, "entra-ada")
  assert.equal(again.status, 201, `the IdP can create the user again: ${summary(again)}`)
  assert.equal(field(again.body, "id"), userId, "the same Den user")

  const member = await activeMember(owner, orgId, email)
  assert.ok(member, "an active member again")
  assert.notEqual(member.id, removedMemberId, "a fresh membership; the removed one stays as history")
  assert.equal(member.role, "member")

  const fetched = await scim(bearer, "GET", `/Users/${userId}`)
  assert.equal(fetched.status, 200, summary(fetched))
})

test("a member who joined by invitation, removed in Den, is provisioned by the IdP", async () => {
  const { orgId, owner, bearer } = await scimOrg("Invited")
  const invited = await den.newMember(owner, orgId, "Grace Invited")
  await removeInDen(owner, orgId, invited.email)

  const created = await scimCreate(bearer, invited.email, "entra-grace")
  assert.equal(created.status, 201, summary(created))
  assert.equal(field(created.body, "id"), invited.userId, "links the existing user")
  assert.ok(await activeMember(owner, orgId, invited.email), "an active member again")
})

test("a removed admin comes back as a plain member", async () => {
  const { orgId, owner, bearer } = await scimOrg("Admin")
  const admin = await den.newMember(owner, orgId, "Hedy Admin", "admin")
  await removeInDen(owner, orgId, admin.email)

  const created = await scimCreate(bearer, admin.email, "entra-hedy")
  assert.equal(created.status, 201, summary(created))
  const member = await activeMember(owner, orgId, admin.email)
  assert.equal(member?.role, "member", JSON.stringify(member))
})

test("the IdP updating a removed user and then creating them again still works", async () => {
  const { orgId, owner, domain, bearer } = await scimOrg("Patched")
  const email = `lin@${domain}`
  const created = await scimCreate(bearer, email, "entra-lin")
  assert.equal(created.status, 201, summary(created))
  const userId = text(field(created.body, "id"), "SCIM user id")
  await removeInDen(owner, orgId, email)

  const patched = await scim(bearer, "PATCH", `/Users/${userId}`, {
    schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", path: "name.givenName", value: "Lin" }],
  })
  assert.equal(patched.status < 300, true, summary(patched))

  const again = await scimCreate(bearer, email, "entra-lin")
  assert.equal(again.status, 201, summary(again))
  assert.ok(await activeMember(owner, orgId, email), "an active member again")
})

test("SCIM still never takes over an existing user who was never in the organization", async () => {
  const { orgId, owner, bearer } = await scimOrg("Stranger")
  const stranger = await den.signUp("Sam Stranger")
  const refused = await scimCreate(bearer, stranger.email, "entra-sam")
  assert.equal(refused.status, 409, summary(refused))
  assert.equal(await activeMember(owner, orgId, stranger.email), null)
})
