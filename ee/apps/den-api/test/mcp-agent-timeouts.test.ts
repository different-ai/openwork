import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import type { ExecuteCapabilityToolResult } from "../src/mcp/agent.js"
import {
  BUILTIN_ADD_TO_MARKETPLACE_CAPABILITY,
  BUILTIN_ADD_USER_TO_MARKETPLACE_CAPABILITY,
  BUILTIN_CREATE_SKILL_CAPABILITY,
  BUILTIN_SHARE_PLUGIN_CAPABILITY,
  BUILTIN_SKILL_DESCRIPTORS,
  executeBuiltinSkillCapability,
  searchBuiltinSkillCapabilities,
} from "../src/mcp/builtin-skills.js"
import { compareCapabilityMatches, type CapabilityMatch } from "../src/mcp/search.js"

// These unit tests exercise protocol/result shaping, not authentication or HTML
// rendering. Avoid auth's startup database writes and generated bundle imports.
mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp/agent"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))
mock.module("@openwork/mcp-apps/plugin-flow", () => ({ pluginFlowAppHtml: "<html></html>" }))
mock.module("@openwork/mcp-apps/skill-created", () => ({ skillCreatedAppHtml: "<html></html>" }))
afterAll(() => mock.restore())

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = process.env.DEN_ALLOW_PRIVATE_MCP_URLS ?? "1"
}

class MemoryTransport implements Transport {
  private peer: MemoryTransport | undefined
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onmessage: (<T extends JSONRPCMessage>(message: T) => void) | undefined

  connectPeer(peer: MemoryTransport) {
    this.peer = peer
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.peer?.onmessage?.(message)
  }

  async close(): Promise<void> {
    this.onclose?.()
  }
}

function createMemoryTransportPair() {
  const client = new MemoryTransport()
  const server = new MemoryTransport()
  client.connectPeer(server)
  server.connectPeer(client)
  return { client, server }
}

let agentModule: typeof import("../src/mcp/agent.js")

beforeAll(async () => {
  seedRequiredEnv()
  agentModule = await import("../src/mcp/agent.js")
})

test("executeCapabilityWithBudget returns a structured timeout result", async () => {
  const { EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS } = await import("../src/capability-sources/external-mcp-client.js")
  expect(agentModule.EXECUTE_CAPABILITY_TIMEOUT_MS).toBeGreaterThan(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS)

  const result = await agentModule.executeCapabilityWithBudget({
    capability: "gmail_search",
    timeoutMs: 1,
    invoke: () => new Promise<ExecuteCapabilityToolResult>(() => {}),
  })

  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toBe(JSON.stringify({
    error: "capability_timeout",
    capability: "gmail_search",
    message: "The capability call exceeded 180s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.",
  }))
})

test("executeCapabilityWithBudget swallows late rejections after timeout", async () => {
  const unhandled: unknown[] = []
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandledRejection)

  try {
    const result = await agentModule.executeCapabilityWithBudget({
      capability: "slow_google_workspace",
      timeoutMs: 1,
      invoke: () => new Promise<ExecuteCapabilityToolResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late capability failure")), 10)
      }),
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(JSON.stringify({
      error: "capability_timeout",
      capability: "slow_google_workspace",
      message: "The capability call exceeded 180s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.",
    }))

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
  }
})

test("agent MCP server exposes steering instructions during initialize", async () => {
  const server = agentModule.createAgentMcpServer()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transports = createMemoryTransportPair()

  await server.connect(transports.server)
  await client.connect(transports.client)

  expect(client.getInstructions()).toBe(agentModule.AGENT_MCP_INSTRUCTIONS)
  expect(client.getInstructions()).toContain("Use create_skill")
  expect(client.getInstructions()).toContain("do not route these flows through execute_capability, postPlugins, or postConfigObjectsVersions")
  expect(client.getInstructions()).toContain("update_skill to publish a new immutable version")
  expect(client.getInstructions()).toContain("Do not execute the same status again when the search response includes connectionAction")
  expect(client.getInstructions()).toContain("create-skill")
  expect(client.getInstructions()).toContain("share-plugin")
  expect(client.getInstructions()).toContain("add-to-marketplace")
  expect(client.getInstructions()).toContain("add-user-to-marketplace")
  expect(client.getInstructions()).toContain("add a public GitHub plugin to an organization marketplace")
  expect(client.getInstructions()).toContain("Preview first")
  expect(client.getInstructions()).toContain("Do not choose one authentication type for every server")
  expect(client.getInstructions()).toContain("An import or plugin binding is not proof")
  expect(client.getInstructions()).toContain("cloudReadiness")
  expect(client.getInstructions()).toContain("Gmail read/search")
  expect(client.getInstructions()).toContain("Settings > Connect")
  expect(client.getInstructions()).toContain("Never tell the user to reconnect OpenWork Cloud")
  expect(client.getInstructions()).toContain("connectionStatus.connectionName")
  expect(client.getInstructions()).toContain("schemaGuidance is advisory")
  expect(client.getInstructions()).toContain("always attempts the downstream provider call")
  expect(client.getInstructions()).toContain("invalid_capability_arguments")
  expect(client.getInstructions()).toContain("never retry the same arguments unchanged")
  expect(client.getInstructions()).toContain("on the remote session")
  expect(client.getInstructions()).toContain("remote-session:create")
  expect(client.getInstructions()).toContain("OpenWork Web instance")

  await client.close()
  await server.close()
})

