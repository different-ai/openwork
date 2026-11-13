import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text } from "./harness.js"

// Your agent's sources: what an admin lets agents read (the calendar and each connection: on for everyone, members
// choose, not allowed; mail and chat are read through their connections, with no setting of their own), what each member
// turns on with an instruction (from chat or the page), and Connect's read allowlist on the agent's own token. The
// fake service is the only provider contacted; no runner, Slack or Google.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
const service = await startFakeMcpServer({
  tools: [
    { name: "list_tickets", description: "List open tickets", text: "TICKET-7 is waiting on you", annotations: { readOnlyHint: true } },
    { name: "close_ticket", description: "Close a ticket", text: "closed", annotations: { readOnlyHint: true } },
    { name: "get_ticket", description: "Read one ticket", text: "TICKET-7" },
  ],
})
after(async () => {
  await service.close()
  await den.close()
})
const proactive = "/v1/org/workbot-settings/proactive"
const { client } = await import("../../src/db.js")

/** ARRANGE: a connection created against the fake service, then pointed at a service whose reads are reviewed. */
async function pointAt(connectionId: string, url: string) {
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  await client.query("UPDATE external_mcp_connection SET url = ? WHERE id = ?", [url, connectionId])
}

async function workspace(name: string) {
  const created = await den.createOrg(await den.signUp(`${name} Owner`), name)

  const owner = den.as(created.owner, created.orgId)
  assert.equal((await owner("PUT", proactive, { enabled: true })).status, 200)
  const connect = async (label: string, url: string) => {
    const connection = await owner("POST", "/v1/mcp-connections", { name: label, url, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } })
    assert.equal(connection.status, 200, summary(connection))
    return text(field(connection.body, "id"), "connection id")
  }
  // A service whose read tools are reviewed (never contacted here), and a custom one whose provider labels its tools.
  const connectionId = await connect("Linear", `${service.url}/mcp`)
  await pointAt(connectionId, "https://mcp.linear.app/mcp")
  const customId = await connect("Support desk", `${service.url}/mcp`)
  const member = await den.newMember(created.owner, created.orgId, `${name} member`)
  return { ...created, owner, member, call: den.as(member, created.orgId), connectionId, customId }
}

test("an admin sets what agents read: the calendar and each connection; the calendar is on for everyone by default, connections are up to members", async () => {
  const space = await workspace("Agent sources policy")
  const view = await space.owner("GET", proactive)
  assert.equal(view.status, 200, summary(view))
  assert.deepEqual(field(view.body, "settings", "sources"), { calendar: "everyone", connections: {} }, "no email or team chat setting: mail and chat are read through their connections")
  assert.deepEqual(list(field(view.body, "sourceConnections", "other")).map((entry) => entry.name), ["Linear"], "only services agents can read")
  assert.deepEqual(Object.keys(Object(field(view.body, "sourceConnections"))).sort(), ["all", "calendar", "other"], "the calendar's apps, and the connections: nothing to pick per category")

  const saved = await space.owner("PUT", proactive, { sources: { calendar: "members", connections: { [space.connectionId]: "off" } } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings", "sources"), { calendar: "members", connections: { [space.connectionId]: "off" } })
  const back = await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: null } } })
  assert.deepEqual(field(back.body, "settings", "sources", "connections"), {}, "null goes back to members choose")
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { emc_01k0000000000000000000000: "everyone" } } })).status, 400, "only the organization's own connections")
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.customId]: "everyone" } } })).status, 400, "not one agents can't read")
  assert.equal((await space.owner("PUT", proactive, { sources: { calendar: "sometimes" } })).status, 400)
  for (const removed of [{ email: "off" }, { chat: "members" }, { coreConnections: { calendar: [space.connectionId] } }, { coreDefaults: { calendar: space.connectionId } }]) {
    assert.equal((await space.owner("PUT", proactive, { sources: removed })).status, 400, `${JSON.stringify(removed)}: no longer a setting`)
  }
  assert.deepEqual(field((await space.owner("GET", proactive)).body, "settings", "sources"), { calendar: "members", connections: {} }, "a refused change saves nothing")
  assert.equal((await space.call("PUT", proactive, { sources: { calendar: "off" } })).status, 403, "members can't change the policy")
})

