import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text } from "./harness.js"

// Your agent's sources: what an admin lets agents read (on for everyone, members choose, not allowed), what each member
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
  for (const feature of ["workbotProactive", "workbotAgentLibrary"]) assert.equal((await den.setFeature(created.orgId, feature, true)).status, 200)
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

test("an admin sets what agents read per source; defaults are calendar, email and chat for everyone, other connections up to members", async () => {
  const space = await workspace("Agent sources policy")
  const view = await space.owner("GET", proactive)
  assert.equal(view.status, 200, summary(view))
  assert.deepEqual(field(view.body, "settings", "sources"), { calendar: "everyone", email: "everyone", chat: "everyone", connections: {} })
  assert.deepEqual(list(field(view.body, "sourceConnections", "other")).map((entry) => entry.name), ["Linear"], "only services agents can read")

  const saved = await space.owner("PUT", proactive, { sources: { chat: "members", connections: { [space.connectionId]: "off" } } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings", "sources"), { calendar: "everyone", email: "everyone", chat: "members", connections: { [space.connectionId]: "off" } })
  const back = await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: null } } })
  assert.deepEqual(field(back.body, "settings", "sources", "connections"), {}, "null goes back to members choose")
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { emc_01k0000000000000000000000: "everyone" } } })).status, 400, "only the organization's own connections")
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.customId]: "everyone" } } })).status, 400, "not one agents can't read")
  assert.equal((await space.owner("PUT", proactive, { sources: { email: "sometimes" } })).status, 400)
  assert.equal((await space.call("PUT", proactive, { sources: { email: "off" } })).status, 403, "members can't change the policy")
})

test("a member turns sources on and steers them, never past the admin's policy; chat and the page see the same sources", async () => {
  const space = await workspace("Agent sources member")
  const token = await den.mintMcpToken(space.member, space.orgId)
  const before = await space.call("GET", "/v1/me/agent")
  const desk = list(field(before.body, "sources")).find((source) => source.id === space.connectionId)
  assert.deepEqual([desk?.name, desk?.policy, desk?.on], ["Linear", "members", false], "another connection starts off for members")
  assert.equal(list(field(before.body, "sources")).some((source) => source.id === space.customId), false, "a service agents can't read isn't a source")
  assert.deepEqual(list(field(before.body, "sources")).slice(0, 3).map((source) => [source.id, source.policy, source.on]), [["calendar", "everyone", true], ["email", "everyone", true], ["chat", "everyone", true]])

  // "also look at Linear for issues waiting on me, and skip team chat" (chat is on for everyone: refused)
  const locked = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "Linear", on: true }, { source: "Team chat", on: false }] } })
  assert.equal(locked.isError, true)
  assert.match(locked.text, /Team chat is on for everyone in your organization\. An admin can change it in Manage › Workbot\./)
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.connectionId)?.on, false, "nothing saved")

  const said = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "linear", on: true, instruction: "Issues waiting on me first." }, { source: "Granola", on: true }] } })
  assert.equal(said.isError, false, said.text)
  const reply = text(field(said.body, "saved", "reply"), "reply")
  assert.match(reply, /^Saved:\n- Linear on, for “Issues waiting on me first\.”\nConnect Granola: http.+\/dashboard\/library\/connectors\/new\nReply "undo" to revert\. My bot: http.+\/dashboard\/my-bot$/)
  const page = await space.call("GET", "/v1/me/agent")
  const saved = list(field(page.body, "sources")).find((source) => source.id === space.connectionId)
  assert.deepEqual([saved?.on, saved?.instruction], [true, "Issues waiting on me first."], "the page shows what chat saved")
  const change = list(field(page.body, "changes")).find((entry) => entry.field === "source")
  assert.deepEqual([change?.sourceId, change?.source, change?.summary], [space.connectionId, "chat", "Linear on"])

  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: "off" } } })).status, 200)
  const widen = await space.call("PUT", "/v1/me/agent", { sources: [{ source: space.connectionId, instruction: "Anything" }] })
  assert.equal(widen.status, 400, summary(widen))
  assert.deepEqual(widen.body, { error: "source_not_allowed", message: "Linear isn't allowed for agents in your organization. An admin can change it in Manage › Workbot." })
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.connectionId)?.on, false, "the admin's not allowed wins over what the member saved")
})

