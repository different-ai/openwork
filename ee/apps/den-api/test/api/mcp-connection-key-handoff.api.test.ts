/**
 * API-key connections set up from chat: the agent creates or finds the
 * connection and asks for its key, a person saves the key in a private field,
 * and the agent carries on. The agent never sends or sees a key; a member can
 * add only their own; replacing personal keys with one shared key happens only
 * when an admin saves a working key on the connection as the request showed it.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen()
const SHARED_KEY = randomBytes(24).toString("hex")
const RILEY_KEY = randomBytes(24).toString("hex")
const WRONG_KEY = randomBytes(24).toString("hex")

const service = await startFakeMcpServer({
  tools: [{ name: "team_status", description: "Read the team status page", text: "status ok" }],
  decide({ authorization }) {
    return authorization === `Bearer ${SHARED_KEY}` || authorization === `Bearer ${RILEY_KEY}` ? { reply: true } : { reply: false, status: 401 }
  },
})
after(async () => {
  await service.close()
  await den.close()
})

let orgId = ""
let owner: Member
let riley: Member
let ownerToken = ""
let rileyToken = ""
const logs: string[] = []

before(async () => {
  const avery = await den.signUp("Avery Owner")
  const created = await den.createOrg(avery, "Key handoff")
  orgId = created.orgId
  owner = created.owner
  riley = await den.newMember(owner, orgId, "Riley Member")
  ownerToken = await den.mintMcpToken(owner, orgId)
  rileyToken = await den.mintMcpToken(riley, orgId)
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    stream.write = (chunk: string | Uint8Array, ...rest: never[]) => {
      logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return write(chunk, ...rest)
    }
  }
})

after(() => {
  const printed = logs.join("")
  for (const key of [SHARED_KEY, RILEY_KEY, WRONG_KEY]) assert.ok(!printed.includes(key), "a key reached Den's log")
})

function prompt(body: unknown) {
  return field(body, "credentialPrompt")
}

async function connection(id: string) {
  const read = await den.as(owner, orgId)("GET", `/v1/mcp-connections/${id}`)
  assert.equal(read.status, 200, summary(read))
  return read.body
}

test("a stable-key connection created without its key asks a person for it, and an upsert never duplicates it", async () => {
  const upsert = { name: "Status board", url: `${service.url}/board/mcp`, authType: "apikey", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } }
  const created = await den.callMcpTool(ownerToken, "execute_capability", { name: "putMcpConnectionsByKeyByExternalKey", path: { externalKey: "status-board" }, body: upsert })
  assert.equal(created.isError, false, created.raw)
  const id = text(field(created.body, "id"), "connection id")
  assert.deepEqual(field(prompt(created.body), "target"), { type: "mcp_connection_key", connectionId: id })
  assert.match(String(field(created.body, "nextStep")), /Never ask them to paste the key in chat/)

  // The agent tries again before anyone saved the key: same connection, asked again.
  const again = await den.callMcpTool(ownerToken, "execute_capability", { name: "putMcpConnectionsByKeyByExternalKey", path: { externalKey: "status-board" }, body: { ...upsert, name: "Status board (team)" } })
  assert.equal(again.isError, false, again.raw)
  assert.equal(field(again.body, "id"), id)
  assert.deepEqual(field(prompt(again.body), "target"), { type: "mcp_connection_key", connectionId: id })
  const listed = await den.as(owner, orgId)("GET", "/v1/mcp-connections")
  assert.equal(list(field(listed.body, "connections")).filter((entry) => entry.url === upsert.url).length, 1)

  // The agent itself can never save the key.
  const agentKey = await den.callMcpTool(ownerToken, "execute_capability", { name: "putMcpConnectionsByKeyByExternalKey", path: { externalKey: "status-board" }, body: { ...upsert, apiKey: SHARED_KEY } })
  assert.ok(agentKey.isError || !JSON.stringify(agentKey.body).includes(SHARED_KEY))
  assert.equal(field(await connection(id), "connected"), false)

  const saved = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: SHARED_KEY })
  assert.equal(saved.status, 200, summary(saved))
  assert.ok(!saved.text.includes(SHARED_KEY))
  const tools = await den.as(owner, orgId)("GET", `/v1/mcp-connections/${id}/tools`)
  assert.equal(tools.status, 200, summary(tools))
  assert.ok(tools.text.includes("team_status"))
})

test("an existing connection still waiting for its shared key can be finished from chat", async () => {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name: "Waiting board", url: `${service.url}/waiting/mcp`, authType: "apikey", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } })
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "connection id")
  const asked = await den.callMcpTool(ownerToken, "execute_capability", { name: "postMcpConnectionsCredentialPrompt", path: { connectionId: id }, body: {} })
  assert.equal(asked.isError, false, asked.raw)
  assert.equal(field(asked.body, "scope"), "shared")
  assert.deepEqual(field(prompt(asked.body), "target"), { type: "mcp_connection_key", connectionId: id })
  assert.match(String(field(asked.body, "nextStep")), new RegExp(`/dashboard/mcp-connections/${id}`))

  // A member can neither ask for nor save the organization's shared key.
  const memberAsk = await den.as(riley, orgId)("POST", `/v1/mcp-connections/${id}/credential-prompt`, { scope: "shared" })
  assert.equal(memberAsk.status, 403, summary(memberAsk))
  const memberPersonal = await den.as(riley, orgId)("POST", `/v1/mcp-connections/${id}/credential-prompt`, { scope: "personal" })
  assert.equal(memberPersonal.status, 400, summary(memberPersonal))
  const memberSave = await den.as(riley, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: RILEY_KEY })
  assert.equal(memberSave.status, 403, summary(memberSave))

  const saved = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: SHARED_KEY })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(await connection(id), "id"), id)
})

test("a member adds their own key from chat, and only for themselves", async () => {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name: "Personal board", url: `${service.url}/personal/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: true, memberIds: [], teamIds: [] } })
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "connection id")
  const asked = await den.callMcpTool(rileyToken, "execute_capability", { name: "postMcpConnectionsCredentialPrompt", path: { connectionId: id }, body: {} })
  assert.equal(asked.isError, false, asked.raw)
  assert.deepEqual(field(prompt(asked.body), "target"), { type: "mcp_connection_member_key", connectionId: id })
  assert.match(String(field(asked.body, "nextStep")), /your-connections\?connectionId=/)

  const shared = await den.callMcpTool(rileyToken, "execute_capability", { name: "postMcpConnectionsCredentialPrompt", path: { connectionId: id }, body: { scope: "shared" } })
  assert.ok(shared.isError || field(shared.body, "error") === "forbidden", shared.raw)
  const saved = await den.as(riley, orgId)("PUT", `/v1/mcp-connections/${id}/my-credential`, { apiKey: RILEY_KEY })
  assert.equal(saved.status, 200, summary(saved))
  const rileyView = list(field((await den.as(riley, orgId)("GET", "/v1/mcp-connections")).body, "connections")).find((entry) => entry.id === id)
  assert.equal(rileyView?.connectedForMe, true)
  const ownerView = list(field((await den.as(owner, orgId)("GET", "/v1/mcp-connections")).body, "connections")).find((entry) => entry.id === id)
  assert.equal(ownerView?.connectedForMe, false)
})

test("an admin replaces personal keys with one shared key only by saving a working key on an unchanged connection", async () => {
  const team = await den.createTeam(owner, orgId, "Status team", [riley.memberId])
  const access = { orgWide: false, memberIds: [owner.memberId], teamIds: [team] }
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name: "Switch board", url: `${service.url}/switch/mcp`, authType: "apikey", credentialMode: "per_member", access })
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "connection id")
  assert.equal((await den.as(riley, orgId)("PUT", `/v1/mcp-connections/${id}/my-credential`, { apiKey: RILEY_KEY })).status, 200)

  const ask = async (memberCount: number) => {
    const asked = await den.callMcpTool(ownerToken, "execute_capability", { name: "postMcpConnectionsCredentialPrompt", path: { connectionId: id }, body: { scope: "shared" } })
    assert.equal(asked.isError, false, asked.raw)
    const target = field(prompt(asked.body), "target")
    assert.equal(field(target, "type"), "mcp_connection_shared_switch")
    assert.deepEqual(field(target, "audience"), { orgWide: false, memberCount, teamCount: 1 })
    return text(field(target, "expectedUpdatedAt"), "expectedUpdatedAt")
  }
  const unchanged = async () => {
    const current = await connection(id)
    assert.equal(field(current, "credentialMode"), "per_member")
    const rileyView = list(field((await den.as(riley, orgId)("GET", "/v1/mcp-connections")).body, "connections")).find((entry) => entry.id === id)
    assert.equal(rileyView?.connectedForMe, true, "Riley's own key must keep working")
  }

  // Asking changes nothing.
  const first = await ask(1)
  await unchanged()

  // A key the service refuses changes nothing.
  const rejected = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: WRONG_KEY, expectedUpdatedAt: first })
  assert.equal(rejected.status, 400, summary(rejected))
  assert.equal(field(rejected.body, "error"), "credential_rejected")
  assert.ok(!rejected.text.includes(WRONG_KEY))
  await unchanged()

  // A card shown before someone else changed the connection changes nothing.
  assert.equal((await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/access`, { access: { ...access, memberIds: [owner.memberId, riley.memberId] } })).status, 200)
  const stale = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: SHARED_KEY, expectedUpdatedAt: first })
  assert.equal(stale.status, 409, summary(stale))
  await unchanged()

  // A member can never make the switch.
  const current = await ask(2)
  const memberSwitch = await den.as(riley, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: RILEY_KEY, expectedUpdatedAt: current })
  assert.equal(memberSwitch.status, 403, summary(memberSwitch))
  await unchanged()

  const switched = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${id}/shared-credential`, { apiKey: SHARED_KEY, expectedUpdatedAt: current })
  assert.equal(switched.status, 200, summary(switched))
  const after = await connection(id)
  assert.equal(field(after, "id"), id)
  assert.equal(field(after, "credentialMode"), "shared")
  assert.equal(field(after, "connected"), true)
  assert.deepEqual(field(after, "access", "teamIds"), [team])
  assert.deepEqual([...(field(after, "access", "memberIds") as string[])].sort(), [owner.memberId, riley.memberId].sort())
})

test("the agent finds the private key request by search and from a connection that needs a key", async () => {
  for (const query of ["add API key to connection", "fix rejected connection key", "replace connector API key"]) {
    const found = await den.callMcpTool(ownerToken, "search_capabilities", { query, limit: 5 })
    assert.equal(field(list(field(found.body, "matches"))[0], "name"), "postMcpConnectionsCredentialPrompt", `${query}: ${found.text}`)
  }

  const shared = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name: "Ledger keyhole", url: `${service.url}/ledger/mcp`, authType: "apikey", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } })
  const personal = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name: "Roster keyhole", url: `${service.url}/roster/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: true, memberIds: [], teamIds: [] } })
  for (const [created, token, name, scope, type] of [
    [shared, ownerToken, "Ledger keyhole", "shared", "mcp_connection_key"],
    [personal, rileyToken, "Roster keyhole", "personal", "mcp_connection_member_key"],
  ] as const) {
    assert.equal(created.status, 200, summary(created))
    const id = text(field(created.body, "id"), "connection id")
    const found = await den.callMcpTool(token, "search_capabilities", { query: name, limit: 5 })
    const status = list(field(found.body, "matches")).find((match) => field(match, "connectionStatus", "connectionId") === id)
    assert.ok(status, found.text)
    assert.match(String(status.hint), /connectionStatus\.action\.askForKey/)
    const askForKey = field(status, "connectionStatus", "action", "askForKey")
    assert.deepEqual(askForKey, { capability: "postMcpConnectionsCredentialPrompt", path: { connectionId: id }, body: { scope } })

    // Executed exactly as given, it shows the person the private field.
    const asked = await den.callMcpTool(token, "execute_capability", { name: field(askForKey, "capability"), path: field(askForKey, "path"), body: field(askForKey, "body") })
    assert.equal(asked.isError, false, asked.raw)
    assert.deepEqual(field(prompt(asked.body), "target"), { type, connectionId: id })
  }
})

test("Den ends the sessions it opens, and a service without DELETE support keeps working", () => {
  const deletes = service.wire.filter((entry) => entry.rpcMethod === "DELETE")
  assert.ok(deletes.length > 0, "no session was released")
  assert.ok(deletes.every((entry) => entry.status === 405))
})
