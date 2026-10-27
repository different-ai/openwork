/**
 * Personal API keys on MCP connections: each member's call carries only their
 * own key, nobody reads a key back, leaving the team removes the key, malformed
 * keys are refused, a redirect never forwards the key and a service error that
 * repeats the key does not leak it. Ported from evals/core/secure-keys-in-chat
 * and evals/specs/member-api-key-*.test.ts.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text, type McpToolResult, type Member } from "./harness.js"

const den = await bootDen()
const STATUS_KEY = randomBytes(24).toString("hex")
const PROOF = `status-proof-${randomBytes(6).toString("hex")}`

/**
 * The outside service. It accepts only STATUS_KEY; /redirect answers a valid
 * key with a 307 to /followed, and /echo answers tools/call with an error that
 * repeats the key it was sent.
 */
const service = await startFakeMcpServer({
  tools: [{ name: "team_status", description: "Read the team status page", text: PROOF }],
  decide({ path, authorization }) {
    if (path.startsWith("/followed")) return { reply: false, status: 400 }
    if (authorization !== `Bearer ${STATUS_KEY}`) return { reply: false, status: 401 }
    if (path.startsWith("/redirect")) return { reply: false, status: 307, headers: { location: "/followed/mcp" } }
    return { reply: true }
  },
  toolResult({ path, authorization }) {
    if (path.startsWith("/echo")) return { isError: true, text: `403 forbidden Authorization: ${authorization}` }
    return { isError: false, text: PROOF }
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

before(async () => {
  const avery = await den.signUp("Avery Owner")
  const created = await den.createOrg(avery, "Secure keys")
  orgId = created.orgId
  owner = created.owner
  riley = await den.newMember(owner, orgId, "Riley Member")
  ownerToken = await den.mintMcpToken(owner, orgId)
  rileyToken = await den.mintMcpToken(riley, orgId)
})

function refused(result: McpToolResult): boolean {
  return result.isError || result.rpcError !== null
}

async function personalKeyConnection(name: string, path: string, access: Record<string, unknown>): Promise<string> {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name, url: `${service.url}${path}`, authType: "apikey", credentialMode: "per_member", access })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

function saveKey(member: Member, connectionId: string, apiKey: string) {
  return den.as(member, orgId)("PUT", `/v1/mcp-connections/${connectionId}/my-credential`, { apiKey })
}

function wireSince(start: number, prefix: string) {
  // The MCP SDK opens its optional SSE GET in the background after initialize.
  // It can arrive after a later member's call starts. Attribute only that GET
  // to its earlier session; keep all new handshakes and tool calls observable,
  // including an unauthorized call that reuses another member's session.
  const earlierSessions = new Map(service.wire.slice(0, start)
    .filter((entry) => entry.rpcMethod === "initialize" && entry.status === 200 && entry.sessionId)
    .map((entry) => [entry.sessionId, entry]))
  return service.wire.slice(start).filter((entry) => {
    if (!entry.path.startsWith(prefix)) return false
    const earlier = entry.sessionId ? earlierSessions.get(entry.sessionId) : undefined
    return !(entry.rpcMethod === "GET" && entry.status === 405
      && earlier?.path === entry.path && earlier.authorization === entry.authorization)
  })
}

/** Everything den-api prints while `run` runs. */
async function capturingLogs<T>(run: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const chunks: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  const capture = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }
  process.stdout.write = capture
  process.stderr.write = capture
  try {
    return { value: await run(), logs: chunks.join("") }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

test("with individual keys, each call carries only the caller's own key, malformed keys are refused, and nobody can read a key back", async () => {
  const id = await personalKeyConnection("Personal status service", "/personal/mcp", { orgWide: true })
  const capability = { name: `mcp:${id}:team_status`, body: {} }

  const ownerSaved = await saveKey(owner, id, STATUS_KEY)
  assert.equal(ownerSaved.status, 200, summary(ownerSaved))
  const ownerStart = service.wire.length
  const ownerCall = await den.callMcpTool(ownerToken, "execute_capability", capability)
  assert.equal(refused(ownerCall), false, ownerCall.raw.slice(0, 400))
  assert.ok(ownerCall.raw.includes(PROOF))
  const ownerCalls = wireSince(ownerStart, "/personal").filter((entry) => entry.rpcMethod === "tools/call")
  assert.equal(ownerCalls.length, 1)
  assert.equal(ownerCalls[0]?.authorization, `Bearer ${STATUS_KEY}`)

  // Riley may use the connection but has no key yet: the owner's key is not lent to her.
  const noKeyStart = service.wire.length
  // Reproduce an earlier owner's background SSE request arriving in this window.
  const ownerSession = ownerCalls[0]?.sessionId
  assert.ok(ownerSession)
  const lateStream = await fetch(`${service.url}/personal/mcp`, {
    headers: { authorization: `Bearer ${STATUS_KEY}`, "mcp-session-id": ownerSession },
  })
  assert.equal(lateStream.status, 405)
  await lateStream.body?.cancel()
  const noKey = await den.callMcpTool(rileyToken, "execute_capability", capability)
  assert.equal(refused(noKey), true)
  assert.deepEqual(wireSince(noKeyStart, "/personal"), [])

  const injected = await saveKey(riley, id, "x\r\nCookie: y")
  assert.equal(injected.status, 400, summary(injected))

  const rileyKey = `riley-${randomBytes(12).toString("hex")}`
  // Saving checks the key with the service, so count Riley's traffic from the save on.
  const ownStart = service.wire.length
  const rileySaved = await saveKey(riley, id, rileyKey)
  assert.equal(rileySaved.status, 200, summary(rileySaved))
  const own = await den.callMcpTool(rileyToken, "execute_capability", capability)
  assert.equal(refused(own), true, "the service refuses Riley's key")
  const ownSent = wireSince(ownStart, "/personal")
  assert.ok(ownSent.length > 0)
  for (const entry of ownSent) assert.equal(entry.authorization, `Bearer ${rileyKey}`)
  assert.equal(own.raw.includes(rileyKey), false)
  assert.equal(own.raw.includes(STATUS_KEY), false)

  // Reading a key back is not a thing, for its owner or for the admin.
  const readBack = await den.as(riley, orgId)("GET", `/v1/mcp-connections/${id}/my-credential`)
  assert.equal(readBack.status, 404, summary(readBack))
  const rileyList = await den.as(riley, orgId)("GET", "/v1/mcp-connections")
  const row = list(field(rileyList.body, "connections")).find((entry) => entry.id === id)
  assert.ok(row, "Riley's list shows the connection")
  const adminView = await den.as(owner, orgId)("GET", `/v1/mcp-connections/${id}`)
  assert.equal(adminView.status, 200, summary(adminView))
  for (const seen of [JSON.stringify(row), rileyList.text, adminView.text, readBack.text]) {
    assert.equal(seen.includes(rileyKey), false)
    assert.equal(seen.includes(STATUS_KEY), false)
  }
})

test("a member cannot save a key for a connection they were not given, and nothing reaches the service", async () => {
  const ownerOnly = await personalKeyConnection("Owner-only status service", "/owner-only/mcp", { orgWide: false, memberIds: [owner.memberId] })
  const start = service.wire.length
  const saved = await saveKey(riley, ownerOnly, `riley-${randomBytes(8).toString("hex")}`)
  assert.equal(saved.status, 403, summary(saved))
  const call = await den.callMcpTool(rileyToken, "execute_capability", { name: `mcp:${ownerOnly}:team_status`, body: {} })
  assert.equal(refused(call), true)
  assert.deepEqual(wireSince(start, "/owner-only"), [])
})

test("leaving the team that gives a connection removes the person's key from it", async () => {
  const teamId = await den.createTeam(owner, orgId, "Status readers", [riley.memberId])
  const id = await personalKeyConnection("Team status service", "/team/mcp", { orgWide: false, teamIds: [teamId] })
  const capability = { name: `mcp:${id}:team_status`, body: {} }
  const saved = await saveKey(riley, id, STATUS_KEY)
  assert.equal(saved.status, 200, summary(saved))
  const working = await den.callMcpTool(rileyToken, "execute_capability", capability)
  assert.equal(refused(working), false, working.raw.slice(0, 400))

  const removed = await den.as(owner, orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [] })
  assert.equal(removed.status, 200, summary(removed))
  const removedStart = service.wire.length
  assert.equal(refused(await den.callMcpTool(rileyToken, "execute_capability", capability)), true)
  const saveAgain = await saveKey(riley, id, STATUS_KEY)
  assert.equal(saveAgain.status, 403, summary(saveAgain))

  // Back on the team, the old key is gone: she must enter it again.
  const readded = await den.as(owner, orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [riley.memberId] })
  assert.equal(readded.status, 200, summary(readded))
  assert.equal(refused(await den.callMcpTool(rileyToken, "execute_capability", capability)), true)
  assert.deepEqual(wireSince(removedStart, "/team"), [])
  const rileyList = await den.as(riley, orgId)("GET", "/v1/mcp-connections")
  const row = list(field(rileyList.body, "connections")).find((entry) => entry.id === id)
  assert.equal(field(row, "connectedForMe"), false)
})

test("a personal key is never sent on through a redirect, nor repeated back from a service error", async () => {
  const moved = await personalKeyConnection("Moved status service", "/redirect/mcp", { orgWide: true })
  assert.equal((await saveKey(owner, moved, STATUS_KEY)).status, 200)
  const movedStart = service.wire.length
  const movedCall = await den.callMcpTool(ownerToken, "execute_capability", { name: `mcp:${moved}:team_status`, body: {} })
  assert.equal(refused(movedCall), true)
  assert.ok(wireSince(movedStart, "/redirect").length > 0, "Den called the service")
  assert.deepEqual(wireSince(movedStart, "/followed"), [], "Den did not follow the redirect with the key")

  const echoing = await personalKeyConnection("Echoing status service", "/echo/mcp", { orgWide: true })
  assert.equal((await saveKey(owner, echoing, STATUS_KEY)).status, 200)
  const echoStart = service.wire.length
  const { value: echoed, logs } = await capturingLogs(() => den.callMcpTool(ownerToken, "execute_capability", { name: `mcp:${echoing}:team_status`, body: {} }))
  assert.ok(wireSince(echoStart, "/echo").some((entry) => entry.rpcMethod === "tools/call"), "the service answered the call")
  assert.equal(echoed.isError, true)
  assert.equal(echoed.raw.includes(STATUS_KEY), false, "the reply repeats the key")
  assert.equal(logs.includes(STATUS_KEY), false, "den-api logged the key")
})
