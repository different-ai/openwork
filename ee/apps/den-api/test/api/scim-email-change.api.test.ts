/**
 * An organization's SCIM connection may rename the sign-in email of people on
 * its own verified SSO domains, and nobody else's. An account's email is
 * global: it receives password resets and is shared by every organization the
 * person belongs to, so one organization's identity provider must not move it
 * for someone who merely is, or was, a member there.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
const API_ORIGIN = "http://127.0.0.1:8790"

async function scimOrg(label: string) {
  const { orgId, owner } = await den.createOrg(await den.signUp(`${label} Owner`), `${label} SCIM org`)
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

function scim(bearer: string, method: "POST" | "PUT" | "PATCH" | "GET", pathname: string, body?: unknown) {
  return den.request(null, method, `/api/auth/scim/v2${pathname}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/scim+json, application/json", "content-type": "application/scim+json" },
    rawBody: body === undefined ? undefined : JSON.stringify(body),
  })
}

function userResource(email: string, externalId: string, givenName = email.split("@")[0]) {
  return {
    schemas: [SCIM_USER_SCHEMA], userName: email, name: { givenName, familyName: "Directory" },
    emails: [{ primary: true, value: email, type: "work" }], externalId, active: true,
  }
}

function replaceUserName(email: string) {
  return { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", path: "userName", value: email }] }
}

async function accountEmail(session: Session) {
  const me = await den.request(session.token, "GET", "/v1/me")
  assert.equal(me.status, 200, summary(me))
  return field(me.body, "user", "email")
}

/** Someone with their own account and organization who also joined the SCIM organization by invitation. */
async function linkedOutsideMember(label: string) {
  const org = await scimOrg(label)
  const person = await den.signUp(`${label} Guest`)
  await den.createOrg(person, `${label} Guest's own org`)
  await den.join(org.owner, org.orgId, person)
  const linked = await scim(org.bearer, "POST", "/Users", userResource(person.email, `directory-${label}`))
  assert.equal(linked.status, 201, summary(linked))
  assert.equal(field(linked.body, "id"), person.userId, "the identity provider links the existing member")
  return { ...org, person }
}

function assertRefused(call: Awaited<ReturnType<typeof scim>>) {
  assert.equal(call.status, 400, summary(call))
  assert.deepEqual(field(call.body, "schemas"), [SCIM_ERROR_SCHEMA], summary(call))
  assert.equal(field(call.body, "scimType"), "mutability", summary(call))
}

test("a SCIM replace cannot move the email of a member whose address is outside the organization's domains", async () => {
  const { bearer, person } = await linkedOutsideMember("Replace")
  const elsewhere = `someone-else+${den.stamp}@elsewhere.test`

  assertRefused(await scim(bearer, "PUT", `/Users/${person.userId}`, userResource(elsewhere, "directory-Replace")))
  assertRefused(await scim(bearer, "PUT", `/Users/${person.userId}`, {
    ...userResource(person.email, "directory-Replace"), emails: [{ primary: true, value: elsewhere, type: "work" }],
  }))

  assert.equal(await accountEmail(person), person.email, "the account keeps its email")
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, `the person still signs in with their own address: ${summary(signedIn)}`)
})

test("a SCIM patch cannot move that email either, onto another address or onto the organization's own domain", async () => {
  const { bearer, domain, person } = await linkedOutsideMember("Patch")

  assertRefused(await scim(bearer, "PATCH", `/Users/${person.userId}`, replaceUserName(`another+${den.stamp}@elsewhere.test`)))
  assertRefused(await scim(bearer, "PATCH", `/Users/${person.userId}`, replaceUserName(`guest@${domain}`)))
  assertRefused(await scim(bearer, "PATCH", `/Users/${person.userId}`, {
    schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", value: { userName: `guest@${domain}` } }],
  }))

  assert.equal(await accountEmail(person), person.email, "the account keeps its email")
})

test("the identity provider still updates everything else for that member", async () => {
  const { bearer, person } = await linkedOutsideMember("Sync")

  const replaced = await scim(bearer, "PUT", `/Users/${person.userId}`, userResource(person.email, "directory-Sync", "Renamed"))
  assert.equal(replaced.status, 200, summary(replaced))
  const patched = await scim(bearer, "PATCH", `/Users/${person.userId}`, {
    schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", path: "name.givenName", value: "Patched" }],
  })
  assert.equal(patched.status, 204, summary(patched))
  assert.equal(await accountEmail(person), person.email)
})

test("the identity provider renames people on the organization's verified domain", async () => {
  const { bearer, domain } = await scimOrg("Owned")
  const created = await scim(bearer, "POST", "/Users", userResource(`ada@${domain}`, "directory-ada"))
  assert.equal(created.status, 201, summary(created))
  const userId = text(field(created.body, "id"), "SCIM user id")

  const replaced = await scim(bearer, "PUT", `/Users/${userId}`, userResource(`ada.lovelace@${domain}`, "directory-ada"))
  assert.equal(replaced.status, 200, summary(replaced))
  assert.equal(field(replaced.body, "userName"), `ada.lovelace@${domain}`)

  const patched = await scim(bearer, "PATCH", `/Users/${userId}`, replaceUserName(`countess@${domain}`))
  assert.equal(patched.status, 204, summary(patched))
  const fetched = await scim(bearer, "GET", `/Users/${userId}`)
  assert.equal(field(fetched.body, "userName"), `countess@${domain}`, summary(fetched))

  assertRefused(await scim(bearer, "PATCH", `/Users/${userId}`, replaceUserName(`countess+${den.stamp}@elsewhere.test`)))
})
