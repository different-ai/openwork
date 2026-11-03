/**
 * Sandbox organizations: platform admins create try-it-out organizations on cloud deployments;
 * anyone with the join link joins as a member until the seats run out, the sandbox closes, or the
 * link is replaced. A closed or expired sandbox gets no Free Auto (Den API reads the sandbox row; no grants or
 * benefit settings are written) without removing members, and extending it restores Free Auto.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", INFERENCE_FREE_ENABLED: "true" } })
after(() => den.close())
const { client } = await import("../../src/db.js")
/** ARRANGE ONLY: the person confirmed their email address (the inbox step is a separate journey). */
const verify = (userId: string) => client.execute("UPDATE user SET email_verified = true WHERE id = ?", [userId])

const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const create = (body: Record<string, unknown>) => den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", {
  body: { name: "Trial sandbox", connectorBaseUrl: "http://127.0.0.1:9/", days: 14, memberLimit: 3, allowedEmailDomains: [], joinRole: "member", ...body },
})
const tokenOf = (sandbox: unknown) => text(new URL(text(field(sandbox, "joinLink"), "join link")).searchParams.get("token"), "join token")
const join = (token: string, joinToken: string) => den.request(token, "POST", "/v1/sandbox-join", { body: { token: joinToken } })
/** What a member's app sees: whether Den offers them Free Auto, and whether it issues the Free Auto credential. */
async function freeAuto(orgId: string) {
  const access = await den.as(admin, orgId)("GET", "/v1/inference/access")
  assert.equal(access.status, 200, summary(access))
  const credential = await den.as(admin, orgId)("POST", "/v1/inference/free/credential")
  const offered = field(access.body, "access", "reason") !== "admin_disabled"
  assert.equal(credential.status === 200, offered, `access and credential agree: ${summary(access)} / ${summary(credential)}`)
  if (!offered) assert.equal(field(credential.body, "error"), "free_not_offered", summary(credential))
  return offered
}
/** ARRANGE ONLY: the sandbox's time ran out (waiting days is not practical in a test). */
const expire = (sandboxId: string) => client.execute("UPDATE sandbox_organization SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?", [sandboxId])
const grantRows = async (orgId: string) => {
  const [rows] = await client.query("SELECT (SELECT count(*) FROM organization_grant WHERE organization_id = ?) + (SELECT count(*) FROM organization_benefit_setting WHERE organization_id = ?) AS total", [orgId, orgId])
  return Number(field(Array.isArray(rows) ? rows[0] : null, "total") ?? -1)
}

test("only platform admins create or list sandboxes", async () => {
  const person = await den.signUp("Not Admin")
  assert.equal((await den.request(person.token, "GET", "/v1/admin/sandbox-orgs")).status, 403)
  assert.equal((await den.request(person.token, "POST", "/v1/admin/sandbox-orgs", { body: { name: "Nope", connectorBaseUrl: null, days: 1, memberLimit: 1, allowedEmailDomains: [] } })).status, 403)
})

test("a sandbox gets five per-person connectors, Free Auto and a join link that makes people members until seats run out", async () => {
  const created = await create({})
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(field(sandbox, "connectorCount"), 5)
  assert.equal(field(sandbox, "memberCount"), 1, "the creating admin is the only member")
  assert.equal(await freeAuto(orgId), true)
  assert.equal(await grantRows(orgId), 0, "no organization grants or benefit settings are written")
  const joinToken = tokenOf(sandbox)

  const connections = list(field((await den.as(admin, orgId)("GET", "/v1/mcp-connections")).body, "connections"))
  assert.deepEqual(connections.map((entry) => entry.name).sort(), ["Calendar", "Confluence", "Drive", "Jira", "Outlook"])
  assert.ok(connections.every((entry) => entry.authType === "oauth" && entry.credentialMode === "per_member"), JSON.stringify(connections))

  const preview = await den.request(null, "GET", `/v1/sandbox-join/preview?token=${joinToken}`)
  assert.equal(preview.status, 200, summary(preview))
  assert.equal(field(preview.body, "state"), "open")
  assert.equal((await den.request(null, "GET", "/v1/sandbox-join/preview?token=not-a-real-token")).status, 404)
  assert.equal((await den.request(null, "POST", "/v1/sandbox-join", { body: { token: joinToken } })).status, 401)

  const avery = await den.signUp("Avery Trial")
  const joined = await join(avery.token, joinToken)
  assert.equal(joined.status, 200, summary(joined))
  assert.equal(field(joined.body, "alreadyMember"), false)
  assert.equal(field((await join(avery.token, joinToken)).body, "alreadyMember"), true, "joining again is harmless")
  const context = await den.request(avery.token, "GET", "/v1/org", { orgId })
  assert.equal(field(context.body, "currentMember", "role"), "member", summary(context))

  await join((await den.signUp("Riley Trial")).token, joinToken)
  for (const person of [admin, avery]) {
    const directory = await den.request(person.token, "GET", "/v1/me/orgs")
    assert.equal(directory.status, 200, summary(directory))
    const entry = list(field(directory.body, "orgs")).find((org) => org.id === orgId)
    assert.equal(field(entry, "isSandbox"), true, "owners and joiners see the same sandbox identity")
    assert.equal(field(entry, "planTier"), "enterprise", "the sandbox label is separate from its Enterprise plan")
    assert.equal(field(entry, "memberCount"), 3)
    assert.equal(field(entry, "joinToken"), undefined, "the directory never exposes sandbox join secrets")
  }
  const late = await join((await den.signUp("Casey Late")).token, joinToken)
  assert.equal(late.status, 409, summary(late))
  assert.equal(field(late.body, "error"), "sandbox_full")
})

