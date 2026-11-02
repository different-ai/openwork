import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"
import type { NativeProviderConnectionEntry } from "../src/capability-sources/native-provider-connections.js"
import type { CapabilityExecuteInput, CapabilityRegistryContext, ExecuteCapabilityToolResult } from "../src/mcp/capability-registry.js"
import type { ConnectionServerRouteDeps, ConnectionServerSources } from "../src/mcp/connection-server.js"

// Every port is injected: no database, provider, Redis or token. The modules'
// default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/connection_server_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-connection-server-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-connection-server-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()

const { CONNECTION_SERVER_ROUTE_DEPS, ConnectionServerEventBus, registerConnectionServerRoutes, resolveConnectionServer } = await import("../src/mcp/connection-server.js")
const { CONNECTION_STATUS_TOOL_NAME, connectionServerUrl, providerConnectionServerTools } = await import("../src/mcp/connection-server-tools.js")
const { executeCapability } = await import("../src/mcp/capability-registry.js")

const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const member = { orgMembershipId: createDenTypeId("member"), teamIds: [] }

function connection(name: string, overrides: Partial<ExternalMcpConnectionRow> = {}): ExternalMcpConnectionRow {
  return {
    id: createDenTypeId("externalMcpConnection"),
    organizationId,
    kind: "external_mcp",
    name,
    toolPolicy: null,
    ...overrides,
  } as ExternalMcpConnectionRow
}

const linear = connection("Linear")
const ungranted = connection("Ungranted")
const disabled = connection("Disabled", { toolPolicy: { allDisabled: true, disabledTools: [], updatedBy: null, updatedByName: null, updatedAt: null } } as Partial<ExternalMcpConnectionRow>)
const notConnected = connection("Notion")
const elsewhere = connection("Elsewhere", { organizationId: otherOrganizationId })
const gmail = {
  id: "google-workspace",
  name: "Google Workspace",
  url: "https://workspace.google.com",
  nativeProviderKey: "google-workspace",
  connectedForMe: false,
  authType: "oauth",
  credentialMode: "per_member",
} as NativeProviderConnectionEntry

const linearTools = [
  { name: "update_issue", description: "Update an issue.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "list_issues", title: "List issues", description: "List issues.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, title: "List issues" } },
  { name: "delete_issue", description: "Delete an issue.", inputSchema: { type: "object" } },
]

const sources: ConnectionServerSources = {
  externalConnection: async (input) => [linear, ungranted, disabled, notConnected, elsewhere]
    .find((row) => row.id === input.connectionId && row.organizationId === input.organizationId) ?? null,
  externalStatus: async (input) => {
    if (input.connectionId === ungranted.id) return { ok: false, error: "forbidden", message: "Not granted." }
    if (input.connectionId === notConnected.id) {
      return { ok: true, connected: false, status: {} as never }
    }
    return { ok: true, connected: true, connection: { id: input.connectionId, name: "Linear" } }
  },
  externalTools: async () => linearTools,
  nativeEntries: async () => [gmail],
}

type Call = { context: CapabilityRegistryContext; input: CapabilityExecuteInput }

function app(overrides: Partial<ConnectionServerRouteDeps> = {}) {
  const calls: Call[] = []
  const deps: ConnectionServerRouteDeps = {
    verify: async () => ({ userId, organizationId, scopes: new Set(["mcp:read", "mcp:write"]), payload: {} }),
    features: async () => ({ connectionMcpServers: true, managedDeployments: false, outlookAttachments: false }),
    member: async () => member,
    catalog: async () => [],
    sources,
    executeCapability: async (context, input): Promise<ExecuteCapabilityToolResult> => {
      calls.push({ context, input })
      return { content: [{ type: "text", text: `ran ${input.name}` }], structuredContent: { ran: input.name } }
    },
    withBudget: (_capability, invoke) => invoke(),
    revision: async () => null,
    ...overrides,
  }
  const hono = new Hono<{ Variables: RequestIdVariables }>()
  registerConnectionServerRoutes(hono, deps)
  return { hono, calls }
}

