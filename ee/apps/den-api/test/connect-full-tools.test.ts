import assert from "node:assert/strict"
import { test } from "node:test"
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, type McpServer } from "@modelcontextprotocol/server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createAgentMcpHttpHandler, createScopedAgentMcpHttpHandlers, type AgentMcpAudience } from "../src/mcp/agent-http.js"
import { AGENT_MCP_INSTRUCTIONS, createAgentMcpServer } from "../src/mcp/agent-server.js"
import {
  buildConnectFullTools,
  connectFullToolName,
  externalToolCandidates,
  registerConnectFullTools,
  registerConnectionStatusTool,
  titledToolNames,
  type CapabilityCall,
  type ConnectFullToolCandidate,
  type PendingConnection,
} from "../src/mcp/connect-full-tools.js"
import { connectToolView, connectToolViewOverride, requestClientInfo } from "../src/mcp/connect-tool-view.js"
import { notifyInventoryChanged } from "../src/inventory-writes.js"

const CLAUDE_CODE = { name: "claude-code", version: "2.1.300" }
const ORG = "org_01m4xbdvxxeh585vrbxydzqq58"
const OTHER_ORG = "org_01m4xbdvwaejpvw05s0dd97wzt"
const mcpName = (connectionId: string, toolName: string) => `mcp:${connectionId}:${toolName}`
const policy = (disabledTools: string[], allDisabled = false) => ({ version: 1 as const, allDisabled, disabledTools })

test("only an allowlisted client or the explicit override picks the full view, and only with the flag on", () => {
  const on = { enabled: true }
  assert.equal(connectToolView(CLAUDE_CODE, on), "full")
  assert.equal(connectToolView({ name: " Claude-Code " }, on), "full")
  assert.equal(connectToolView({ name: "cursor", version: "1" }, on), "search")
  assert.equal(connectToolView({ name: "opencode" }, on), "full")
  assert.equal(connectToolView(null, on), "search")
  // The override wins over the guess, both ways.
  assert.equal(connectToolView({ name: "cursor" }, { enabled: true, override: "full" }), "full")
  assert.equal(connectToolView(null, { enabled: true, override: "full" }), "full")
  assert.equal(connectToolView(CLAUDE_CODE, { enabled: true, override: "search" }), "search")
  // With the flag off nothing turns the full view on.
  assert.equal(connectToolView(CLAUDE_CODE, { enabled: false }), "search")
  assert.equal(connectToolView(CLAUDE_CODE, { enabled: false, override: "full" }), "search")
  // The same inputs always pick the same view.
  assert.equal(connectToolView(CLAUDE_CODE, on), connectToolView({ ...CLAUDE_CODE }, on))

  assert.equal(connectToolViewOverride("https://den.test/mcp/agent?tools=full"), "full")
  assert.equal(connectToolViewOverride("https://den.test/mcp/agent?tools=search"), "search")
  assert.equal(connectToolViewOverride("https://den.test/mcp/agent?tools=all"), null)
  assert.equal(connectToolViewOverride("https://den.test/mcp/agent"), null)
})

test("one rollout gates every supported client and preserves the existing client allowlist", () => {
  for (const enabled of [false, true]) {
    for (const name of ["opencode", " OpenCode ", "claude-code", " Claude-Code "]) {
      assert.equal(connectToolView({ name }, { enabled }), enabled ? "full" : "search")
      assert.equal(connectToolView({ name }, { enabled, override: "search" }), "search")
      assert.equal(connectToolView({ name }, { enabled, override: "full" }), enabled ? "full" : "search")
    }
    for (const client of [null, { name: "cursor" }, { name: "" }]) {
      assert.equal(connectToolView(client, { enabled }), "search")
      assert.equal(connectToolView(client, { enabled, override: "full" }), enabled ? "full" : "search")
    }
  }
})

test("clientInfo comes only from the request's own _meta", () => {
  assert.deepEqual(requestClientInfo({ _meta: { [CLIENT_INFO_META_KEY]: CLAUDE_CODE } }), CLAUDE_CODE)
  assert.deepEqual(requestClientInfo({ _meta: { [CLIENT_INFO_META_KEY]: { name: "claude-code" } } }), { name: "claude-code" })
  // initialize's own clientInfo is not per-request metadata.
  assert.equal(requestClientInfo({ clientInfo: CLAUDE_CODE }), null)
  assert.equal(requestClientInfo({ _meta: { [CLIENT_INFO_META_KEY]: { version: "1" } } }), null)
  assert.equal(requestClientInfo({ _meta: { [CLIENT_INFO_META_KEY]: "claude-code" } }), null)
  assert.equal(requestClientInfo(null), null)
})