test("closing stops joins and Free Auto, keeps members, and extending reopens both", async () => {
  const sandbox = field((await create({ memberLimit: 10 })).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id"), orgId = text(field(sandbox, "organizationId"), "organization id")
  const joinToken = tokenOf(sandbox)
  assert.equal((await join((await den.signUp("Early Member")).token, joinToken)).status, 200)

  const closed = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/close`)
  assert.equal(field(closed.body, "sandbox", "state"), "closed", summary(closed))
  assert.equal(field(closed.body, "sandbox", "memberCount"), 2)
  const directory = await den.request(admin.token, "GET", "/v1/me/orgs")
  const closedEntry = list(field(directory.body, "orgs")).find((org) => org.id === orgId)
  assert.equal(field(closedEntry, "isSandbox"), true, "closing does not relabel a sandbox as Free")
  assert.equal(await freeAuto(orgId), false)
  const refused = await join((await den.signUp("After Close")).token, joinToken)
  assert.equal(field(refused.body, "error"), "sandbox_closed", summary(refused))

  const extended = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/extend`, { body: { days: 7 } })
  assert.equal(field(extended.body, "sandbox", "state"), "open", summary(extended))
  assert.equal(await freeAuto(orgId), true)
})

test("a sandbox whose time ran out gets no Free Auto, even before anyone lists or joins it; an ordinary organization keeps it", async () => {
  const sandbox = field((await create({ memberLimit: 10 })).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id"), orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(await freeAuto(orgId), true)
  await expire(id)
  assert.equal(await freeAuto(orgId), false, "expiry alone stops Free Auto; nothing had to close the sandbox first")

  const ordinary = await den.createOrg(admin, "Ordinary organization")
  assert.equal(await freeAuto(ordinary.orgId), true)

  const extended = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/extend`, { body: { days: 7 } })
  assert.equal(field(extended.body, "sandbox", "state"), "open", summary(extended))
  assert.equal(await freeAuto(orgId), true)
})

test("the organization directory reports real plans independently of ownership", async () => {
  const ordinary = await den.createOrg(admin, "Ordinary plan workspace")
  for (const tier of ["free", "team", "enterprise"]) {
    if (tier !== "free") {
      const saved = await den.request(admin.token, "PATCH", `/v1/admin/organizations/${ordinary.orgId}/plan`, { body: { tier, seatLimit: 10 } })
      assert.equal(saved.status, 200, summary(saved))
    }
    const directory = await den.request(admin.token, "GET", "/v1/me/orgs")
    assert.equal(directory.status, 200, summary(directory))
    const entry = list(field(directory.body, "orgs")).find((org) => org.id === ordinary.orgId)
    assert.equal(field(entry, "role"), "owner")
    assert.equal(field(entry, "isSandbox"), false)
    assert.equal(field(entry, "planTier"), tier)
    assert.equal(field(entry, "memberCount"), 1)
  }
})

test("replacing the link stops the old one; a domain-limited sandbox refuses other email domains", async () => {
  const sandbox = field((await create({ allowedEmailDomains: ["allowed.test"] })).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id"), oldToken = tokenOf(sandbox)
  const outsider = await join((await den.signUp("Other Domain")).token, oldToken)
  assert.equal(field(outsider.body, "error"), "account_email_domain_not_allowed", summary(outsider))

  const rotated = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/rotate-link`)
  const newToken = tokenOf(field(rotated.body, "sandbox"))
  assert.notEqual(newToken, oldToken)
  assert.equal((await den.request(null, "GET", `/v1/sandbox-join/preview?token=${oldToken}`)).status, 404)
  const insider = await den.signUp("Allowed Person", `allowed+${den.stamp}@allowed.test`)
  const unverified = await join(insider.token, newToken)
  assert.equal(unverified.status, 403, `an unproven address cannot satisfy a domain limit: ${summary(unverified)}`)
  assert.equal(field(unverified.body, "error"), "email_verification_required")
  await verify(insider.userId)
  assert.equal((await join(insider.token, newToken)).status, 200)
})