async function rpc(hono: Hono<{ Variables: RequestIdVariables }>, connectionId: string, method: string, params: Record<string, unknown> = {}) {
  const response = await hono.request(`/mcp/agent/servers/${encodeURIComponent(connectionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  })
  const text = await response.text()
  // Stateless 2025-era responses may arrive as one SSE event.
  const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? ""
  return { status: response.status, text, body: JSON.parse(data) as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } } }
}

function toolNames(body: { result?: Record<string, unknown> }): string[] {
  return (body.result?.tools as { name: string }[]).map((tool) => tool.name)
}

test("unknown, malformed, ungranted, disabled and other-organization connections look the same", async () => {
  const { hono } = app()
  const refused = await Promise.all(["emc_00000000000000000000000000", "not-a-connection", ungranted.id, disabled.id, elsewhere.id]
    .map((id) => rpc(hono, id, "tools/list")))
  for (const response of refused) {
    assert.equal(response.status, 200)
    assert.equal(response.text, refused[0]!.text)
  }
  assert.deepEqual(refused[0]!.body.error?.data, { error: "mcp_connection_not_found" })
  assert.ok(!refused[0]!.text.includes(ungranted.name) && !refused[0]!.text.includes(disabled.id))

  const granted = await rpc(hono, linear.id, "tools/list")
  assert.deepEqual(toolNames(granted.body), ["delete_issue", "list_issues", "update_issue"])
})

test("resolution refuses every connection the member may not use", async () => {
  const resolve = (connectionId: string) => resolveConnectionServer({ organizationId, member, connectionId, redirectUriBase: "http://127.0.0.1:8790", catalog: [] }, sources)
  for (const id of [ungranted.id, disabled.id, elsewhere.id, "microsoft-365", "not-a-connection"]) assert.equal(await resolve(id), null, id)
  assert.equal((await resolve(linear.id))?.state, "ready")
  assert.equal((await resolve(gmail.id))?.state, "pending")
})

test("disabled and App-only tools are hidden and the order never depends on the provider's", () => {
  const listed = [
    { name: "zeta", description: "Z", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
    { name: "alpha", description: "A", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
    { name: "hidden", description: "Disabled by an admin", inputSchema: { type: "object" } },
    { name: "app_only", description: "For the App", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
    { name: "not_an_object", description: "Bad schema", inputSchema: { type: "string" } },
    { name: "middle", inputSchema: {} },
  ]
  const toolPolicy = { allDisabled: false, disabledTools: ["hidden"], updatedBy: null, updatedByName: null, updatedAt: null }
  const forward = providerConnectionServerTools({ toolPolicy, tools: listed, capabilityName: (name) => `mcp:emc_x:${name}` })
  const reversed = providerConnectionServerTools({ toolPolicy, tools: [...listed].reverse(), capabilityName: (name) => `mcp:emc_x:${name}` })
  assert.deepEqual(forward, reversed)
  assert.deepEqual(forward.map(({ tool }) => tool.name), ["alpha", "middle", "zeta"])
  assert.deepEqual(forward[0]?.tool.annotations, { readOnlyHint: false, destructiveHint: true })
  // A tool its provider leaves unlabeled gets a title from its name and is a destructive write.
  assert.deepEqual(forward[1]?.tool, {
    name: "middle",
    title: "Middle",
    description: "middle",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false, destructiveHint: true },
  })
  assert.deepEqual(forward[2]?.tool.outputSchema, { type: "object", properties: { ok: { type: "boolean" } } })
  assert.equal(forward[2]?.capability, "mcp:emc_x:zeta")
  assert.deepEqual(providerConnectionServerTools({ toolPolicy: { ...toolPolicy, allDisabled: true }, tools: listed, capabilityName: String }), [])
})

test("a tool call runs through execute_capability's executor with the caller's audited agent context", async () => {
  assert.equal(CONNECTION_SERVER_ROUTE_DEPS.executeCapability, executeCapability)
  const { hono, calls } = app()
  const response = await rpc(hono, linear.id, "tools/call", { name: "update_issue", arguments: { id: "ENG-1" } })
  assert.deepEqual(response.body.result?.structuredContent, { ran: `mcp:${linear.id}:update_issue` })
  assert.equal(calls.length, 1)
  const [{ context, input }] = calls as [Call]
  assert.deepEqual(input, { name: `mcp:${linear.id}:update_issue`, body: { id: "ENG-1" } })
  assert.equal(context.usageSource, "agent")
  assert.equal(context.organizationId, organizationId)
  assert.deepEqual(context.member, member)
  assert.equal(context.principal.userId, userId)
  assert.equal(context.audit?.organizationId, organizationId)
  assert.equal(context.audit?.memberId, member.orgMembershipId)

  const unknown = await rpc(hono, linear.id, "tools/call", { name: "drop_database", arguments: {} })
  assert.match(unknown.body.error?.message ?? "", /not available on Linear/)
  assert.equal(calls.length, 1)
})

test("a connection the member has not connected lists only its status tool", async () => {
  const { hono, calls } = app()
  const external = await rpc(hono, notConnected.id, "tools/list")
  assert.deepEqual(toolNames(external.body), [CONNECTION_STATUS_TOOL_NAME])
  await rpc(hono, notConnected.id, "tools/call", { name: CONNECTION_STATUS_TOOL_NAME, arguments: {} })
  // The status capability execute_capability runs for a connection_status match.
  assert.deepEqual(calls.map(({ input }) => input), [{ name: `mcp:${notConnected.id}:*` }])
  const blocked = await rpc(hono, notConnected.id, "tools/call", { name: "list_pages", arguments: {} })
  assert.match(blocked.body.error?.message ?? "", /Connect Notion first/)

  const native = await rpc(hono, gmail.id, "tools/list")
  assert.deepEqual(toolNames(native.body), [CONNECTION_STATUS_TOOL_NAME])
  const card = await rpc(hono, gmail.id, "tools/call", { name: CONNECTION_STATUS_TOOL_NAME, arguments: {} })
  const payload = card.body.result?.structuredContent as { connectionId: string; state: string }
  assert.equal(payload.connectionId, "google-workspace")
  assert.equal(payload.state, "needs_connection")
  assert.ok(card.body.result?._meta)
})

test("a provider that fails to list its tools is reported without its error text", async () => {
  const { hono } = app({
    sources: { ...sources, externalTools: async () => { throw new Error("upstream said: Authorization Bearer sk_live_synthetic") } },
  })
  const response = await rpc(hono, linear.id, "tools/list")
  assert.equal(response.body.error?.message, "Linear did not list its tools. Try again in a moment.")
  assert.ok(!response.text.includes("sk_live_synthetic"))
})

test("with the feature off the route is not found", async () => {
  const { hono, calls } = app({ features: async () => ({ connectionMcpServers: false, managedDeployments: false, outlookAttachments: false }) })
  const response = await hono.request(`/mcp/agent/servers/${linear.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "feature_disabled", feature: "connectionMcpServers" })
  assert.equal((await hono.request(`/mcp/agent/servers/${linear.id}`)).status, 404)
  assert.equal(calls.length, 0)
})

test("server URLs sit beneath the agent OAuth resource", () => {
  assert.equal(connectionServerUrl("https://app.example.com/api/den/mcp/agent/", "google-workspace"), "https://app.example.com/api/den/mcp/agent/servers/google-workspace")
})

test("an organization's open subscriptions hear about inventory changes, others do not", async () => {
  let revision = "1"
  const bus = new ConnectionServerEventBus(async (id) => id === organizationId ? revision : "other", 5)
  const heard: string[] = []
  const unsubscribe = bus.run(organizationId, () => bus.subscribe((event) => heard.push(`mine:${event.kind}`)))
  const unsubscribeOther = bus.run(otherOrganizationId, () => bus.subscribe((event) => heard.push(`other:${event.kind}`)))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(heard, [])
  revision = "2"
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(heard, ["mine:tools_list_changed"])
  unsubscribe()
  unsubscribeOther()
  revision = "3"
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(heard, ["mine:tools_list_changed"])
  assert.throws(() => bus.subscribe(() => undefined), /authenticated organization/)
})
