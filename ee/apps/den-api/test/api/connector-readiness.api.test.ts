/**
 * ENG-866: connectors with no stored check were shown as "Couldn't verify".
 * The admin list now reports the connector's own status separately from the
 * caller's, and one call brings unchecked connectors up to date: a member's
 * still-valid Ready check is copied onto a per-member connector, the rest are
 * checked with a credential the caller can use, and nothing is invented for
 * connectors nobody can check yet.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen()
const SHARED_KEY = randomBytes(24).toString("hex")
const RILEY_KEY = randomBytes(24).toString("hex")
const OWNER_KEY = randomBytes(24).toString("hex")

/** Per-path answers the fake service gives after a key was saved; default is to speak MCP. */
const outage = new Map<string, number>()
const service = await startFakeMcpServer({
  tools: [{ name: "status", description: "Read status", text: "ok" }],
  decide({ path, authorization }) {
    const status = [...outage].find(([prefix]) => path.startsWith(prefix))?.[1]
    if (status) return { reply: false, status }
    return [SHARED_KEY, RILEY_KEY, OWNER_KEY].some((key) => authorization === `Bearer ${key}`) ? { reply: true } : { reply: false, status: 401 }
  },
})
after(async () => {
  await service.close()
  await den.close()
})

let orgId = ""
let owner: Member
let riley: Member

before(async () => {
  const created = await den.createOrg(await den.signUp("Avery Owner"), "Readiness org")
  orgId = created.orgId
  owner = created.owner
  riley = await den.newMember(owner, orgId, "Riley Member")
})

/** ARRANGE ONLY: a connection set up before checks were recorded has none stored, for the connector or anyone. */
async function forgetChecks(connectionId: string) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("forgetChecks needs MySQL mode")
  await client.execute("UPDATE external_mcp_connection SET readiness_check = NULL WHERE id = ?", [connectionId])
  await client.execute("UPDATE connected_account SET readiness_check = NULL WHERE provider_id = ?", [connectionId])
}

/** ARRANGE ONLY: a member checked before connector-level status existed, so only their own check is stored. */
async function forgetConnectorCheck(connectionId: string) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("forgetConnectorCheck needs MySQL mode")
  await client.execute("UPDATE external_mcp_connection SET readiness_check = NULL WHERE id = ?", [connectionId])
}

async function create(member: Member, name: string, credentialMode: "shared" | "per_member") {
  const created = await den.as(member, orgId)("POST", "/v1/mcp-connections", {
    name, url: `${service.url}/${name.toLowerCase().replace(/\W+/g, "-")}/mcp`, authType: "apikey", credentialMode, access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

async function adminRow(id: string) {
  const listed = await den.as(owner, orgId)("GET", "/v1/mcp-connections?scope=manageable")
  assert.equal(listed.status, 200, summary(listed))
  const row = list(field(listed.body, "connections")).find((entry) => entry.id === id)
  assert.ok(row, `connection ${id} missing from the admin list`)
  return row
}

async function memberRow(member: Member, id: string) {
  const listed = await den.as(member, orgId)("GET", "/v1/mcp-connections")
  return list(field(listed.body, "connections")).find((entry) => entry.id === id)
}

async function refresh(ids: string[]) {
  const called = await den.as(owner, orgId)("POST", "/v1/mcp-connections/readiness-checks", { connectionIds: ids })
  assert.equal(called.status, 200, summary(called))
  return Object.fromEntries(list(field(called.body, "results")).map((entry) => [String(entry.connectionId), entry.outcome]))
}

const probes = (pathPrefix: string) => service.wire.filter((entry) => entry.path.startsWith(pathPrefix) && entry.rpcMethod === "tools/list").length

test("a shared connector never checked is reported as not checked, then checked once without repeating", async () => {
  const id = await create(owner, "Ledger", "shared")
  assert.equal((await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: SHARED_KEY })).status, 200)
  await forgetChecks(id)

  const before = await adminRow(id)
  assert.equal(before.readiness, null, "no stored check is null, not a failure")
  assert.equal(before.organizationReadiness, null)

  assert.deepEqual(await refresh([id]), { [id]: "checked" })
  const checked = await adminRow(id)
  assert.equal(field(checked, "organizationReadiness", "status"), "ready")
  assert.equal(field(checked, "organizationReadiness", "failure"), null)
  assert.ok(Date.parse(String(field(checked, "organizationReadiness", "checkedAt"))) > 0)

  // Reloading the page does not call the service again.
  const calls = probes("/ledger/")
  assert.deepEqual(await refresh([id]), { [id]: "already_checked" })
  assert.equal(probes("/ledger/"), calls)
})

test("a real failure is recorded with its cause, and only a rejected sign-in is a sign-in problem", async () => {
  const down = await create(owner, "Outage board", "shared")
  const rejected = await create(owner, "Rejected board", "shared")
  for (const id of [down, rejected]) assert.equal((await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: SHARED_KEY })).status, 200)
  await forgetChecks(down)
  await forgetChecks(rejected)
  outage.set("/outage-board/", 500)
  outage.set("/rejected-board/", 401)
  try {
    assert.deepEqual(await refresh([down, rejected]), { [down]: "checked", [rejected]: "checked" })
  } finally {
    outage.clear()
  }
  const failed = await adminRow(down)
  assert.equal(field(failed, "organizationReadiness", "status"), "could_not_verify")
  assert.ok(["unavailable", "tools_unreadable"].includes(String(field(failed, "organizationReadiness", "failure"))), JSON.stringify(failed.organizationReadiness))
  assert.ok(String(field(failed, "organizationReadiness", "reason")).length > 0)

  const signIn = await adminRow(rejected)
  assert.equal(field(signIn, "organizationReadiness", "status"), "could_not_verify")
  assert.equal(field(signIn, "organizationReadiness", "failure"), "sign_in_rejected")

  // A stored failure is not re-checked on page load; Check again does that.
  assert.deepEqual(await refresh([down]), { [down]: "already_checked" })
  const again = await den.as(owner, orgId)("POST", `/v1/mcp-connections/${down}/check`)
  assert.equal(again.status, 200, summary(again))
  assert.equal(field(again.body, "readiness", "status"), "ready")
  assert.equal(field(await adminRow(down), "organizationReadiness", "status"), "ready")
})

