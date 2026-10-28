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

async function workspace(name: string) {
  const created = await den.createOrg(await den.signUp(`${name} Owner`), name)
  for (const feature of ["workbotProactive", "workbotAgentLibrary"]) assert.equal((await den.setFeature(created.orgId, feature, true)).status, 200)
  const owner = den.as(created.owner, created.orgId)
  assert.equal((await owner("PUT", proactive, { enabled: true })).status, 200)
  const connection = await owner("POST", "/v1/mcp-connections", { name: "Support desk", url: `${service.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } })
  assert.equal(connection.status, 200, summary(connection))
  const member = await den.newMember(created.owner, created.orgId, `${name} member`)
  return { ...created, owner, member, call: den.as(member, created.orgId), connectionId: text(field(connection.body, "id"), "connection id") }
}

test("an admin sets what agents read per source; defaults are calendar, email and chat for everyone, other connections up to members", async () => {
  const space = await workspace("Agent sources policy")
  const view = await space.owner("GET", proactive)
  assert.equal(view.status, 200, summary(view))
  assert.deepEqual(field(view.body, "settings", "sources"), { calendar: "everyone", email: "everyone", chat: "everyone", connections: {} })
  assert.deepEqual(list(field(view.body, "sourceConnections", "other")).map((entry) => entry.name), ["Support desk"])

  const saved = await space.owner("PUT", proactive, { sources: { chat: "members", connections: { [space.connectionId]: "off" } } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings", "sources"), { calendar: "everyone", email: "everyone", chat: "members", connections: { [space.connectionId]: "off" } })
  const back = await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: null } } })
  assert.deepEqual(field(back.body, "settings", "sources", "connections"), {}, "null goes back to members choose")
  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { emc_01k0000000000000000000000: "everyone" } } })).status, 400, "only the organization's own connections")
  assert.equal((await space.owner("PUT", proactive, { sources: { email: "sometimes" } })).status, 400)
  assert.equal((await space.call("PUT", proactive, { sources: { email: "off" } })).status, 403, "members can't change the policy")
})

test("a member turns sources on and steers them, never past the admin's policy; chat and the page see the same sources", async () => {
  const space = await workspace("Agent sources member")
  const token = await den.mintMcpToken(space.member, space.orgId)
  const before = await space.call("GET", "/v1/me/agent")
  const desk = list(field(before.body, "sources")).find((source) => source.id === space.connectionId)
  assert.deepEqual([desk?.name, desk?.policy, desk?.on], ["Support desk", "members", false], "another connection starts off for members")
  assert.deepEqual(list(field(before.body, "sources")).slice(0, 3).map((source) => [source.id, source.policy, source.on]), [["calendar", "everyone", true], ["email", "everyone", true], ["chat", "everyone", true]])

  // "also look at my support desk for tickets waiting on me, and skip team chat" (chat is on for everyone: refused)
  const locked = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "Support desk", on: true }, { source: "Team chat", on: false }] } })
  assert.equal(locked.isError, true)
  assert.match(locked.text, /Team chat is on for everyone in your organization\. An admin can change it in Manage › Workbot\./)
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.connectionId)?.on, false, "nothing saved")

  const said = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "support desk", on: true, instruction: "Tickets waiting on me first." }, { source: "Granola", on: true }] } })
  assert.equal(said.isError, false, said.text)
  const reply = text(field(said.body, "saved", "reply"), "reply")
  assert.match(reply, /^Saved:\n- Support desk on, for “Tickets waiting on me first\.”\nConnect Granola: http.+\/dashboard\/library\/connectors\/new\nReply "undo" to revert\. My bot: http.+\/dashboard\/my-bot$/)
  const page = await space.call("GET", "/v1/me/agent")
  const saved = list(field(page.body, "sources")).find((source) => source.id === space.connectionId)
  assert.deepEqual([saved?.on, saved?.instruction], [true, "Tickets waiting on me first."], "the page shows what chat saved")
  const change = list(field(page.body, "changes")).find((entry) => entry.field === "source")
  assert.deepEqual([change?.sourceId, change?.source, change?.summary], [space.connectionId, "chat", "Support desk on"])

  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.connectionId]: "off" } } })).status, 200)
  const widen = await space.call("PUT", "/v1/me/agent", { sources: [{ source: space.connectionId, instruction: "Anything" }] })
  assert.equal(widen.status, 400, summary(widen))
  assert.deepEqual(widen.body, { error: "source_not_allowed", message: "Support desk isn't allowed for agents in your organization. An admin can change it in Manage › Workbot." })
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.connectionId)?.on, false, "the admin's not allowed wins over what the member saved")
})

test("Connect lets an agent's token call only its sources' read tools; plain read tokens and other connections stay refused", async () => {
  const space = await workspace("Agent sources allowlist")
  const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
  const { agentReadScopes } = await import("../../src/mcp/agent-read-sources.js")
  const userId = space.member.userId
  const agent = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true, scopes: agentReadScopes({ kinds: ["chat"], connectionIds: [space.connectionId] }) })).token
  const elsewhere = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true, scopes: agentReadScopes({ kinds: ["chat"], connectionIds: ["emc_01k0000000000000000000000"] }) })).token
  const plain = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true })).token
  const capability = (tool: string) => `mcp:${space.connectionId}:${tool}`

  const read = await den.callMcpTool(agent, "execute_capability", { name: capability("list_tickets") })
  assert.equal(read.isError, false, read.text)
  assert.match(read.raw, /TICKET-7 is waiting on you/)
  for (const [token, tool, why] of [[agent, "close_ticket", "a write marked read-only is still a write"], [agent, "get_ticket", "an unknown service's tool needs its read-only hint"], [elsewhere, "list_tickets", "not one of its sources"], [plain, "list_tickets", "a plain read token never calls a connection's tools"]] as const) {
    const refused = await den.callMcpTool(token, "execute_capability", { name: capability(tool) })
    assert.equal(refused.isError, true, `${why}: ${refused.text}`)
    assert.match(refused.text, /insufficient_mcp_scope/, why)
  }
  const calls = service.wire.filter((entry) => entry.rpcMethod === "tools/call")
  assert.equal(calls.length, 1, "only the allowed read reached the service")

  const found = await den.callMcpTool(agent, "search_capabilities", { query: "tickets", limit: 10 })
  const names = list(field(found.structured ?? found.body, "matches")).map((match) => String(match.name))
  assert.ok(names.includes(capability("list_tickets")), names.join(","))
  assert.ok(!names.includes(capability("close_ticket")), "the agent only finds what it may call")
})
