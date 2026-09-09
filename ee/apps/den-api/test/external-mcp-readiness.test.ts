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

test("plugin-sourced GitHub PATs remain usable without allowing anonymous or explicit OAuth mismatches", async () => {
  const organizationId = createDenTypeId("organization")
  const orgMembershipId = createDenTypeId("member")
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")
  const binding = { id: createDenTypeId("pluginMcpRequirementBinding"), pluginId, configObjectId, serverName: "github" }
  const url = "https://api.githubcopilot.com/mcp/"
  const cases = [
    { authType: "apikey", oauth: false, granted: true, usable: true },
    { authType: "oauth", oauth: false, granted: true, usable: true },
    { authType: "none", oauth: false, granted: true, usable: false },
    { authType: "apikey", oauth: true, granted: true, usable: false },
    { authType: "oauth", oauth: true, granted: true, usable: true },
    { authType: "apikey", oauth: false, granted: false, usable: false },
  ]
  for (const input of cases) {
    const candidate = { ...connection, organizationId, authType: input.authType, credentialMode: "shared", url, apiKey: "fixture-pat" }
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

test("GitHub plugin readiness accepts PATs and still requires a registered client for OAuth", async () => {
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
  const { resolveMarketplacePluginCloudReadiness } = await import("../src/mcp/marketplace-capabilities.js")
  const organizationId = createDenTypeId("organization")
  const orgMembershipId = createDenTypeId("member")
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")
  const url = "https://api.githubcopilot.com/mcp/"
  for (const input of [
    { authType: "apikey", oauth: false, client: false, state: "ready" },
    { authType: "apikey", oauth: true, client: false, state: "needs_admin_setup" },
    { authType: "none", oauth: false, client: false, state: "needs_admin_setup" },
    { authType: "oauth", oauth: false, client: false, state: "needs_admin_setup" },
    { authType: "oauth", oauth: false, client: true, state: "ready" },
  ]) {
    const candidate = {
      ...connection, organizationId, url, authType: input.authType, credentialMode: "shared",
      apiKey: input.authType === "apikey" ? "fixture-pat" : null,
      accessToken: input.authType === "oauth" ? "fixture-token" : null,
      connectedAt: new Date(),
    }
    queueSelectResults([
      [{ id: configObjectId, objectType: "mcp", pluginId, title: "GitHub" }],
      [{ configObjectId, normalizedPayloadJson: { mcpServers: { github: { url, oauth: input.oauth } } } }],
      [{ connection: candidate }],
      [],
      [candidate],
      [],
      ...(input.oauth || input.authType === "oauth" ? [input.client ? [orgClient] : []] : []),
    ])
    const readiness = await resolveMarketplacePluginCloudReadiness({
      organizationId, member: { orgMembershipId, teamIds: [] }, pluginIds: [pluginId],
    })
    expect(readiness.get(pluginId)?.state).toBe(input.state)
    expect(readiness.get(pluginId)?.connections[0]?.oauthClientRequired).toBe(input.authType === "oauth" ? true : input.oauth ? false : undefined)
    expect(selectResults).toHaveLength(0)
  }
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