test("agent MCP server exposes a standards-shaped remote skill index", () => {
  const index = agentModule.buildAgentSkillIndex([{
    name: "customer-briefing",
    title: "Customer Briefing",
    description: "Use for accounts & renewals",
    marketplaceName: "Go To Market",
    pluginName: "Revenue Operations",
    capability: "skill:skill_customer_briefing",
    location: "skill://customer-briefing/SKILL.md",
  }])
  expect(index).toEqual({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [{
      name: "customer-briefing",
      type: "skill-md",
      title: "Customer Briefing",
      description: "Use for accounts & renewals",
      marketplaceName: "Go To Market",
      pluginName: "Revenue Operations",
      url: "skill://customer-briefing/SKILL.md",
      capability: "skill:skill_customer_briefing",
    }],
  })
})

test("built-in cloud skills are searchable and executable as skill capabilities", () => {
  expect(searchBuiltinSkillCapabilities("create a skill").map((match) => match.name)).toContain(BUILTIN_CREATE_SKILL_CAPABILITY)
  expect(searchBuiltinSkillCapabilities("share this skill with my team").map((match) => match.name)).toContain(BUILTIN_SHARE_PLUGIN_CAPABILITY)
  expect(searchBuiltinSkillCapabilities("add this to marketplace").map((match) => match.name)).toContain(BUILTIN_ADD_TO_MARKETPLACE_CAPABILITY)
  expect(searchBuiltinSkillCapabilities("add this user to the marketplace").map((match) => match.name)).toContain(BUILTIN_ADD_USER_TO_MARKETPLACE_CAPABILITY)
  expect(searchBuiltinSkillCapabilities("calendar events")).toEqual([])

  const createSkill = executeBuiltinSkillCapability(BUILTIN_CREATE_SKILL_CAPABILITY)
  expect(createSkill).toMatchObject({
    kind: "skill",
    name: "Create Skill",
    provenance: "Built into OpenWork Cloud.",
  })
  expect(createSkill?.content).toContain("name: create-skill")
  expect(createSkill?.content).toContain("openwork-cloud_create_skill")
  expect(createSkill?.content).toContain("Do not route this flow through `execute_capability` or `postPlugins`")
  expect(createSkill?.content).toContain("`duplicate_plugin`")
  expect(createSkill?.content).toContain("share-plugin")
  expect(createSkill?.content).toContain("Do not attach it to a marketplace or grant org-wide access")
  expect(createSkill?.content).not.toContain("Set organization-wide access or a marketplace")

  const addToMarketplace = executeBuiltinSkillCapability(BUILTIN_ADD_TO_MARKETPLACE_CAPABILITY)
  expect(addToMarketplace?.content).toContain("name: add-to-marketplace")
  expect(addToMarketplace?.content).toContain("postMarketplacesPlugins")
  expect(addToMarketplace?.content).toContain("Do not create a new skill or plugin")

  const addUser = executeBuiltinSkillCapability(BUILTIN_ADD_USER_TO_MARKETPLACE_CAPABILITY)
  expect(addUser?.content).toContain("name: add-user-to-marketplace")
  expect(addUser?.content).toContain("postMarketplacesAccess")
  expect(addUser?.content).toContain("orgMembershipId")

  const sharePlugin = executeBuiltinSkillCapability(BUILTIN_SHARE_PLUGIN_CAPABILITY)
  expect(sharePlugin).toMatchObject({ kind: "skill", name: "Share Plugin" })
  expect(sharePlugin?.content).toContain("name: share-plugin")
  expect(sharePlugin?.content).toContain("postPluginsAccess")
  expect(sharePlugin?.content).toContain('Use `"role": "viewer"` by default')
  expect(executeBuiltinSkillCapability("skill:missing")).toBeNull()
})