test("Connect never lets an agent's token call a tool its provider merely labels read-only; plain read tokens stay refused", async () => {
  const space = await workspace("Agent sources allowlist")
  const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
  const { agentReadScopes } = await import("../../src/mcp/agent-read-sources.js")
  const userId = space.member.userId
  // Even with the custom service on its allowlist (Den never puts it there), nothing it labels read-only is callable.
  const agent = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true, scopes: agentReadScopes({ kinds: ["chat"], connectionIds: [space.customId] }) })).token
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

test("an admin can't add an MCP without reviewed read tools as a source, in any category", async () => {
  const space = await workspace("Agent sources unreviewed MCP")
  const listed = await space.owner("GET", proactive)
  assert.equal(list(field(listed.body, "sourceConnections", "all")).some((entry) => entry.id === space.customId), false, "it isn't offered")
  for (const sources of [{ coreConnections: { email: [space.customId] } }, { otherConnections: [space.customId] }, { connections: { [space.customId]: "everyone" } }]) {
    const refused = await space.owner("PUT", proactive, { sources })
    assert.equal(refused.status, 400, `${JSON.stringify(sources)}: ${summary(refused)}`)
  }
})

test("an admin allows apps per category and sets a default; each member's agent reads one, and picks another within the allowed ones", async () => {
  const space = await workspace("Agent sources guardrails")
  const linear = space.connectionId

  // The default has to be allowed first (here in the same change), and can't be an MCP without reviewed reads.
  assert.equal((await space.owner("PUT", proactive, { sources: { coreDefaults: { email: linear } } })).status, 400, "not allowed for email yet")
  assert.equal((await space.owner("PUT", proactive, { sources: { coreDefaults: { email: space.customId } } })).status, 400)
  const saved = await space.owner("PUT", proactive, { sources: { coreConnections: { email: [linear] }, coreDefaults: { email: linear } } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings", "sources", "coreDefaults"), { email: linear })
  assert.equal(field(saved.body, "sourceConnections", "defaults", "email"), linear, "the effective default")
  const linearEntry = list(field(saved.body, "sourceConnections", "all")).find((entry) => entry.id === linear)
  assert.equal(linearEntry?.connectedMembers, null, "a shared credential: who uses it isn't known")

  const removeDefault = await space.owner("PUT", proactive, { sources: { coreConnections: { email: [] } } })
  assert.equal(removeDefault.status, 400, summary(removeDefault))
  assert.match(text(field(removeDefault.body, "message"), "message"), /Choose another default first\./)

  // The member's view: one connection read, the allowed ones to pick from, and who picked it.
  const before = list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === "email")
  assert.deepEqual(list(before?.options).map((option) => option.id), [linear])
  assert.deepEqual(list(before?.connections).map((connection) => connection.id), [linear])
  assert.equal(before?.chosenBy, "admin")
  const other = list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === linear)
  assert.deepEqual([other?.options, other?.chosenBy], [[], null])

  const refused = await space.call("PUT", "/v1/me/agent", { sources: [{ source: "email", connectionId: space.customId }] })
  assert.equal(refused.status, 400, summary(refused))
  assert.equal(field(refused.body, "error"), "connection_not_allowed")

  const picked = await space.call("PUT", "/v1/me/agent", { sources: [{ source: "my email", connectionId: linear }] })
  assert.equal(picked.status, 200, summary(picked))
  assert.match(text(field(picked.body, "saved", "reply"), "reply"), /^Saved:\n- Email: reads Linear\nReply "undo" to revert\./)
  assert.equal(list(field(picked.body, "sources")).find((source) => source.id === "email")?.chosenBy, "member")
  const undone = await space.call("PUT", "/v1/me/agent", { undo: "last" })
  assert.equal(undone.status, 200, summary(undone))
  assert.equal(list(field(undone.body, "sources")).find((source) => source.id === "email")?.chosenBy, "admin", "undo goes back to the admin's default")
})
