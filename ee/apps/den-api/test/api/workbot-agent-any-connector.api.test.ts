import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text } from "./harness.js"

// Any connected connector as a source of Your agent (workbotAgentBrief): every connection is offered with its policy, a
// custom MCP's tools are decided read or not one by one (its annotations, then its name), an admin can allow or turn off
// a tool, a member switches any allowed connector on from chat or the page, and the check's token reaches only the read
// tools. Off, today's reviewed lists. The fake service is the only provider contacted; names are fictional.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
const service = await startFakeMcpServer({
  tools: [
    { name: "list_tickets", description: "List open tickets", text: "TICKET-7 is waiting on you", annotations: { readOnlyHint: true } },
    { name: "get_ticket", description: "Read one ticket", text: "TICKET-7: refund request" },
    { name: "close_ticket", description: "Close a ticket", text: "closed", annotations: { readOnlyHint: true } },
    { name: "purge_queue", description: "Remove every ticket in a queue", text: "purged", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "reply_to_customer", description: "Reply to the customer on a ticket", text: "sent", annotations: { readOnlyHint: false } },
  ],
})
after(async () => {
  await service.close()
  await den.close()
})
const proactive = "/v1/org/workbot-settings/proactive"
const toolsOf = (connectionId: string) => `${proactive}/sources/${connectionId}/tools`