function candidate(namespace: string, toolName: string, extra: Partial<ConnectFullToolCandidate> = {}): ConnectFullToolCandidate {
  return {
    namespace,
    toolName,
    capability: mcpName(`emc_${namespace}`, toolName),
    description: `${namespace} ${toolName}`,
    inputSchema: { type: "object" },
    ...extra,
  }
}

test("the full list is deterministic, uniquely named within MCP name rules, and keeps only object input schemas", () => {
  const candidates = [
    candidate("linear", "list_issues"),
    candidate("admin", "den_list_features", { capability: "admin:den_list_features" }),
    candidate("notion", "notion-query"),
    candidate("github", "search/code"),
    candidate("google_workspace", "getCapabilitiesGoogleWorkspaceDriveFilesByFileIdContent", { capability: "native:emc_g:getCapabilitiesGoogleWorkspaceDriveFilesByFileIdContent" }),
    candidate("run-workflow", "weekly_report", { capability: "plugin:plg_1:cob_1" }),
    candidate("linear", "broken", { inputSchema: { type: "array" } }),
  ]
  const tools = buildConnectFullTools(candidates)
  const reversed = buildConnectFullTools([...candidates].reverse())
  assert.deepEqual(reversed, tools)
  assert.deepEqual(buildConnectFullTools(candidates), tools)

  const names = tools.map((tool) => tool.name)
  assert.deepEqual(names, [...names].sort())
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^[A-Za-z0-9_.-]{1,64}$/)
  assert.ok(!tools.some((tool) => tool.capability === mcpName("emc_linear", "broken")), "a non-object input schema would fail the whole list")

  // Names follow the Code Mode call; only names outside the rules are rewritten, stably.
  assert.ok(names.includes("linear.list_issues"))
  assert.ok(names.includes("notion.notion-query"))
  assert.ok(names.includes("run-workflow.weekly_report"))
  const github = tools.find((tool) => tool.capability === mcpName("emc_github", "search/code"))
  assert.match(github?.name ?? "", /^github\.search_code-[0-9a-f]{8}$/)
  assert.equal(github?.name, connectFullToolName("github", "search/code"))
  const drive = tools.find((tool) => tool.capability.startsWith("native:"))
  assert.equal(drive?.name.length, 64)
  assert.match(drive?.name ?? "", /^google_workspace\.getCapabilities.*-[0-9a-f]{8}$/)
})

test("an external connection lists only the tools its policy allows, with the provider's schemas and annotations", () => {
  const connection = { id: "emc_1", name: "Linear", namespace: "linear", toolPolicy: policy(["delete_issue"]) }
  const tools = [
    { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: { state: { type: "string" } } }, outputSchema: { type: "object", properties: { issues: { type: "array" } } }, annotations: { readOnlyHint: true, title: "List issues" } },
    { name: "delete_issue", description: "Delete an issue", inputSchema: { type: "object" } },
    { name: "odd", inputSchema: { type: "string" } },
  ]
  const candidates = externalToolCandidates({ connection, tools, capabilityName: mcpName })
  assert.deepEqual(candidates, [{
    namespace: "linear",
    toolName: "list_issues",
    capability: "mcp:emc_1:list_issues",
    title: "List issues",
    description: "[Linear] List issues",
    inputSchema: tools[0]?.inputSchema,
    outputSchema: tools[0]?.outputSchema,
    annotations: { readOnlyHint: true, title: "List issues" },
  }])
  assert.deepEqual(externalToolCandidates({ connection: { ...connection, toolPolicy: policy([], true) }, tools, capabilityName: mcpName }), [])
  assert.equal(externalToolCandidates({ connection: { ...connection, toolPolicy: null }, tools, capabilityName: mcpName }).length, 2)
})

test("a Workflow or App keeps its name when a namesake is added", () => {
  const first = titledToolNames([{ id: "cob_01a", title: "Weekly report" }])
  const later = titledToolNames([{ id: "cob_02b", title: "Weekly Report!" }, { id: "cob_01a", title: "Weekly report" }])
  assert.equal(first.get("cob_01a"), "weekly_report")
  assert.equal(later.get("cob_01a"), "weekly_report")
  assert.equal(later.get("cob_02b"), "weekly_report_ob_02b")
  assert.equal(titledToolNames([{ id: "cob_1", title: "!!!" }]).get("cob_1"), "untitled")
})