test("agent MCP server publishes built-in cloud skills as readable MCP resources", async () => {
  const server = agentModule.createAgentMcpServer()
  agentModule.registerAgentSkillResources({
    server,
    organizationId: "org_test",
    member: null,
    skills: BUILTIN_SKILL_DESCRIPTORS,
  })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transports = createMemoryTransportPair()

  await server.connect(transports.server)
  await client.connect(transports.client)

  const resources = await client.listResources()
  for (const skill of BUILTIN_SKILL_DESCRIPTORS) {
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: skill.location,
      name: skill.name,
    }))
    const resource = await client.readResource({ uri: skill.location })
    const content = resource.contents[0]
    const source = content && "text" in content ? content.text : ""
    expect(source).toContain(`name: ${skill.name}`)
  }

  await client.close()
  await server.close()
})

test("agent MCP server publishes the authorized skill index as an MCP resource", async () => {
  const server = agentModule.createAgentMcpServer()
  agentModule.registerAgentSkillResources({
    server,
    organizationId: "org_test",
    member: null,
    skills: [{
      name: "customer-briefing",
      title: "Customer Briefing",
      description: "Prepare customer briefings.",
      capability: "skill:skill_customer_briefing",
      location: "skill://customer-briefing/SKILL.md",
    }],
  })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transports = createMemoryTransportPair()

  await server.connect(transports.server)
  await client.connect(transports.client)

  const resources = await client.listResources()
  expect(resources.resources.map((resource) => resource.uri)).toContain("skill://index.json")
  expect(resources.resources.map((resource) => resource.uri)).toContain("skill://customer-briefing/SKILL.md")
  expect(resources.resources.find((resource) => resource.uri === "skill://customer-briefing/SKILL.md")).toMatchObject({
    name: "customer-briefing",
    title: "Customer Briefing",
    description: "Prepare customer briefings.",
  })
  const index = await client.readResource({ uri: "skill://index.json" })
  const content = index.contents[0]
  expect(content && "text" in content ? JSON.parse(content.text) : null).toEqual(agentModule.buildAgentSkillIndex([{
    name: "customer-briefing",
    title: "Customer Briefing",
    description: "Prepare customer briefings.",
    capability: "skill:skill_customer_briefing",
    location: "skill://customer-briefing/SKILL.md",
  }]))

  await client.close()
  await server.close()
})

test("capability search results include structured output alongside text compatibility", () => {
  const matches = [{
    name: "getOrganizations",
    method: "GET",
    path: "/v1/organizations",
    score: 10,
    summary: "List organizations",
    pathParams: [],
    queryParams: [],
    hasBody: false,
  }]
  const result = agentModule.capabilitySearchToolResult(matches)

  expect(result.structuredContent).toEqual({ matches })
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ matches })
  const connectionStatus = {
    version: 1, kind: "connection_action", source: "openwork-cloud",
    layer: "mcp_connection", errorCode: "not_connected", authType: "oauth", credentialMode: "per_member",
    connectionId: "emc_notes", connectionName: "Notes", state: "needs_connection",
    actor: "member", message: "Connect your notes account.",
    action: { type: "connect", label: "Connect Notes", surface: "openwork_your_connections", retry: "search_capabilities" },
  }
  const blocked = [{ ...matches[0], kind: "connection_status", connectionStatus }]
  const quiet = agentModule.capabilitySearchToolResult(blocked)
  expect(quiet.structuredContent.matches).toEqual(blocked)
  expect(quiet.structuredContent.connectionAction).toBeUndefined()
  expect(quiet).not.toHaveProperty("_meta")
  const actionable = agentModule.capabilitySearchToolResult(blocked, undefined, null, true)
  expect(actionable.structuredContent.matches).toEqual(blocked)
  expect(actionable.structuredContent.connectionAction?.connectionId).toBe("emc_notes")
  expect(actionable).not.toHaveProperty("_meta")
  expect(agentModule.SEARCH_CAPABILITIES_OUTPUT_SCHEMA.safeParse(actionable.structuredContent).success).toBe(true)
  expect(result).not.toHaveProperty("_meta")
})