async function workspace(name: string, brief: boolean, extra = 0) {
  const created = await den.createOrg(await den.signUp(`${name} Owner`), name)

  if (brief) assert.equal((await den.setFeature(created.orgId, "workbotAgentBrief", true)).status, 200)
  const owner = den.as(created.owner, created.orgId)
  assert.equal((await owner("PUT", proactive, { enabled: true })).status, 200)
  const connect = async (label: string) => {
    const connection = await owner("POST", "/v1/mcp-connections", { name: label, url: `${service.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } })
    assert.equal(connection.status, 200, summary(connection))
    return text(field(connection.body, "id"), "connection id")
  }
  const deskId = await connect("Lumen Support Desk")
  const more: string[] = []
  for (let index = 0; index < extra; index += 1) more.push(await connect(`Custom tool ${index + 1}`))
  const member = await den.newMember(created.owner, created.orgId, `${name} member`)
  return { ...created, owner, member, call: den.as(member, created.orgId), deskId, more }
}

test("every connection is offered, custom ones too, each with its policy; off, only reviewed services", async () => {
  const on = await workspace("Any connector listed", true, 11)
  const view = await on.owner("GET", proactive)
  assert.equal(view.status, 200, summary(view))
  const other = list(field(view.body, "sourceConnections", "other"))
  assert.equal(other.length, 12, "the desk and eleven more, none left out")
  assert.ok(other.every((entry) => entry.policy === "members" && entry.native === false), "members choose until an admin decides")
  assert.ok(list(field(view.body, "sourceConnections", "all")).some((entry) => entry.id === on.deskId))

  const off = await workspace("Any connector off", false)
  const legacy = await off.owner("GET", proactive)
  assert.deepEqual(list(field(legacy.body, "sourceConnections", "other")), [], "a custom MCP isn't offered with the feature off")
  const refused = await off.owner("GET", toolsOf(off.deskId))
  assert.deepEqual([refused.status, field(refused.body, "feature")], [404, "workbotAgentBrief"])
  assert.equal((await off.owner("PUT", proactive, { sources: { toolOverrides: { [off.deskId]: { get_ticket: "deny" } } } })).status, 400)
  assert.equal((await off.owner("PUT", proactive, { sources: { connections: { [off.deskId]: "everyone" } } })).status, 400)
})

test("an admin reviews a custom connector's tools: decided one by one, locked when destructive, and their choices win", async () => {
  const space = await workspace("Any connector tools", true)
  const reviewed = await space.owner("GET", toolsOf(space.deskId))
  assert.equal(reviewed.status, 200, summary(reviewed))
  assert.equal(field(reviewed.body, "status"), "ready")
  assert.equal(field(reviewed.body, "readTools"), 2)
  assert.deepEqual(list(field(reviewed.body, "tools")).map((tool) => [tool.name, tool.allowed, tool.reason, tool.locked]), [
    ["list_tickets", true, "marked_read", false],
    ["get_ticket", true, "read_name", false],
    ["close_ticket", false, "write_name", false],
    ["purge_queue", false, "destructive", true],
    ["reply_to_customer", false, "marked_write", false],
  ])

  const saved = await space.owner("PUT", proactive, { sources: { toolOverrides: { [space.deskId]: { get_ticket: "deny", close_ticket: "allow" } } } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings", "sources", "toolOverrides"), { [space.deskId]: { get_ticket: "deny", close_ticket: "allow" } })
  const after = await space.owner("GET", toolsOf(space.deskId))
  assert.deepEqual(list(field(after.body, "tools")).map((tool) => [tool.name, tool.allowed, tool.override]), [
    ["list_tickets", true, null],
    ["get_ticket", false, "deny"],
    ["close_ticket", true, "allow"],
    ["purge_queue", false, null],
    ["reply_to_customer", false, null],
  ])
  const back = await space.owner("PUT", proactive, { sources: { toolOverrides: { [space.deskId]: null } } })
  assert.equal(field(back.body, "settings", "sources", "toolOverrides"), undefined, "null clears the connection's choices")
  assert.equal((await space.owner("GET", toolsOf("emc_01k0000000000000000000000"))).status, 404)
  assert.equal((await space.call("GET", toolsOf(space.deskId))).status, 403, "members can't review an organization's tools")
})

test("a member switches a custom connector on from chat; the page says how many tools it reads; the admin's not allowed is a lock", async () => {
  const space = await workspace("Any connector member", true)
  const token = await den.mintMcpToken(space.member, space.orgId)
  const before = list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.deskId)
  assert.deepEqual([before?.name, before?.policy, before?.on, before?.readTools], ["Lumen Support Desk", "members", false, 2])

  const said = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { sources: [{ source: "Lumen Support Desk", on: true, instruction: "Refund tickets waiting on me." }] } })
  assert.equal(said.isError, false, said.text)
  assert.match(text(field(said.body, "saved", "reply"), "reply"), /^Saved:\n- Lumen Support Desk on, for “Refund tickets waiting on me\.”\n/)
  assert.equal(list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.deskId)?.on, true)

  assert.equal((await space.owner("PUT", proactive, { sources: { toolOverrides: { [space.deskId]: { list_tickets: "deny", get_ticket: "deny" } } } })).status, 200)
  const none = list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.deskId)
  assert.equal(none?.readTools, 0, "still listed, with no read tools")

  assert.equal((await space.owner("PUT", proactive, { sources: { connections: { [space.deskId]: "off" } } })).status, 200)
  const locked = await space.call("PUT", "/v1/me/agent", { sources: [{ source: space.deskId, on: true }] })
  assert.deepEqual([locked.status, field(locked.body, "error")], [400, "source_not_allowed"])
  const shown = list(field((await space.call("GET", "/v1/me/agent")).body, "sources")).find((source) => source.id === space.deskId)
  assert.deepEqual([shown?.policy, shown?.on], ["off", false], "shown, locked")
})

test("the check's token calls only the read tools it carries; a write never reaches the service", async () => {
  const space = await workspace("Any connector token", true)
  const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
  const { agentReadScopes } = await import("../../src/mcp/agent-read-sources.js")
  // What the wake puts on the token after deciding: the desk's read tools only.
  const scopes = agentReadScopes({ kinds: [], connectionIds: [space.deskId], tools: [{ connectionId: space.deskId, names: ["list_tickets", "get_ticket"] }] })
  const agent = (await mintHeadlessRunMcpToken({ userId: space.member.userId, organizationId: space.orgId, readOnly: true, scopes })).token
  const capability = (tool: string) => `mcp:${space.deskId}:${tool}`
  const calls = () => service.wire.filter((entry) => entry.rpcMethod === "tools/call").length
  const start = calls()
  for (const tool of ["close_ticket", "purge_queue", "reply_to_customer"]) {
    const refused = await den.callMcpTool(agent, "execute_capability", { name: capability(tool) })
    assert.equal(refused.isError, true, `${tool}: ${refused.text}`)
    assert.match(refused.text, /insufficient_mcp_scope/)
  }
  assert.equal(calls(), start, "no refused call reached the service")
  const read = await den.callMcpTool(agent, "execute_capability", { name: capability("list_tickets") })
  assert.equal(read.isError, false, read.text)
  assert.match(read.text, /TICKET-7 is waiting on you/)
  const found = await den.callMcpTool(agent, "search_capabilities", { query: "tickets", limit: 10 })
  const names = list(field(found.structured ?? found.body, "matches")).map((match) => String(match.name)).filter((name) => name.startsWith(`mcp:${space.deskId}:`)).sort()
  assert.deepEqual(names, [capability("get_ticket"), capability("list_tickets")], "search shows the check only its read tools")
})