function fullViewFixture(input: {
  candidates: ConnectFullToolCandidate[]
  pending?: PendingConnection[]
  execute: (call: CapabilityCall) => Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> }>
  show?: (connection: PendingConnection) => Promise<{ content: { type: "text"; text: string }[] }>
}) {
  const handler = createAgentMcpHttpHandler(() => {
    const server = createAgentMcpServer({ toolView: "full" })
    registerConnectFullTools({ server, tools: buildConnectFullTools(input.candidates), execute: input.execute })
    registerConnectionStatusTool({
      server,
      pending: input.pending ?? [],
      show: input.show ?? (async (connection) => ({ content: [{ type: "text", text: `card for ${connection.namespace}` }] })),
    })
    return server
  })
  return async (method: string, params: object) => {
    const response = await handler.fetch(modernRequest(method, params))
    return response.json()
  }
}

function modernRequest(method: string, params: object, url = "https://den.test/mcp/agent") {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...("name" in params && typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: CLAUDE_CODE, [CLIENT_CAPABILITIES_META_KEY]: {},
    } } }),
  })
}

const listResult = z.object({ result: z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()).optional(), annotations: z.record(z.string(), z.unknown()).optional() })),
  ttlMs: z.number(),
  cacheScope: z.string(),
}) })
const callResult = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string() })), structuredContent: z.unknown().optional(), _meta: z.record(z.string(), z.unknown()).optional() }) })

test("full-view tools list privately and run through the capability executor with execute_capability's name and arguments", async () => {
  const calls: CapabilityCall[] = []
  const issueSchema = { type: "object", properties: { state: { type: "string" } }, required: ["state"] }
  const call = fullViewFixture({
    candidates: [
      candidate("linear", "list_issues", { inputSchema: issueSchema, outputSchema: { type: "object" }, annotations: { readOnlyHint: true } }),
      candidate("google_workspace", "getCapabilitiesGoogleWorkspaceGmailMessagesById", { capability: "native:emc_g:getCapabilitiesGoogleWorkspaceGmailMessagesById", inputSchema: { type: "object", properties: { path: { type: "object" } } } }),
    ],
    execute: async (request) => {
      calls.push(request)
      return {
        content: [{ type: "text", text: `ran ${request.name}` }],
        structuredContent: { ok: true },
        _meta: { "openwork/schemaGuidance": { advisory: true } },
      }
    },
  })

  const listed = listResult.parse(await call("tools/list", {}))
  assert.equal(listed.result.cacheScope, "private")
  assert.equal(listed.result.ttlMs, 60_000)
  const names = listed.result.tools.map((tool) => tool.name)
  assert.ok(names.includes("linear.list_issues") && names.includes("google_workspace.getCapabilitiesGoogleWorkspaceGmailMessagesById") && names.includes("connection_status"))
  assert.ok(!names.includes("search_capabilities") && !names.includes("execute_capability"))
  const issues = listed.result.tools.find((tool) => tool.name === "linear.list_issues")
  assert.deepEqual(issues?.inputSchema, issueSchema)
  assert.deepEqual(issues?.outputSchema, { type: "object" })
  assert.deepEqual(issues?.annotations, { readOnlyHint: true })

  // Arguments are not validated here: the executor checks them, as for execute_capability.
  const ran = callResult.parse(await call("tools/call", { name: "linear.list_issues", arguments: { unexpected: 1 } }))
  assert.deepEqual(ran.result.content, [{ type: "text", text: "ran mcp:emc_linear:list_issues" }])
  assert.deepEqual(ran.result.structuredContent, { ok: true })
  assert.deepEqual(ran.result._meta?.["openwork/schemaGuidance"], { advisory: true })
  await call("tools/call", { name: "google_workspace.getCapabilitiesGoogleWorkspaceGmailMessagesById", arguments: { path: { id: "m_1" }, query: { format: "full" } } })
  assert.deepEqual(calls, [
    { name: "mcp:emc_linear:list_issues", arguments: { unexpected: 1 } },
    { name: "native:emc_g:getCapabilitiesGoogleWorkspaceGmailMessagesById", arguments: { path: { id: "m_1" }, query: { format: "full" } } },
  ])

  // A name outside the member's list never reaches the executor.
  const unknown = await call("tools/call", { name: "linear.delete_issue", arguments: {} })
  assert.match(JSON.stringify(unknown), /not found/)
  assert.equal(calls.length, 2)
})

