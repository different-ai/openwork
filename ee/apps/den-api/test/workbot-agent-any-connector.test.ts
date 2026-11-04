import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  DEFAULT_AGENT_SOURCES_POLICY,
  agentToolOverrides,
  mergeAgentSourcesPolicy,
  type AgentSourceConnection,
  type AgentSourcesPolicy,
} from "@openwork/types/den/workbot-proactive"
import {
  agentMayUseExternalTool,
  agentMayUseNative,
  agentReadAllowlist,
  agentReadScopes,
  AGENT_TOOLS_SCOPE,
} from "../src/mcp/agent-read-sources.js"
import {
  mcpConnectionToolsView,
  nativeConnectionToolsView,
  planAgentTools,
  sourceReadToolCounts,
  sourceUsable,
  type NativeOperation,
} from "../src/workbot-proactive/agent-tools.js"
import {
  checkSourcesChange,
  groupSourceConnections,
  readAllowlist,
  resolveMemberSources,
  type MemberConnection,
} from "../src/workbot-proactive/sources.js"

// Any connected connector as a source of Your agent (workbotAgentBrief): every connection is listed, MCP and Den's own,
// with no hand-picked list or count cap; each tool is decided read or not; the check's token carries exactly the read
// tools. With the feature off (`reviewed`), only services with reviewed read tools, exactly as before. Names are
// fictional.

type OrgConnection = AgentSourceConnection & { native: string | null }