test("people joining at the same moment cannot take more seats than the sandbox has", async () => {
  const sandbox = field((await create({ memberLimit: 3 })).body, "sandbox")
  const joinToken = tokenOf(sandbox)
  const people = await Promise.all(Array.from({ length: 8 }, (_, index) => den.signUp(`Rush Person ${String.fromCharCode(97 + index)}`)))
  const results = await Promise.all(people.map((person) => join(person.token, joinToken)))
  assert.equal(results.filter((result) => result.status === 200).length, 2, results.map((result) => result.status).join(","))
  assert.ok(results.filter((result) => result.status !== 200).every((result) => field(result.body, "error") === "sandbox_full"))
  const listed = list(field((await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")).body, "sandboxes"))
  assert.equal(listed.find((entry) => entry.id === field(sandbox, "id"))?.memberCount, 3)
})

test("sandboxes make people who join admins by default", async () => {
  const created = await den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", { body: { name: "Default role sandbox", connectorBaseUrl: null, days: 7, memberLimit: 5, allowedEmailDomains: [] } })
  const sandbox = field(created.body, "sandbox")
  assert.equal(field(sandbox, "joinRole"), "admin", summary(created))
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  const person = await den.signUp("Default Admin Joiner")
  assert.equal((await join(person.token, tokenOf(sandbox))).status, 200)
  assert.equal(field((await den.request(person.token, "GET", "/v1/org", { orgId })).body, "currentMember", "role"), "admin")
})

test("switching a sandbox to admins promotes everyone who already joined; switching back to members demotes nobody", async () => {
  const sandbox = field((await create({ memberLimit: 10 })).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id"), orgId = text(field(sandbox, "organizationId"), "organization id")
  const early = await den.signUp("Early Member Joiner")
  assert.equal((await join(early.token, tokenOf(sandbox))).status, 200)
  assert.equal(field((await den.request(early.token, "GET", "/v1/org", { orgId })).body, "currentMember", "role"), "member")
  const promoted = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/join-role`, { body: { joinRole: "admin" } })
  assert.equal(field(promoted.body, "sandbox", "joinRole"), "admin", summary(promoted))
  assert.equal(field((await den.request(early.token, "GET", "/v1/org", { orgId })).body, "currentMember", "role"), "admin", "people who already joined become admins")
})

test("an admin sandbox makes people who join admins; changing it later never changes people who already joined", async () => {
  const sandbox = field((await create({ joinRole: "admin", memberLimit: 10 })).body, "sandbox")
  assert.equal(field(sandbox, "joinRole"), "admin")
  const id = text(field(sandbox, "id"), "sandbox id"), orgId = text(field(sandbox, "organizationId"), "organization id")
  const joinToken = tokenOf(sandbox)
  assert.equal(field((await den.request(null, "GET", `/v1/sandbox-join/preview?token=${joinToken}`)).body, "joinRole"), "admin")

  const ada = await den.signUp("Ada Admin Joiner")
  assert.equal((await join(ada.token, joinToken)).status, 200)
  const adaContext = await den.request(ada.token, "GET", "/v1/org", { orgId })
  assert.equal(field(adaContext.body, "currentMember", "role"), "admin", summary(adaContext))
  const permissions = field(adaContext.body, "currentMember", "permissions")
  assert.ok(Array.isArray(permissions) && permissions.includes("connections.manage"), "admins can manage the sandbox's connectors")

  const switched = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/join-role`, { body: { joinRole: "member" } })
  assert.equal(field(switched.body, "sandbox", "joinRole"), "member", summary(switched))
  const mo = await den.signUp("Mo Member Joiner")
  assert.equal((await join(mo.token, joinToken)).status, 200)
  assert.equal(field((await den.request(mo.token, "GET", "/v1/org", { orgId })).body, "currentMember", "role"), "member")
  assert.equal(field((await den.request(ada.token, "GET", "/v1/org", { orgId })).body, "currentMember", "role"), "admin", "Ada keeps her role")
  assert.equal((await den.request(ada.token, "POST", `/v1/admin/sandbox-orgs/${id}/join-role`, { body: { joinRole: "admin" } })).status, 403, "a sandbox admin is not a platform admin")
})