test("a member turns sources on and steers them, never past the admin's policy; chat and the page see the same sources", async () => {
  const space = await workspace("Agent sources member")
  const token = await den.mintMcpToken(space.member, space.orgId)
  const before = await space.call("GET", "/v1/me/agent")
  const desk = list(field(before.body, "sources")).find((source) => source.id === space.connectionId)
  assert.deepEqual([desk?.name, desk?.policy, desk?.on], ["Linear", "members", false], "a connection starts off for members")
  assert.equal(list(field(before.body, "sources")).some((source) => source.id === space.customId), false, "a service agents can't read isn't a source")
  assert.deepEqual(list(field(before.body, "sources")).map((source) => [source.id, source.kind, source.policy, source.on]), [["calendar", "calendar", "everyone", true], [space.connectionId, "other", "members", false]], "the calendar, then each connection: no email or team chat")

  // "skip Linear, and use my calendar for travel time" while Linear is on for everyone: refused, and nothing is saved.
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: "everyone" } } })).status, 200)
  const locked = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "calendar", instruction: "Count travel time." }, { source: "Linear", on: false }] } })
  assert.equal(locked.isError, true)
  assert.match(locked.text, /Linear is on for everyone in your organization\. An admin can change it in Workbot's settings\./)
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === "calendar")?.instruction, "", "nothing saved")
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: null } } })).status, 200)

  const said = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "linear", on: true, instruction: "Issues waiting on me first." }, { source: "Granola", on: true }] } })
  assert.equal(said.isError, false, said.text)
  const reply = text(field(said.body, "saved", "reply"), "reply")
  assert.match(reply, /^Saved:\n- Linear on, for “Issues waiting on me first\.”\nConnect Granola: http.+\/dashboard\/library\/connectors\/new\nReply "undo" to revert\. My bot: http.+\/dashboard\/my-bot$/)
  const page = await space.call("GET", "/v1/me/agent")
  const saved = list(field(page.body, "sources")).find((source) => source.id === space.connectionId)
  assert.deepEqual([saved?.on, saved?.instruction], [true, "Issues waiting on me first."], "the page shows what chat saved")
  const change = list(field(page.body, "changes")).find((entry) => entry.field === "source")
  assert.deepEqual([change?.sourceId, change?.source, change?.summary], [space.connectionId, "chat", "Linear on"])

  // Email and team chat name no source: asking for one is a "Connect" line, like any name nobody connected.
  const gone = await space.call("PUT", "/v1/me/agent", { sources: [{ source: "email", on: false }, { source: "Team chat", on: false }] })
  assert.equal(gone.status, 200, summary(gone))
  assert.deepEqual(list(field(gone.body, "saved", "connect")).map((entry) => entry.name), ["email", "Team chat"])
  assert.deepEqual(field(gone.body, "saved", "changes"), [])

  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: "off" } } })).status, 200)
  const widen = await space.call("PUT", "/v1/me/agent", { sources: [{ source: space.connectionId, instruction: "Anything" }] })
  assert.equal(widen.status, 400, summary(widen))
  assert.deepEqual(widen.body, { error: "source_not_allowed", message: "Linear isn't allowed for agents in your organization. An admin can change it in Workbot's settings." })
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.connectionId)?.on, false, "the admin's not allowed wins over what the member saved")
})

test("Connect never lets an agent's token call a tool its provider merely labels read-only; plain read tokens stay refused", async () => {
  const space = await workspace("Agent sources allowlist")
  const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
  const { agentReadScopes } = await import("../../src/mcp/agent-read-sources.js")
  const userId = space.member.userId
  // Even with the custom service on its allowlist (Den never puts it there), nothing it labels read-only is callable.
  const agent = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true, scopes: agentReadScopes({ kinds: [], connectionIds: [space.customId] }) })).token
  const plain = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true })).token
  const capability = (tool: string) => `mcp:${space.customId}:${tool}`
  for (const [token, tool, why] of [[agent, "list_tickets", "labelled read-only with a read-shaped name: still not reviewed"], [agent, "close_ticket", "a write labelled read-only"], [agent, "get_ticket", "no hint at all"], [plain, "list_tickets", "a plain read token never calls a connection's tools"]] as const) {
    const refused = await den.callMcpTool(token, "execute_capability", { name: capability(tool) })
    assert.equal(refused.isError, true, `${why}: ${refused.text}`)
    assert.match(refused.text, /insufficient_mcp_scope/, why)
  }
  assert.equal(service.wire.filter((entry) => entry.rpcMethod === "tools/call").length, 0, "no refused call reached the service")
  const found = await den.callMcpTool(agent, "search_capabilities", { query: "tickets", limit: 10 })
  const names = list(field(found.structured ?? found.body, "matches")).map((match) => String(match.name))
  assert.ok(!names.some((name) => name.startsWith(`mcp:${space.customId}:`)), `the agent finds none of them: ${names.join(",")}`)
})

test("an admin can't add an MCP without reviewed read tools as a source", async () => {
  const space = await workspace("Agent sources unreviewed MCP")
  const listed = await space.owner("GET", proactive)
  assert.equal(list(field(listed.body, "sourceConnections", "all")).some((entry) => entry.id === space.customId), false, "it isn't offered")
  for (const sources of [{ otherConnections: [space.customId] }, { connections: { [space.customId]: "everyone" } }]) {
    const refused = await space.owner("PUT", proactive, { sources })
    assert.equal(refused.status, 400, `${JSON.stringify(sources)}: ${summary(refused)}`)
  }
})

test("no calendar app is picked by an admin; a member's calendar reads one automatically, and only a calendar app can be picked for it", async () => {
  const space = await workspace("Agent sources calendar")
  const linear = space.connectionId
  const view = await space.owner("GET", proactive)
  assert.deepEqual(field(view.body, "sourceConnections", "calendar"), [], "no Google Workspace or Microsoft 365 here: nothing serves the calendar")
  const linearEntry = list(field(view.body, "sourceConnections", "all")).find((entry) => entry.id === linear)
  assert.deepEqual([linearEntry?.slots, linearEntry?.connectedMembers], [["other"], null], "a connection of its own, never a calendar app; a shared credential: who uses it isn't known")

  // The member's view: the calendar reads one calendar app (none here), chosen automatically; a connection reads itself.
  const sources = list(field((await space.call("GET", "/v1/me/agent")).body, "sources"))
  const calendar = sources.find((source) => source.id === "calendar")
  assert.deepEqual([calendar?.options, calendar?.connections, calendar?.chosenBy], [[], [], null])
  const other = sources.find((source) => source.id === linear)
  assert.deepEqual([other?.options, other?.chosenBy], [[], null])

  const refused = await space.call("PUT", "/v1/me/agent", { sources: [{ source: "calendar", connectionId: linear }] })
  assert.equal(refused.status, 400, summary(refused))
  assert.deepEqual(refused.body, { error: "connection_not_allowed", message: "Calendar can't read from that connection. Choose one of your organization's calendar apps." })
  const own = await space.call("PUT", "/v1/me/agent", { sources: [{ source: "Linear", connectionId: linear }] })
  assert.equal(own.status, 400, summary(own))
  assert.deepEqual(own.body, { error: "connection_not_allowed", message: "Linear always reads its own connection. Only the calendar reads from a connection you pick." })
})