const GOOGLE: OrgConnection = { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: "google-workspace" }
const SLACK: OrgConnection = { id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", native: null }
const LINEAR: OrgConnection = { id: "emc_linear", name: "Linear", url: "https://mcp.linear.app/mcp", native: null }
const DESK: OrgConnection = { id: "emc_desk", name: "Lumen Support Desk", url: "https://mcp.lumen-desk.test/mcp", native: null }
const LEDGER: OrgConnection = { id: "emc_ledger", name: "Brightwater Ledger", url: "https://mcp.brightwater-ledger.test/mcp", native: null }

/** Forty custom MCPs: an organization far bigger than the old dropdowns ever showed. */
const MANY: OrgConnection[] = Array.from({ length: 40 }, (_, index) => ({
  id: `emc_custom_${String(index).padStart(2, "0")}`,
  name: `Custom tool ${index + 1}`,
  url: `https://mcp.custom-${index + 1}.test/mcp`,
  native: null,
}))

const member = (connection: OrgConnection, state: MemberConnection["state"] = "connected"): MemberConnection => ({ ...connection, state })

describe("every connection is offered (workbotAgentBrief)", () => {
  const connections = [GOOGLE, SLACK, LINEAR, DESK, LEDGER, ...MANY]

  test("What agents read lists every connection, MCP and Den's own, custom ones included, with no cap", () => {
    const view = groupSourceConnections(connections, { mode: "any" })
    assert.deepEqual(view.other.map((entry) => entry.id), [GOOGLE.id, LINEAR.id, DESK.id, LEDGER.id, ...MANY.map((entry) => entry.id)], "Slack is team chat; everything else is in Other context")
    assert.equal(view.other.length, 44)
    assert.ok(view.other.every((entry) => entry.policy === "members"), "members choose until an admin decides")
    assert.equal(view.other.find((entry) => entry.id === GOOGLE.id)?.native, true)
    assert.deepEqual(view.all.find((entry) => entry.id === GOOGLE.id)?.slots, ["calendar", "email", "other"], "Den's own: what it serves, and Other context")
    assert.deepEqual(view.all.find((entry) => entry.id === DESK.id)?.slots, ["calendar", "email", "chat", "other"], "any MCP can go anywhere")
    assert.equal(view.all.length, connections.length)
  })

  test("off (`reviewed`): only services with reviewed read tools, exactly as before", () => {
    const view = groupSourceConnections(connections)
    assert.deepEqual(view.other.map((entry) => entry.id), [LINEAR.id])
    assert.deepEqual(view.other[0], { id: LINEAR.id, name: "Linear", url: LINEAR.url }, "no new fields")
    assert.equal(view.all.some((entry) => entry.id === DESK.id), false)
    assert.deepEqual(view.all.find((entry) => entry.id === GOOGLE.id)?.slots, ["calendar", "email"])
  })

  test("a member sees every connection they can use; the admin's policy holds per connection", () => {
    const policy: AgentSourcesPolicy = { ...DEFAULT_AGENT_SOURCES_POLICY, connections: { [LEDGER.id]: "off", [DESK.id]: "everyone" } }
    const sources = resolveMemberSources({
      connections: [member(GOOGLE), member(SLACK), member(DESK), member(LEDGER), member(MANY[0]!, "needs_connection")],
      policy,
      choices: { [MANY[0]!.id]: { on: true } },
      lastLook: {},
      mode: "any",
    })
    assert.deepEqual(sources.map((source) => [source.id, source.kind, source.policy, source.on]), [
      ["calendar", "calendar", "everyone", true],
      ["email", "email", "everyone", true],
      ["chat", "chat", "everyone", true],
      [GOOGLE.id, "other", "members", false],
      [DESK.id, "other", "everyone", true],
      [LEDGER.id, "other", "off", false],
      [MANY[0]!.id, "other", "members", true],
    ])
    // On but not connected: on the page with "Connect Custom tool 1"; nothing to read yet.
    assert.deepEqual(readAllowlist(sources).connectionIds.includes(MANY[0]!.id), false)
    assert.ok(readAllowlist(sources).connectionIds.includes(DESK.id))
  })

  test("a reviewed connection an admin had taken out of Other context stays not allowed; new ones are up to members", () => {
    const policy: AgentSourcesPolicy = { ...DEFAULT_AGENT_SOURCES_POLICY, otherConnections: [] }
    const view = groupSourceConnections([LINEAR, DESK], { policy, mode: "any" })
    assert.deepEqual(view.other.map((entry) => [entry.id, entry.policy]), [[LINEAR.id, "off"], [DESK.id, "members"]])
    const sources = resolveMemberSources({ connections: [member(LINEAR), member(DESK)], policy, choices: { [LINEAR.id]: { on: true } }, lastLook: {}, mode: "any" })
    assert.deepEqual(sources.filter((source) => source.kind === "other").map((source) => [source.id, source.policy, source.on]), [[LINEAR.id, "off", false], [DESK.id, "members", false]])
  })

  test("an admin may set any connection's policy and its tools; off, a custom MCP and tool choices are refused", () => {
    const anyChange = (change: Parameters<typeof checkSourcesChange>[0]["change"]) => checkSourcesChange({ change, connections, mode: "any" })
    assert.equal(anyChange({ connections: { [DESK.id]: "everyone", [GOOGLE.id]: "members" } }), null)
    assert.equal(anyChange({ toolOverrides: { [DESK.id]: { close_ticket: "deny", ticket_report: "allow" } } }), null)
    assert.equal(anyChange({ toolOverrides: { emc_nope: { list: "allow" } } }), "No connection emc_nope in this organization.")
    assert.equal(anyChange({ coreConnections: { calendar: [DESK.id] } }), null, "any MCP can serve calendar")
    assert.equal(checkSourcesChange({ change: { connections: { [DESK.id]: "everyone" } }, connections }), "Agents can't read Lumen Support Desk yet.")
    assert.equal(checkSourcesChange({ change: { toolOverrides: { [DESK.id]: { close_ticket: "deny" } } }, connections }), "Choosing tools for agents isn't on for this organization.")
  })

  test("tool choices merge per connection and per tool; null goes back", () => {
    const first = mergeAgentSourcesPolicy(DEFAULT_AGENT_SOURCES_POLICY, { toolOverrides: { [DESK.id]: { close_ticket: "deny", ticket_report: "allow" } } })
    assert.deepEqual(agentToolOverrides(first, DESK.id), { close_ticket: "deny", ticket_report: "allow" })
    const second = mergeAgentSourcesPolicy(first, { toolOverrides: { [DESK.id]: { ticket_report: null }, [LEDGER.id]: { list_entries: "deny" } } })
    assert.deepEqual(second.toolOverrides, { [DESK.id]: { close_ticket: "deny" }, [LEDGER.id]: { list_entries: "deny" } })
    const cleared = mergeAgentSourcesPolicy(second, { toolOverrides: { [DESK.id]: null, [LEDGER.id]: { list_entries: null } } })
    assert.equal(cleared.toolOverrides, undefined)
    assert.equal(mergeAgentSourcesPolicy(second, { email: "off" }).toolOverrides?.[DESK.id]?.close_ticket, "deny", "other changes keep them")
  })
})

describe("the check's token carries exactly its read tools", () => {
  const scopes = (input: Parameters<typeof agentReadScopes>[0]) => new Set(["mcp:read", ...agentReadScopes(input)])

  test("only the listed tools on each connection; never one its provider now marks destructive; never another connection", () => {
    const allowlist = agentReadAllowlist(scopes({ kinds: [], connectionIds: [DESK.id, LEDGER.id], tools: [{ connectionId: DESK.id, names: ["list_tickets", "get ticket/1"] }, { connectionId: LEDGER.id, names: [] }] }))
    assert.ok(allowlist)
    assert.equal(agentMayUseExternalTool(allowlist, DESK, { name: "list_tickets" }), true)
    assert.equal(agentMayUseExternalTool(allowlist, DESK, { name: "get ticket/1" }), true, "names survive the scope encoding")
    assert.equal(agentMayUseExternalTool(allowlist, DESK, { name: "close_ticket" }), false, "not decided a read")
    assert.equal(agentMayUseExternalTool(allowlist, DESK, { name: "list_tickets", annotations: { destructiveHint: true } }), false, "turned destructive since the check started")
    assert.equal(agentMayUseExternalTool(allowlist, LEDGER, { name: "list_entries" }), false, "a connection with no read tools reads nothing")
    assert.equal(agentMayUseExternalTool(allowlist, { id: "emc_other", url: DESK.url }, { name: "list_tickets" }), false, "not one of its sources")
  })

  test("a reviewed service's tools come from the token too, not from the list (an admin may have turned one off)", () => {
    const allowlist = agentReadAllowlist(scopes({ kinds: ["chat"], connectionIds: [SLACK.id], tools: [{ connectionId: SLACK.id, names: ["slack_search_public"] }] }))
    assert.ok(allowlist)
    assert.equal(agentMayUseExternalTool(allowlist, SLACK, { name: "slack_search_public" }), true)
    assert.equal(agentMayUseExternalTool(allowlist, SLACK, { name: "slack_read_thread" }), false)
  })

  test("Den's own provider in Other context: any GET outside calendar, mail and chat, except what an admin turned off", () => {
    const allowlist = agentReadAllowlist(scopes({ kinds: ["email"], connectionIds: [GOOGLE.id], pairs: [{ kind: "email", connectionId: GOOGLE.id }], nativeReads: [{ connectionId: GOOGLE.id, denied: ["listDriveSharedLinks"] }] }))
    assert.ok(allowlist)
    const op = (name: string, path: string, method = "GET") => ({ name, method, path })
    assert.equal(agentMayUseNative(allowlist, GOOGLE.id, op("listDriveFiles", "/v1/capabilities/google-workspace/drive-files")), true)
    assert.equal(agentMayUseNative(allowlist, GOOGLE.id, op("listDriveSharedLinks", "/v1/capabilities/google-workspace/drive-shared-links")), false, "turned off by an admin")
    assert.equal(agentMayUseNative(allowlist, GOOGLE.id, op("createDriveFile", "/v1/capabilities/google-workspace/drive-files", "POST")), false, "never a write")
    assert.equal(agentMayUseNative(allowlist, GOOGLE.id, op("listGmailMessages", "/v1/capabilities/google-workspace/gmail-messages")), true, "email still reads under Email")
    assert.equal(agentMayUseNative(allowlist, GOOGLE.id, op("listCalendarEvents", "/v1/capabilities/google-workspace/calendar-events")), false, "calendar is off, whatever Other context says")
  })

  test("off: a token without the marker keeps the reviewed lists, and a custom MCP reads nothing", () => {
    const legacy = agentReadAllowlist(scopes({ kinds: ["chat"], connectionIds: [SLACK.id, DESK.id] }))
    assert.ok(legacy)
    assert.equal(legacy.tools, null)
    assert.equal(agentMayUseExternalTool(legacy, SLACK, { name: "slack_read_thread" }), true)
    assert.equal(agentMayUseExternalTool(legacy, DESK, { name: "list_tickets", annotations: { readOnlyHint: true } }), false)
    assert.equal(agentMayUseNative(legacy, GOOGLE.id, { name: "listDriveFiles", method: "GET", path: "/v1/capabilities/google-workspace/drive-files" }), false)
    assert.ok(!agentReadScopes({ kinds: [], connectionIds: [] }).includes(AGENT_TOOLS_SCOPE))
  })
})

describe("deciding a check's tools when it starts", () => {
  const DESK_TOOLS = [
    { name: "list_tickets", annotations: { readOnlyHint: true } },
    { name: "get_ticket" },
    { name: "close_ticket", annotations: { readOnlyHint: true } },
    { name: "purge_queue", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "reply_to_customer", annotations: { readOnlyHint: false } },
    { name: "ticket_report" },
  ]
  const sourcesWith = (connections: MemberConnection[], policy: AgentSourcesPolicy = DEFAULT_AGENT_SOURCES_POLICY) =>
    resolveMemberSources({ connections, policy, choices: Object.fromEntries(connections.map((connection) => [connection.id, { on: true }])), lastLook: {}, mode: "any" })

  test("only reads ride along; an admin's choices win; Den's own provider carries its denials", async () => {
    const policy = mergeAgentSourcesPolicy(DEFAULT_AGENT_SOURCES_POLICY, { toolOverrides: { [DESK.id]: { get_ticket: "deny", ticket_report: "allow", purge_queue: "allow" }, [GOOGLE.id]: { listDriveSharedLinks: "deny" } } })
    const sources = sourcesWith([member(GOOGLE), member(DESK), member(LEDGER)], policy)
    const plan = await planAgentTools({ sources, overrides: policy.toolOverrides ?? {}, listTools: async (connection) => (connection.id === DESK.id ? DESK_TOOLS : null) })
    assert.deepEqual(plan.tools, [{ connectionId: DESK.id, names: ["list_tickets", "ticket_report"] }])
    assert.deepEqual(plan.nativeReads, [{ connectionId: GOOGLE.id, denied: ["listDriveSharedLinks"] }])
    assert.deepEqual(plan.connections.map((entry) => [entry.connection.id, entry.status, entry.allowed.length, entry.denied]), [
      [DESK.id, "listed", 2, 4],
      [LEDGER.id, "unlisted", 0, 0],
      [GOOGLE.id, "native", 0, 1],
    ])
    const usable = sources.filter((source) => source.kind === "other").map((source) => [source.id, sourceUsable(source, plan)])
    assert.deepEqual(usable, [[GOOGLE.id, true], [DESK.id, true], [LEDGER.id, false]], "a connection whose tools couldn't be listed sits this check out")
  })

  test("a connection with no read tools isn't usable; one the member hasn't connected isn't listed at all", async () => {
    const sources = sourcesWith([member(DESK), member(LEDGER, "needs_connection")])
    const listed: string[] = []
    const plan = await planAgentTools({ sources, overrides: {}, listTools: async (connection) => {
      listed.push(connection.id)
      return [{ name: "close_ticket" }, { name: "reply_to_customer" }]
    } })
    assert.deepEqual(listed, [DESK.id])
    assert.deepEqual(plan.tools, [{ connectionId: DESK.id, names: [] }])
    assert.equal(sourceUsable(sources.find((source) => source.id === DESK.id)!, plan), false)
  })
})

describe("what the pages show", () => {
  const OPERATIONS: NativeOperation[] = [
    { name: "listDriveFiles", method: "GET", path: "/v1/capabilities/google-workspace/drive-files", summary: "List Drive files" },
    { name: "createDriveFile", method: "POST", path: "/v1/capabilities/google-workspace/drive-files", summary: "Create a Drive file" },
    { name: "listGmailMessages", method: "GET", path: "/v1/capabilities/google-workspace/gmail-messages", summary: "List Gmail messages" },
    { name: "listCalendarEvents", method: "GET", path: "/v1/capabilities/google-workspace/calendar-events", summary: "List calendar events" },
  ]

  test("an admin's review: every tool, its decision, why, and whether it is locked", () => {
    const view = mcpConnectionToolsView({ connectionId: DESK.id, url: DESK.url, overrides: { get_ticket: "deny" }, tools: [
      { name: "list_tickets", annotations: { readOnlyHint: true } },
      { name: "get_ticket", description: "Read one ticket" },
      { name: "purge_queue", annotations: { destructiveHint: true } },
      { name: "close_ticket" },
    ] })
    assert.equal(view.readTools, 1)
    assert.deepEqual(view.tools.map((tool) => [tool.name, tool.allowed, tool.reason, tool.override, tool.locked]), [
      ["list_tickets", true, "marked_read", null, false],
      ["get_ticket", false, "admin_denied", "deny", false],
      ["purge_queue", false, "destructive", null, true],
      ["close_ticket", false, "write_name", null, false],
    ])
  })

  test("Den's own provider: its operations outside calendar, mail and chat; a write is locked", () => {
    const view = nativeConnectionToolsView({ connectionId: GOOGLE.id, operations: OPERATIONS, overrides: {} })
    assert.equal(view.coreSourcesElsewhere, true)
    assert.deepEqual(view.tools.map((tool) => [tool.name, tool.allowed, tool.reason, tool.locked]), [
      ["listDriveFiles", true, "native_read", false],
      ["createDriveFile", false, "native_write", true],
    ])
  })

  test("a member's count: 0 still shows (an admin can review), null while unknown", async () => {
    const sources = resolveMemberSources({ connections: [member(GOOGLE), member(DESK), member(LEDGER), member(MANY[1]!, "needs_connection")], policy: DEFAULT_AGENT_SOURCES_POLICY, choices: {}, lastLook: {}, mode: "any" })
    const counts = await sourceReadToolCounts({
      sources,
      overrides: {},
      listTools: async (connection) => (connection.id === DESK.id ? [{ name: "list_tickets" }, { name: "get_ticket" }] : connection.id === LEDGER.id ? [{ name: "post_entry" }] : null),
      nativeOperations: async () => OPERATIONS,
    })
    assert.deepEqual(Object.fromEntries(counts), { [GOOGLE.id]: 1, [DESK.id]: 2, [LEDGER.id]: 0, [MANY[1]!.id]: null })
  })
})