test("a member's working sign-in shows the per-member connector as Ready to admins, but never Ready for anyone else", async () => {
  const id = await create(owner, "Roster", "per_member")
  assert.equal((await den.as(riley, orgId)("PUT", `/v1/mcp-connections/${id}/my-credential`, { apiKey: RILEY_KEY })).status, 200)

  // Saving Riley's key checked it; Riley sees their own Ready, and so does the connector.
  assert.equal(field(await memberRow(riley, id), "readiness", "status"), "ready")
  assert.equal(field(await adminRow(id), "organizationReadiness", "status"), "ready")

  // Before connector-level status existed only Riley's check was stored: the list reads it as not checked,
  // and the refresh copies Riley's still-valid Ready check without calling the service.
  await forgetConnectorCheck(id)
  assert.equal((await adminRow(id)).organizationReadiness, null)
  const calls = probes("/roster/")
  assert.deepEqual(await refresh([id]), { [id]: "copied_from_member" })
  assert.equal(probes("/roster/"), calls)
  const admin = await adminRow(id)
  assert.equal(field(admin, "organizationReadiness", "status"), "ready")

  // The owner never signed in: their own status stays unchecked and they still need to sign in.
  assert.equal(admin.readiness, null)
  assert.equal(admin.connectedForMe, false)
  assert.equal(field(await memberRow(owner, id), "readiness"), null)
})

test("a per-member connector nobody has checked is checked with the admin's own sign-in, or left not checked", async () => {
  const nobody = await create(owner, "Unsigned", "per_member")
  const mine = await create(owner, "Mine", "per_member")
  assert.equal((await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${mine}/my-credential`, { apiKey: OWNER_KEY })).status, 200)
  await forgetChecks(nobody)
  await forgetChecks(mine)

  assert.deepEqual(await refresh([nobody, mine]), { [nobody]: "not_checkable", [mine]: "checked" })
  assert.equal((await adminRow(nobody)).organizationReadiness, null, "nothing is invented for a connector nobody can check")
  assert.equal(field(await adminRow(mine), "organizationReadiness", "status"), "ready")
  assert.equal(field(await adminRow(mine), "readiness", "status"), "ready")
})

test("the admin's own failed check is shown without being copied to the connector for everyone", async () => {
  const id = await create(owner, "Flaky", "per_member")
  assert.equal((await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/my-credential`, { apiKey: OWNER_KEY })).status, 200)
  await forgetChecks(id)
  outage.set("/flaky/", 503)
  try {
    assert.deepEqual(await refresh([id]), { [id]: "checked" })
  } finally {
    outage.clear()
  }
  const admin = await adminRow(id)
  assert.equal(field(admin, "organizationReadiness", "status"), "could_not_verify")
  // Riley signs in later and it works: the connector is Ready again.
  assert.equal((await den.as(riley, orgId)("PUT", `/v1/mcp-connections/${id}/my-credential`, { apiKey: RILEY_KEY })).status, 200)
  assert.equal(field(await adminRow(id), "organizationReadiness", "status"), "ready")
  assert.equal(field(await adminRow(id), "readiness", "status"), "could_not_verify", "the owner's own check is unchanged")
})

test("only connection managers can run checks, and unknown ids are reported, not checked", async () => {
  const id = await create(owner, "Guarded", "shared")
  const member = await den.as(riley, orgId)("POST", "/v1/mcp-connections/readiness-checks", { connectionIds: [id] })
  assert.equal(member.status, 403, summary(member))
  assert.deepEqual(await refresh(["emc_doesnotexist"]), { emc_doesnotexist: "not_found" })
  const tooMany = await den.as(owner, orgId)("POST", "/v1/mcp-connections/readiness-checks", { connectionIds: Array.from({ length: 51 }, (_, index) => `id-${index}`) })
  assert.equal(tooMany.status, 400, summary(tooMany))
})
