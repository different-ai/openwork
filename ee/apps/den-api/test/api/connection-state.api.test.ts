import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen()
let unavailable = false
const service = await startFakeMcpServer({
  tools: [{ name: "read_notes", description: "Read team notes", text: "Notes." }],
  decide({ path }) {
    return unavailable && path.startsWith("/shared")
      ? { reply: false, status: 503, body: "Service unavailable" }
      : { reply: true }
  },
})
after(async () => { await service.close(); await den.close() })

const { orgId, owner } = await den.createOrg(await den.signUp("Connection Owner"), "Connection states")
const teammate = await den.newMember(owner, orgId, "Connection Member")

async function connection(name: string, path: string, authType: "none" | "apikey", credentialMode: "shared" | "per_member") {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", {
    name, url: `${service.url}${path}/mcp`, authType, credentialMode, access: { orgWide: true },
  })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

async function state(person: Member, id: string) {
  const response = await den.as(person, orgId)("GET", "/v1/me/library")
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.text.includes("synthetic-personal-notes-key"), false)
  const item = list(field(response.body, "items")).find((entry) => entry.id === id)
  assert.ok(item, `connection ${id} is in the member's library`)
  return item.state
}

async function readiness(person: Member, id: string) {
  const response = await den.as(person, orgId)("GET", "/v1/mcp-connections")
  assert.equal(response.status, 200, summary(response))
  const row = list(field(response.body, "connections")).find((entry) => entry.id === id)
  assert.ok(row, `connection ${id} is listed`)
  return field(row, "readiness", "status")
}

test("a failed shared connection check changes readiness without revoking member access; only an administrator can check again", async () => {
  const id = await connection("Team Notes", "/shared", "none", "shared")
  assert.equal(await state(teammate, id), "connected")
  assert.equal(await readiness(owner, id), "ready")
  unavailable = true
  try {
    const checked = await den.as(owner, orgId)("POST", `/v1/mcp-connections/${id}/check`)
    assert.equal(checked.status, 200, summary(checked))
    assert.equal(await readiness(owner, id), "could_not_verify")
    assert.equal(await readiness(teammate, id), "could_not_verify")
    assert.equal(await state(teammate, id), "connected")
    const denied = await den.as(teammate, orgId)("POST", `/v1/mcp-connections/${id}/check`)
    assert.equal(denied.status, 403, summary(denied))
  } finally { unavailable = false }
  const restored = await den.as(owner, orgId)("POST", `/v1/mcp-connections/${id}/check`)
  assert.equal(restored.status, 200, summary(restored))
  assert.equal(await readiness(owner, id), "ready")
  assert.equal(await state(teammate, id), "connected")
})

test("personal sign-in and disconnect affect only that member and leave a shared connection usable", async () => {
  const shared = await connection("Shared Reference", "/reference", "none", "shared")
  const personal = await connection("Personal Notes", "/personal", "apikey", "per_member")
  assert.equal(await state(owner, personal), "needs_signin")
  assert.equal(await state(teammate, personal), "needs_signin")
  const saved = await den.as(teammate, orgId)("PUT", `/v1/mcp-connections/${personal}/my-credential`, { apiKey: "synthetic-personal-notes-key" })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(await state(teammate, personal), "connected")
  assert.equal(await state(owner, personal), "needs_signin")
  const disconnected = await den.as(teammate, orgId)("POST", `/v1/mcp-connections/${personal}/disconnect-my-account`)
  assert.equal(disconnected.status, 200, summary(disconnected))
  assert.equal(await state(teammate, personal), "needs_signin")
  assert.equal(await state(owner, personal), "needs_signin")
  assert.equal(await state(teammate, shared), "connected")
})