test("capability search preserves the bounded-fanout coverage warning", () => {
  const result = agentModule.capabilitySearchToolResult([], "External MCP search inspected 16 of 17 eligible connections. Results may be incomplete.")
  const structured = result.structuredContent

  expect(structured).toEqual({
    matches: [],
    hint: "No matches. Try broader or different keywords. External MCP search inspected 16 of 17 eligible connections. Results may be incomplete.",
  })
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(structured)
})

test("external capability failures preserve the slim agent-facing MCP error envelope", () => {
  const result = agentModule.externalCapabilityErrorToolResult({
    ok: false,
    error: "connection_failed",
    message: "Connection failed. Diagnostic reference: req_test.",
    referenceId: "req_test",
    retryable: false,
    providerError: {
      jsonRpcCode: -32050,
      message: "Provider quota exceeded.",
      data: '{"reason":"quota"}',
    },
    connectionStatus: {
      version: 1,
      kind: "connection_action",
      source: "openwork-cloud",
      layer: "mcp_connection",
      connectionId: "emc_test",
      connectionName: "Knowledge Hub",
      authType: "oauth",
      credentialMode: "per_member",
      state: "reauth_required",
      errorCode: "invalid_grant",
      message: "Authorization expired.",
      actor: "member",
      action: {
        type: "reconnect",
        label: "Reconnect Knowledge Hub",
        surface: "openwork_your_connections",
        retry: "search_capabilities",
      },
    },
  })
  expect(result.isError).toBe(true)
  const payload = JSON.parse(result.content[0]?.text ?? "{}")
  expect(payload).toMatchObject({
    error: "connection_failed",
    referenceId: "req_test",
    retryable: false,
    providerError: {
      jsonRpcCode: -32050,
      message: "Provider quota exceeded.",
      data: '{"reason":"quota"}',
    },
    connectionStatus: {
      connectionId: "emc_test",
      state: "reauth_required",
      action: { type: "reconnect" },
    },
  })
  expect("diagnostic" in payload).toBe(false)
  expect("actionOwner" in payload).toBe(false)
  expect("operatorAction" in payload).toBe(false)
  expect("diagnostic" in payload.connectionStatus).toBe(false)
  expect(result.structuredContent).toMatchObject({
    schemaVersion: "1",
    connectionId: "emc_test",
    state: "reauth_required",
    action: { type: "reconnect" },
  })
  expect(result).not.toHaveProperty("_meta")
})

test("invalid capability arguments preserve corrective retry instructions", () => {
  const result = agentModule.externalCapabilityErrorToolResult({
    ok: false,
    error: "invalid_capability_arguments",
    capability: "mcp:emc_test:lookup_incident",
    message: "The capability arguments do not match its advertised schema.",
    issues: [{
      path: "/query",
      keyword: "schema_validation",
      message: "Required property query is missing.",
    }],
    schemaDigest: `sha256:${"a".repeat(64)}`,
    sameArgumentsRetryable: false,
    retry: { action: "correct_arguments", searchRequired: false },
  })

  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
    error: "invalid_capability_arguments",
    message: "The capability arguments do not match its advertised schema.",
    capability: "mcp:emc_test:lookup_incident",
    issues: [{
      path: "/query",
      keyword: "schema_validation",
      message: "Required property query is missing.",
    }],
    schemaDigest: `sha256:${"a".repeat(64)}`,
    sameArgumentsRetryable: false,
    retry: { action: "correct_arguments", searchRequired: false },
  })
})

test.each([true, false, undefined])("provider output preserves schema guidance without overwriting provider data (isError=%s)", (isError) => {
  const provider = {
    content: [{ type: "text", text: "Provider result." }],
    structuredContent: { serverTools: ["provider-tool"], schemaGuidance: { provider: true } },
    _meta: { privateFixture: "view-only" },
    ...(isError === undefined ? {} : { isError }),
  }
  const result = agentModule.externalCapabilitySuccessToolResult({
    ok: true,
    result: provider,
    mcpApp: { connectionId: "emc_fixture", toolName: "render", resourceUri: "ui://fixture/view.html", arguments: {} },
    schemaGuidance: {
      advisory: true,
      providerCallAttempted: true,
      message: "OpenWork forwarded the call to the provider. Use the provider result as the source of truth.",
      warnings: [{
        code: "arguments_schema_mismatch",
        message: "The arguments did not match the advertised schema.",
        issues: [{
          path: "/",
          keyword: "schema_validation",
          message: "Unexpected providerExtension property.",
        }],
        suggestedAction: "Do not retry because the provider succeeded.",
      }],
    },
  })

  expect(result.isError).toBe(isError)
  expect(result.content[0]).toEqual(provider.content[0])
  expect(result.structuredContent).toEqual(provider.structuredContent)
  expect(result._meta).toMatchObject({
    privateFixture: "view-only",
    "openwork/serverTools": { searchCapabilities: "search_capabilities", executeCapability: "execute_capability" },
    "openwork/schemaGuidance": { advisory: true },
  })
  expect(JSON.stringify(result.content)).not.toContain("view-only")
  expect(JSON.stringify(result.content)).not.toContain("openwork/serverTools")
  expect(JSON.parse(result.content[1]?.text ?? "{}")).toMatchObject({
    "openwork/schemaGuidance": {
      advisory: true,
      providerCallAttempted: true,
      warnings: [{ code: "arguments_schema_mismatch" }],
    },
  })
  expect(agentModule.externalCapabilitySuccessToolResult({ ok: true, result: provider })).toEqual(provider)
})

