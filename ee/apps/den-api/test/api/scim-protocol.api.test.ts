import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { auth } = await import("../../src/auth.js")
const { buildOrganizationScimProviderId } = await import("../../src/scim.js")
const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
const prefix = "/api/auth/scim/v2"
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User"
const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

// Token issuance is an arrangement through the real authenticated Better Auth
// API; SAML readiness and the management UI are covered by their own journeys.
async function organization(name: string) {
  const org = await den.createOrg(await den.signUp(`${name} Owner`), name)
  const { scimToken } = await auth.api.generateSCIMToken({
    body: { providerId: buildOrganizationScimProviderId(normalizeDenTypeId("organization", org.orgId)), organizationId: org.orgId },
    headers: new Headers({ cookie: org.owner.cookie }),
  })
  return { ...org, token: scimToken }
}
const a = await organization("Alpha SCIM")
const b = await organization("Beta SCIM")
const request = (token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, orgId?: string) => den.request(token, method, `${prefix}${path}`, { body, orgId })
const patch = (token: string, id: string, value: unknown, op = "Replace", path = "active") => request(token, "PATCH", `/Users/${id}`, { schemas: [patchSchema], Operations: [{ op, path, value }] })
async function create(name: string) {
  const created = await request(a.token, "POST", "/Users", { schemas: [userSchema], userName: `${name.toLowerCase().replaceAll(" ", "-")}+${den.stamp}@example.test`, externalId: `external-${name}`, displayName: name, active: true })
  assert.equal(created.status, 201, summary(created))
  return { id: text(field(created.body, "id"), "user ID"), created }
}

// Each test records observable values in node:test diagnostics on failure; the
// browser simulation separately records reviewer-facing assertion evidence.
test("User pagination, externalId matching and displayName PATCH preserve a stable resource", async () => {
  const { id, created } = await create("Protocol Member")
  assert.match(created.headers.get("content-type") ?? "", /^application\/scim\+json/)
  assert.equal(field(created.body, "displayName"), "Protocol Member")
  const query = new URLSearchParams({ filter: 'externalId eq "external-Protocol Member"' })
  const matched = await request(a.token, "GET", `/Users?${query}&startIndex=1&count=1`)
  assert.equal(matched.status, 200, summary(matched))
  assert.equal(field(matched.body, "totalResults"), 1)
  assert.equal(list(field(matched.body, "Resources"))[0]?.id, id)
  const end = await request(a.token, "GET", `/Users?${query}&startIndex=2&count=1`)
  assert.equal(field(end.body, "startIndex"), 2)
  assert.equal(field(end.body, "totalResults"), 1)
  assert.equal(field(end.body, "itemsPerPage"), 0)
  assert.deepEqual(field(end.body, "Resources"), [])
  const zero = await request(a.token, "GET", `/Users?${query}&count=0`)
  assert.equal(field(zero.body, "totalResults"), 1)
  assert.deepEqual(field(zero.body, "Resources"), [])
  for (const [op, name] of [["Replace", "Mixed case name"], ["replace", "Lowercase name"]]) {
    const changed = await patch(a.token, id, name, op, "displayName")
    assert.equal(changed.status, 204, summary(changed))
    const read = await request(a.token, "GET", `/Users/${id}`)
    assert.equal(field(read.body, "displayName"), name, summary(read))
  }
  const invalid = await request(a.token, "GET", '/Users?filter=externalId%20co%20%22external%22')
  assert.equal(invalid.status, 400, summary(invalid))
})

test("Group attribute exclusion applies to direct and list responses, without deleting membership", async () => {
  const { id } = await create("Group Member")
  const group = await request(a.token, "POST", "/Groups", { displayName: "Projected team", members: [{ value: id }] })
  assert.equal(group.status, 201, summary(group))
  const groupId = text(field(group.body, "id"), "group ID")
  for (const path of [`/Groups/${groupId}?excludedAttributes=members`, "/Groups?excludedAttributes=members"]) {
    const excluded = await request(a.token, "GET", path)
    assert.equal(excluded.status, 200, summary(excluded))
    const resources = path.startsWith("/Groups?") ? list(field(excluded.body, "Resources")) : [excluded.body]
    for (const resource of resources) assert.equal(field(resource, "members"), undefined)
  }
  const retained = await request(a.token, "GET", `/Groups/${groupId}`)
  assert.equal(list(field(retained.body, "members"))[0]?.value, id)
})