test("connection_status shows the card for a connection that is not ready and says when none is pending", async () => {
  const shown: string[] = []
  const call = fullViewFixture({
    candidates: [],
    pending: [{ namespace: "linear", name: "Linear" }, { namespace: "github", name: "GitHub" }],
    execute: async () => ({ content: [] }),
    show: async (connection) => {
      shown.push(connection.namespace)
      return { content: [{ type: "text", text: `Connect ${connection.name}` }] }
    },
  })
  const listed = listResult.parse(await call("tools/list", {}))
  const status = listed.result.tools.find((tool) => tool.name === "connection_status")
  assert.match(status?.description ?? "", /Not ready: GitHub \(github\), Linear \(linear\)\./)
  assert.deepEqual(status?.annotations, { readOnlyHint: true, openWorldHint: true })

  const card = callResult.parse(await call("tools/call", { name: "connection_status", arguments: { connection: "linear" } }))
  assert.deepEqual(card.result.content, [{ type: "text", text: "Connect Linear" }])
  assert.deepEqual(shown, ["linear"])
  const refused = await call("tools/call", { name: "connection_status", arguments: { connection: "slack" } })
  assert.match(JSON.stringify(refused), /Input validation error|Invalid/)
  assert.deepEqual(shown, ["linear"])

  const none = fullViewFixture({ candidates: [], execute: async () => ({ content: [] }) })
  const ready = callResult.parse(await none("tools/call", { name: "connection_status", arguments: { connection: "slack" } }))
  assert.match(ready.result.content[0]?.text ?? "", /every service you may use is ready/)
})

async function initializationInstructions(server: McpServer): Promise<string> {
  const client = new Client({ name: "connect-full-tools-unit-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    return client.getInstructions() ?? ""
  } finally {
    await client.close()
    await server.close()
  }
}

test("the full view changes only the searching instructions; the search view's text is unchanged", async () => {
  const search = await initializationInstructions(createAgentMcpServer())
  const full = await initializationInstructions(createAgentMcpServer({ toolView: "full", remoteSessionStatus: true }))
  assert.ok(Buffer.byteLength(full, "utf8") <= 2048)
  assert.equal(search, AGENT_MCP_INSTRUCTIONS)
  assert.match(full, /Every connection action, Workflow, App and remote session you may use is its own tool/)
  assert.match(full, /connection_status/)
  assert.doesNotMatch(full, /Search capabilities with 2-4 keyword variants/)
  const searchLines = search.split("\n")
  const fullLines = full.split("\n").slice(0, searchLines.length)
  assert.deepEqual(fullLines.filter((line) => searchLines.includes(line)), [searchLines[0], ...searchLines.slice(3)])
})

async function listen(handlers: ReturnType<typeof createScopedAgentMcpHttpHandlers>, audience: AgentMcpAudience) {
  const response = await handlers.fetch(audience, modernRequest("subscriptions/listen", { notifications: { toolsListChanged: true } }), createAgentMcpServer())
  const reader = response.body?.getReader()
  assert.ok(reader)
  const methods: string[] = []
  const decoder = new TextDecoder()
  let buffer = ""
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end = buffer.indexOf("\n\n")
      while (end >= 0) {
        for (const line of buffer.slice(0, end).split("\n")) {
          if (!line.startsWith("data:")) continue
          const message: unknown = JSON.parse(line.slice(5))
          if (typeof message === "object" && message !== null && "method" in message && typeof message.method === "string") methods.push(message.method)
        }
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf("\n\n")
      }
    }
  })()
  return { methods, stop: () => reader.cancel() }
}

async function until(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

test("a change to what an organization's members may use tells its full-view streams their tool list changed", async () => {
  const handlers = createScopedAgentMcpHttpHandlers()
  const full = await listen(handlers, { organizationId: ORG, userId: "usr_1", fullTools: true })
  const search = await listen(handlers, { organizationId: ORG, userId: "usr_2", fullTools: false })
  const elsewhere = await listen(handlers, { organizationId: OTHER_ORG, userId: "usr_3", fullTools: true })
  const acknowledged = "notifications/subscriptions/acknowledged"
  assert.ok(await until(() => [full, search, elsewhere].every((stream) => stream.methods.includes(acknowledged))))

  notifyInventoryChanged([ORG])
  assert.ok(await until(() => full.methods.includes("notifications/tools/list_changed")))
  // The search view's list does not depend on connections, and other organizations are untouched.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(!search.methods.includes("notifications/tools/list_changed"))
  assert.ok(!elsewhere.methods.includes("notifications/tools/list_changed"))

  // Per-member notifications still reach the member's streams in either view.
  handlers.notify.toolsChanged({ organizationId: ORG, userId: "usr_2" })
  assert.ok(await until(() => search.methods.includes("notifications/tools/list_changed")))

  for (const stream of [full, search, elsewhere]) await stream.stop()
  await handlers.close()
  // A closed handler stops listening for inventory changes.
  notifyInventoryChanged([ORG])
})