test("structured search output remains compatible with marketplace match kinds and statuses", () => {
  const result = agentModule.SEARCH_CAPABILITIES_OUTPUT_SCHEMA.safeParse({
    matches: [{
      name: "marketplace:plugin:skill",
      method: "MARKETPLACE",
      path: "marketplace://plugin/skill",
      score: 8,
      summary: "Install a shared skill",
      pathParams: [],
      queryParams: [],
      hasBody: false,
      kind: "skill",
      status: "needs_install",
    }],
  })

  expect(result.success).toBe(true)
})

test("capability discovery is marked read-only while generic execution remains guarded", () => {
  expect(agentModule.SEARCH_CAPABILITIES_ANNOTATIONS).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  })
  expect(agentModule.EXECUTE_CAPABILITY_ANNOTATIONS).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  })
})

test("connection status only outranks equally relevant callable tools", () => {
  type ConnectionStatusMatch = CapabilityMatch & { kind: "connection_status" }
  const callableMatch: CapabilityMatch = {
    name: "slack_search_emojis",
    method: "MCP",
    path: "https://mcp.slack.test",
    score: 20,
    summary: "Search custom emoji",
    pathParams: [],
    queryParams: [],
    hasBody: true,
  }
  const statusMatch: ConnectionStatusMatch = {
    kind: "connection_status",
    name: "mcp:notion:*",
    method: "MCP",
    path: "https://mcp.notion.test",
    score: 7,
    summary: "Notion needs attention",
    pathParams: [],
    queryParams: [],
    hasBody: false,
  }
  const matches: CapabilityMatch[] = [callableMatch, statusMatch]

  matches.sort(compareCapabilityMatches)

  expect(matches[0]?.name).toBe("slack_search_emojis")
  expect(matches[0]?.score).toBe(20)

  statusMatch.score = callableMatch.score
  matches.sort(compareCapabilityMatches)

  expect(matches[0]?.kind).toBe("connection_status")
  expect(matches[0]?.score).toBe(20)
})


test("connector discovery includes every preset and separates setup suggestions from tools", async () => {
  const { connectorCatalogForQuery } = await import("../src/mcp/connector-catalog.js");
  const { EXTERNAL_MCP_PRESETS } = await import("../src/capability-sources/external-mcp-presets.js");
  const catalog = connectorCatalogForQuery("Please connect Slack");
  expect(catalog?.selectedIds).toEqual(["slack"]);
  expect(catalog?.entries.map(entry => entry.id)).toEqual(["google-workspace", "microsoft-365", ...EXTERNAL_MCP_PRESETS.map(preset => preset.presetId)]);
  expect(catalog?.entries.find(entry => entry.id === "slack")?.setup).toBe("oauth_client");
  expect(connectorCatalogForQuery("slacker")).toBeNull();
  expect(connectorCatalogForQuery("write a report")).toBeNull();
  expect(connectorCatalogForQuery("all quick adds")?.selectedIds).toEqual([]);
  expect(connectorCatalogForQuery("Slack", true)?.selectedIds).toEqual([]);
  const result = agentModule.capabilitySearchToolResult([], undefined, catalog);
  expect(result.structuredContent.connectorCatalog).toEqual(catalog);
  expect(result.structuredContent.hint).toContain("not connected tools");
  for (const entry of catalog?.entries ?? []) expect(new URL(entry.setupUrl).searchParams.get("quickAdd")).toBe(entry.id);
});