test("a directory larger than the auth adapter limit stays pageable and matchable", async () => {
  const org = await organization("Large directory")
  const { db } = await import("../../src/db.js")
  const { AuthUserTable, AuthAccountTable, MemberTable } = await import("@openwork-ee/den-db/schema")
  const { createDenTypeId } = await import("@openwork-ee/utils/typeid")
  const organizationId = normalizeDenTypeId("organization", org.orgId)
  // Arrange a large directory without testing a provider's throttle policy.
  const ids = Array.from({ length: 105 }, () => createDenTypeId("user"))
  await db.insert(AuthUserTable).values(ids.map((id, index) => ({ id, name: `Directory ${index}`, email: `directory-${index}+${den.stamp}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() })))
  await db.insert(AuthAccountTable).values(ids.map((userId, index) => ({ id: createDenTypeId("account"), userId, providerId: buildOrganizationScimProviderId(organizationId), accountId: `directory-${index}`, createdAt: new Date(), updatedAt: new Date() })))
  await db.insert(MemberTable).values(ids.map(userId => ({ id: createDenTypeId("member"), userId, organizationId, role: "member" })))
  const first = await request(org.token, "GET", "/Users?count=100")
  const last = await request(org.token, "GET", "/Users?startIndex=101&count=100")
  assert.equal(first.status, 200, summary(first))
  assert.equal(last.status, 200, summary(last))
  assert.equal(field(first.body, "totalResults"), 105)
  assert.equal(field(last.body, "totalResults"), 105)
  const all = [...list(field(first.body, "Resources")), ...list(field(last.body, "Resources"))]
  assert.equal(all.length, 105)
  assert.equal(new Set(all.map(resource => resource.id)).size, 105)
  assert.deepEqual(new Set(all.map(resource => resource.id)), new Set(ids))
  const match = await request(org.token, "GET", '/Users?filter=externalId%20eq%20%22directory-104%22')
  assert.equal(field(match.body, "totalResults"), 1)
  assert.equal(list(field(match.body, "Resources"))[0]?.id, ids[104])
})

async function membership(owner: Member, orgId: string, id: string) {
  const org = await den.as(owner, orgId)("GET", "/v1/org")
  assert.equal(org.status, 200, summary(org))
  return list(field(org.body, "members")).find(member => field(member, "user", "id") === id)
}

test("disable revokes org access but retains the same queryable ID, and unrelated updates do not reactivate it", async () => {
  const { id } = await create("Lifecycle Member")
  const before = await membership(a.owner, a.orgId, id)
  assert.ok(before)
  const promoted = await den.as(a.owner, a.orgId)("POST", `/v1/members/${before.id}/role`, { role: "admin" })
  assert.equal(promoted.status, 200, summary(promoted))
  assert.equal((await membership(a.owner, a.orgId, id))?.role, "admin")
  const disabled = await patch(a.token, id, false)
  assert.equal(disabled.status, 204, summary(disabled))
  assert.equal(await membership(a.owner, a.orgId, id), undefined)
  for (const op of ["Replace", "replace"]) {
    const again = await patch(a.token, id, "False", op)
    assert.equal(again.status, 204, summary(again))
  }
  const changed = await patch(a.token, id, "Still disabled", "replace", "displayName")
  assert.equal(changed.status, 204, summary(changed))
  const read = await request(a.token, "GET", `/Users/${id}`)
  assert.equal(read.status, 200, summary(read))
  assert.equal(field(read.body, "active"), false)
  assert.equal(field(read.body, "id"), id)
  assert.equal(await membership(a.owner, a.orgId, id), undefined)
  const matched = await request(a.token, "GET", `/Users?${new URLSearchParams({ filter: 'externalId eq "external-Lifecycle Member"' })}`)
  assert.equal(field(matched.body, "totalResults"), 1)
  assert.equal(list(field(matched.body, "Resources"))[0]?.active, false)
  const restored = await patch(a.token, id, true, "replace")
  assert.equal(restored.status, 204, summary(restored))
  const after = await request(a.token, "GET", `/Users/${id}`)
  assert.equal(field(after.body, "active"), true)
  assert.equal(field(after.body, "id"), id)
  assert.equal((await membership(a.owner, a.orgId, id))?.role, "member")
})

test("PUT and pathless PATCH persist attributes and lifecycle together; invalid operations have no effect", async () => {
  const { id, created } = await create("Combined Member")
  const userName = field(created.body, "userName")
  const invalid = await request(a.token, "PATCH", `/Users/${id}`, { schemas: [patchSchema], Operations: [{ op: "Replace", path: "active", value: false }, { op: "invalid", path: "displayName", value: "Must not persist" }] })
  assert.equal(invalid.status, 400, summary(invalid))
  assert.equal(field((await request(a.token, "GET", `/Users/${id}`)).body, "active"), true)
  assert.ok(await membership(a.owner, a.orgId, id))
  const disabled = await request(a.token, "PUT", `/Users/${id}`, { schemas: [userSchema], userName, externalId: "combined-new-external", displayName: "PUT disabled", active: false })
  assert.equal(disabled.status, 200, summary(disabled))
  assert.equal(field(disabled.body, "active"), false)
  assert.equal(field(disabled.body, "displayName"), "PUT disabled")
  assert.equal(await membership(a.owner, a.orgId, id), undefined)
  const unchanged = await request(a.token, "PUT", `/Users/${id}`, { schemas: [userSchema], userName, externalId: "combined-new-external", displayName: "PUT still disabled" })
  assert.equal(unchanged.status, 200, summary(unchanged))
  assert.equal(field(unchanged.body, "active"), false)
  assert.equal(await membership(a.owner, a.orgId, id), undefined)
  const restored = await request(a.token, "PATCH", `/Users/${id}`, { schemas: [patchSchema], Operations: [{ op: "Replace", value: { displayName: "Pathless restored", active: true } }] })
  assert.equal(restored.status, 204, summary(restored))
  const read = await request(a.token, "GET", `/Users/${id}`)
  assert.equal(field(read.body, "displayName"), "Pathless restored")
  assert.equal(field(read.body, "active"), true)
  assert.equal(field(read.body, "externalId"), "combined-new-external")
  assert.ok(await membership(a.owner, a.orgId, id))
})

test("a foreign org token cannot read, disable, reactivate, update, or delete another org's User", async () => {
  const { id } = await create("Isolated Member")
  for (const orgId of [a.orgId, b.orgId]) {
    const filtered = await request(b.token, "GET", '/Users?filter=externalId%20eq%20%22external-Isolated%20Member%22', undefined, orgId)
    assert.equal(field(filtered.body, "totalResults"), 0)
    const read = await request(b.token, "GET", `/Users/${id}`, undefined, orgId)
    assert.equal(read.status, 404, summary(read))
    for (const value of [false, true]) {
      const mutation = await den.request(b.token, "PATCH", `${prefix}/Users/${id}`, { orgId, body: { schemas: [patchSchema], Operations: [{ op: "Replace", path: "active", value }] } })
      assert.equal(mutation.status, 404, summary(mutation))
    }
    const change = await patch(b.token, id, "Hijacked", "replace", "displayName")
    assert.equal(change.status, 404, summary(change))
    const deleted = await request(b.token, "DELETE", `/Users/${id}`, undefined, orgId)
    assert.equal(deleted.status, 404, summary(deleted))
  }
  const retained = await request(a.token, "GET", `/Users/${id}`)
  assert.equal(retained.status, 200, summary(retained))
  assert.equal(field(retained.body, "active"), true)
  assert.equal(field(retained.body, "displayName"), "Isolated Member")
  assert.ok(await membership(a.owner, a.orgId, id))
})

test("one tenant's hard deletion cannot destroy another tenant's retained inactive User", async () => {
  const person = await den.signUp("Retained Shared Person")
  await den.join(a.owner, a.orgId, person)
  await den.join(b.owner, b.orgId, person)
  for (const org of [a, b]) {
    const linked = await request(org.token, "POST", "/Users", { schemas: [userSchema], userName: person.email, externalId: `retained-${org.orgId}`, name: { formatted: person.name } })
    assert.equal(linked.status, 201, summary(linked))
    assert.equal((await patch(org.token, person.userId, false)).status, 204)
  }
  const removed = await request(a.token, "DELETE", `/Users/${person.userId}`)
  assert.equal(removed.status, 204, summary(removed))
  assert.equal((await request(a.token, "GET", `/Users/${person.userId}`)).status, 404)
  const retained = await request(b.token, "GET", `/Users/${person.userId}`)
  assert.equal(retained.status, 200, summary(retained))
  assert.equal(field(retained.body, "active"), false)
  const restored = await patch(b.token, person.userId, true)
  assert.equal(restored.status, 204, summary(restored))
  const read = await request(b.token, "GET", `/Users/${person.userId}`)
  assert.equal(field(read.body, "id"), person.userId)
  assert.equal(field(read.body, "active"), true)
  assert.ok(await membership(b.owner, b.orgId, person.userId))
})

test("deactivating a shared global user changes only the authorizing organization's access", async () => {
  const person = await den.signUp("Shared Person")
  await den.join(a.owner, a.orgId, person)
  await den.join(b.owner, b.orgId, person)
  for (const org of [a, b]) {
    const linked = await request(org.token, "POST", "/Users", { schemas: [userSchema], userName: person.email, externalId: `shared-${org.orgId}`, name: { formatted: person.name }, active: true })
    assert.equal(linked.status, 201, summary(linked))
    assert.equal(field(linked.body, "id"), person.userId)
  }
  const tokenA = await den.mintMcpToken(person, a.orgId)
  const tokenB = await den.mintMcpToken(person, b.orgId)
  const tools = (token: string) => den.request(token, "POST", "/mcp/agent", { headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } })
  assert.equal((await tools(tokenA)).status, 200)
  assert.equal((await tools(tokenB)).status, 200)
  const disabled = await patch(a.token, person.userId, false)
  assert.equal(disabled.status, 204, summary(disabled))
  const revoked = await tools(tokenA)
  assert.equal(revoked.status, 401, summary(revoked))
  // These short-lived MCP credentials bind to the login session too; both
  // expire with that session, while org B membership remains independently usable.
  const expired = await tools(tokenB)
  assert.equal(expired.status, 401, summary(expired))
  assert.equal(field(expired.body, "error"), "mcp_session_revoked")
  assert.equal(await membership(a.owner, a.orgId, person.userId), undefined)
  assert.ok(await membership(b.owner, b.orgId, person.userId))
  const own = await request(a.token, "GET", `/Users/${person.userId}`)
  const other = await request(b.token, "GET", `/Users/${person.userId}`)
  assert.equal(field(own.body, "active"), false)
  assert.equal(field(other.body, "active"), true)
  // Membership removal intentionally revokes user-scoped login sessions, not
  // just the changed org's credentials. A fresh login still has org B access.
  const stale = await den.as(person, b.orgId)("GET", "/v1/org")
  assert.equal(stale.status, 401, summary(stale))
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const fresh = text(field(signedIn.body, "token"), "fresh session")
  const usable = await den.request(fresh, "GET", "/v1/org", { orgId: b.orgId })
  assert.equal(usable.status, 200, summary(usable))
  const denied = await den.request(fresh, "GET", "/v1/org", { orgId: a.orgId })
  assert.equal(denied.status, 404, summary(denied))
  const freshB = await den.request(fresh, "POST", "/v1/mcp/token", { orgId: b.orgId, body: { scopes: ["mcp:read", "mcp:write"] } })
  assert.equal(freshB.status, 200, summary(freshB))
  assert.equal((await tools(text(field(freshB.body, "token"), "fresh org B MCP token"))).status, 200)
  const blockedA = await den.request(fresh, "POST", "/v1/mcp/token", { orgId: a.orgId, body: { scopes: ["mcp:read", "mcp:write"] } })
  assert.equal(blockedA.status, 404, summary(blockedA))
  const restored = await patch(a.token, person.userId, true)
  assert.equal(restored.status, 204, summary(restored))
  assert.ok(await membership(a.owner, a.orgId, person.userId))
  assert.ok(await membership(b.owner, b.orgId, person.userId))
})
