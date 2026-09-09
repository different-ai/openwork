import { expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3005"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"

type QueryRows = Record<string, unknown>[]
type FakeQuery = {
  from: (table: unknown) => FakeQuery
  innerJoin: () => FakeQuery
  orderBy: () => FakeQuery
  where: (condition: unknown) => FakeQuery
  limit: (count: number) => FakeQuery
  for: (mode: string) => FakeQuery
  then: Promise<QueryRows>["then"]
}

function fakeQuery(rows: QueryRows): FakeQuery {
  const promise = Promise.resolve(rows)
  const query: FakeQuery = {
    from: () => query,
    innerJoin: () => query,
    orderBy: () => query,
    where: () => query,
    limit: () => query,
    for: () => {
      throw new Error("Read-only external MCP checks must not lock rows")
    },
    then: promise.then.bind(promise),
  }
  return query
}

const connection = {
  id: "emc_01k28e8q8pf8r9sff9mhyqxved",
  organizationId: "org_01k28e8q8pf8r9sff9mhyqxved",
  name: "Fixture MCP",
  url: "https://mcp.example/sse",
  authType: "oauth",
  credentialMode: "per_member",
  kind: "external_mcp",
  nativeProviderKey: null,
  oauthConfiguration: null,
  toolPolicy: null,
  apiKey: null,
  accessToken: null,
  refreshToken: null,
  tokenType: null,
  scope: null,
  expiresAt: null,
  pendingCodeVerifier: null,
  credentialHealth: null,
  oauthIssuerReviewRequiredAt: null,
  connectedAt: null,
  createdByOrgMembershipId: "mem_owner",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}
const account = {
  id: "ca_01k28e8q8pf8r9sff9mhyqxved",
  organizationId: connection.organizationId,
  orgMembershipId: "mem_01k28e8q8pf8r9sff9mhyqxved",
  providerId: connection.id,
  externalAccountId: null,
  scopes: null,
  accessToken: "member-token",
  refreshToken: null,
  tokenType: null,
  expiresAt: null,
  pendingCodeVerifier: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}
const orgClient = {
  id: "ooc_01k28e8q8pf8r9sff9mhyqxved",
  organizationId: connection.organizationId,
  providerId: connection.id,
  clientId: "mcp-client-id",
  clientSecret: null,
  extra: null,
  createdByOrgMembershipId: connection.createdByOrgMembershipId,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}
let selectResults: QueryRows[] = []
let transactionCalls = 0

function queueSelectResults(results: QueryRows[]): void {
  selectResults = results
  transactionCalls = 0
}

mock.module("../src/db.js", () => ({
  db: {
    select: () => fakeQuery(selectResults.shift() ?? []),
    selectDistinct: () => fakeQuery(selectResults.shift() ?? []),
    transaction: () => {
      transactionCalls += 1
      throw new Error("Read-only external MCP checks must not open a transaction")
    },
  },
}))

const {
  readConnectedAccountForExternalMcpIdentity,
  readOrgOAuthClientForExternalMcpIdentity,
  readyExternalMcpConnectionsForMember,
  listUsableExternalMcpConnections,
} = await import("../src/capability-sources/external-mcp-connections.js")

test("plugin-sourced GitHub PATs and legacy none remain usable without bypassing access or explicit OAuth", async () => {
  const organizationId = createDenTypeId("organization")
  const orgMembershipId = createDenTypeId("member")
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")
  const binding = { id: createDenTypeId("pluginMcpRequirementBinding"), pluginId, configObjectId, serverName: "github" }
  const url = "https://api.githubcopilot.com/mcp/"
  const cases = [
    { authType: "apikey", oauth: false, granted: true, usable: true },
    { authType: "oauth", oauth: false, granted: true, usable: true },
    { authType: "none", oauth: false, granted: true, usable: true },
    { authType: "none", oauth: true, granted: true, usable: false },
    { authType: "apikey", oauth: true, granted: true, usable: false },
    { authType: "oauth", oauth: true, granted: true, usable: true },
    { authType: "apikey", oauth: false, granted: false, usable: false },
    { authType: "none", oauth: false, granted: false, usable: false },
  ]
  for (const input of cases) {
    const candidate = {
      ...connection, organizationId, authType: input.authType, credentialMode: "shared", url,
      apiKey: input.authType === "apikey" ? "fixture-pat" : null,
      accessToken: input.authType === "oauth" ? "fixture-token" : null,
      connectedAt: new Date(),
    }
    queueSelectResults([
      [], // No direct grants: access must come from this plugin.
      [{ binding, connection: candidate, configObjectTitle: "GitHub" }],
      [{ configObjectId, normalizedPayloadJson: { mcpServers: { github: { url, oauth: input.oauth } } } }],
      [],
      input.granted ? [{ pluginId }] : [],
      [],
    ])
    expect(await listUsableExternalMcpConnections({ organizationId, orgMembershipId, teamIds: [] }))
      .toEqual(input.usable ? [candidate] : [])
    expect(selectResults).toHaveLength(0)
  }
  expect(transactionCalls).toBe(0)
})

test("GitHub plugin readiness preserves legacy ready and sign-in states but still enforces required OAuth setup", async () => {
  // The marketplace module imports the app graph; do not initialize auth's resource registry.
  mock.module("../src/auth.js", () => ({
    auth: { api: { getSession: async () => null }, handler: async () => new Response() },
    DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
    DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
    DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp"],
    DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
    DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
    DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp",
    DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
    DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
    DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
    DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
  }))
  const { resolveMarketplacePluginCloudReadiness, searchMarketplaceCapabilities, executeMarketplaceCapability } = await import("../src/mcp/marketplace-capabilities.js")
  const organizationId = createDenTypeId("organization")
  const orgMembershipId = createDenTypeId("member")
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")
  const url = "https://api.githubcopilot.com/mcp/"
  for (const input of [
    { authType: "apikey", oauth: false, client: false, state: "ready" },
    { authType: "apikey", oauth: true, client: false, state: "needs_admin_setup" },
    { authType: "none", oauth: false, client: false, state: "ready" },
    { authType: "none", oauth: true, client: false, state: "needs_admin_setup" },
    { authType: "none", oauth: false, client: false, state: "needs_admin_setup", disconnected: true },
    { authType: "oauth", oauth: false, client: false, state: "ready" },
    { authType: "oauth", oauth: false, client: true, state: "ready" },
    { authType: "oauth", oauth: true, client: false, state: "needs_admin_setup" },
    { authType: "oauth", oauth: true, client: true, state: "ready" },
    { authType: "oauth", oauth: false, client: false, state: "needs_admin_setup", disconnected: true },
    { authType: "oauth", oauth: false, client: false, state: "ready", perMember: true },
    { authType: "oauth", oauth: false, client: false, state: "needs_signin", perMember: true, disconnected: true },
    { authType: "oauth", oauth: true, client: false, state: "needs_admin_setup", perMember: true, disconnected: true },
  ]) {
    const candidate = {
      ...connection, organizationId, url, authType: input.authType, credentialMode: input.perMember ? "per_member" : "shared",
      apiKey: input.authType === "apikey" ? "fixture-pat" : null,
      accessToken: input.authType === "oauth" && !input.perMember && !input.disconnected ? "fixture-token" : null,
      connectedAt: input.disconnected ? null : new Date(),
    }
    queueSelectResults([
      [{ id: configObjectId, objectType: "mcp", pluginId, title: "GitHub" }],
      [{ configObjectId, normalizedPayloadJson: { mcpServers: { github: { url, oauth: input.oauth } } } }],
      [{ connection: candidate }],
      [],
      [candidate],
      [],
      ...(input.perMember ? [input.disconnected ? [] : [{ ...account, organizationId, orgMembershipId }]] : []),
      ...(input.oauth || input.authType === "oauth" ? [input.client ? [orgClient] : []] : []),
    ])
    const readiness = await resolveMarketplacePluginCloudReadiness({
      organizationId, member: { orgMembershipId, teamIds: [] }, pluginIds: [pluginId],
    })
    expect(readiness.get(pluginId)?.state).toBe(input.state)
    expect(readiness.get(pluginId)?.connections[0]?.authTypeMismatch).toBe(input.oauth && input.authType !== "oauth")
    expect(readiness.get(pluginId)?.connections[0]?.connectedForMe).toBe(!input.disconnected)
    expect(readiness.get(pluginId)?.connections[0]?.oauthClientConfigured).toBe(input.oauth || input.authType === "oauth" ? input.client : undefined)
    expect(readiness.get(pluginId)?.connections[0]?.oauthClientRequired).toBe(input.oauth ? true : input.authType === "oauth" ? false : undefined)
    expect(selectResults).toHaveLength(0)

    const skillId = createDenTypeId("configObject")
    const row = {
      configObject: { id: skillId, objectType: "skill", title: "Legacy GitHub", description: "Legacy readiness", searchText: "legacy github" },
      plugin: { id: pluginId, name: "Legacy GitHub" },
      marketplace: null,
    }
    const grants = [{ resourceId: pluginId, orgWide: true, role: "viewer", removedAt: null }]
    const requirementRows = [
      [{ configObjectId, pluginId, pluginName: "Legacy GitHub", title: "GitHub" }],
      [{ configObjectId, normalizedPayloadJson: { mcpServers: { github: { url, oauth: input.oauth } } } }],
      [], // Requirement bindings.
      [candidate], // All connections.
      [{ connection: candidate }], [], // Usable direct and plugin-sourced connections.
    ]
    const memberRows = input.perMember ? [input.disconnected ? [] : [{ ...account, organizationId, orgMembershipId }]] : []
    const authMismatch = input.oauth && input.authType !== "oauth"
    const discoveryState = authMismatch || (input.disconnected && !input.perMember)
      ? "needs_admin_setup"
      : input.disconnected ? "needs_connection" : "ready"
    queueSelectResults([
      [{ id: orgMembershipId, role: "member" }],
      [row], [], [], // Marketplace rows, grant-only rows and their subquery.
      [], grants,
      ...requirementRows,
      ...(!authMismatch ? memberRows : []),
    ])
    const matches = await searchMarketplaceCapabilities({ organizationId, member: { orgMembershipId, teamIds: [] }, query: "legacy github" })
    expect(matches).toHaveLength(1)
    expect(matches[0]?.status).toBe(discoveryState)
    expect(matches[0]?.mcpRequirements?.[0]?.state).toBe(discoveryState)
    if (discoveryState === "needs_connection") expect(matches[0]?.action?.surface).toBe("openwork_your_connections")
    expect(selectResults).toHaveLength(0)

    const missingClient = input.authType === "oauth" && !input.client
    queueSelectResults([
      [row], [{ id: orgMembershipId, role: "member" }], [], grants,
      [{ rawSourceText: "Legacy instruction sentinel" }],
      ...requirementRows,
      ...(!authMismatch && input.authType === "oauth" ? [input.client ? [orgClient] : []] : []),
      ...(!authMismatch && !missingClient ? memberRows : []),
    ])
    const executed = await executeMarketplaceCapability({ organizationId, member: { orgMembershipId, teamIds: [] }, pluginId, configObjectId: skillId })
    if (!executed.ok) throw new Error(executed.message)
    const executionState = missingClient ? "needs_admin_setup" : discoveryState
    if (executionState === "ready") {
      expect(executed.result.content).toBe("Legacy instruction sentinel")
    } else {
      expect(executed.result.status).toBe(executionState)
      expect(executed.result.content).toBeUndefined()
    }
    expect(selectResults).toHaveLength(0)
  }
  expect(transactionCalls).toBe(0)
})

test("per-member connection list readiness reads credentials without row locks", async () => {
  queueSelectResults([[connection], [account], [connection]])
  await expect(readyExternalMcpConnectionsForMember(
    [connection] as never,
    account.orgMembershipId as never,
  )).resolves.toEqual([connection])
  expect(transactionCalls).toBe(0)
  expect(selectResults).toHaveLength(0)
})

test("per-member connected account reads do not lock the shared connection row", async () => {
  queueSelectResults([[connection], [account], [connection]])
  await expect(readConnectedAccountForExternalMcpIdentity({
    connection: connection as never,
    orgMembershipId: account.orgMembershipId as never,
  })).resolves.toEqual({ current: true, value: account })
  expect(transactionCalls).toBe(0)
  expect(selectResults).toHaveLength(0)
})

test("org OAuth client reads do not lock the shared connection row", async () => {
  queueSelectResults([[connection], [orgClient], [connection]])
  await expect(readOrgOAuthClientForExternalMcpIdentity(connection as never)).resolves.toEqual({
    current: true,
    value: orgClient,
  })
  expect(transactionCalls).toBe(0)
  expect(selectResults).toHaveLength(0)
})
