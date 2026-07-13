import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import { createMockScope, scopedFn, scopedValue } from "./support/scoped-module-mocks"

const mockScope = createMockScope()

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

// configurePluginServerInstance must validate non-OAuth instances the same
// way POST /v1/mcp-connections does: probe now, and on failure leave nothing
// behind — otherwise a typo'd URL or rejected key reads as "Connected"
// forever and only fails later at agent call time.
let rowsByTable: Map<unknown, unknown[]>
let dbWrites: Array<{ kind: "delete" | "insert" | "update"; table: unknown; values: Record<string, unknown> | null }>
let probeBehavior: "ok" | "fail"
let probeCalls: Array<{ connectionId: string; redirectUri: string }>
let deletedConnections: Array<{ connectionId: string; organizationId: string }>
let createdConnections: Array<Record<string, unknown>>

function queryChain() {
  let currentRows: unknown[] = []
  const proxy: any = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (onfulfilled?: (value: unknown[]) => unknown, onrejected?: (reason: unknown) => unknown) =>
          Promise.resolve(currentRows).then(onfulfilled, onrejected)
      }
      if (prop === "from") {
        return (table: unknown) => {
          currentRows = rowsByTable.get(table) ?? []
          return proxy
        }
      }
      return () => proxy
    },
  })
  return proxy
}

function captureWrite(kind: "delete" | "insert" | "update", table: unknown) {
  const record = (values: Record<string, unknown> | null) => {
    dbWrites.push({ kind, table, values })
  }
  return {
    set: (values: Record<string, unknown>) => {
      record(values)
      return { where: () => Promise.resolve() }
    },
    values: (values: Record<string, unknown>) => {
      record(values)
      return Promise.resolve()
    },
    where: () => {
      record(null)
      return Promise.resolve()
    },
  }
}

const dbStub = {
  delete: (table: unknown) => captureWrite("delete", table),
  insert: (table: unknown) => captureWrite("insert", table),
  select: () => queryChain(),
  transaction: async <TResult>(callback: (tx: typeof dbStub) => Promise<TResult>) => callback(dbStub),
  update: (table: unknown) => captureWrite("update", table),
}

function adminContext(): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: createDenTypeId("organization"),
        name: "Caller",
        slug: "caller",
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: createDenTypeId("member"),
        userId: "user_admin",
        role: "admin",
        createdAt: now,
        joinedAt: now,
        isOwner: false,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
  }
}

let storeModule: typeof import("../src/routes/org/plugin-system/store.js")
let schema: typeof import("@openwork-ee/den-db/schema")

function seedConfigObjectRows(authType: "apikey" | "none") {
  const now = new Date()
  const organizationId = createDenTypeId("organization")
  const createdByOrgMembershipId = createDenTypeId("member")
  const configObjectId = createDenTypeId("configObject")
  const configObjectRow = {
    createdAt: now,
    createdByOrgMembershipId,
    connectorInstanceId: null,
    currentFileExtension: null,
    currentFileName: null,
    currentRelativePath: null,
    deletedAt: null,
    denSkillId: null,
    description: "Directory template",
    id: configObjectId,
    objectType: "mcp",
    organizationId,
    searchText: "svc",
    sourceMode: "cloud",
    status: "active",
    title: "Svc",
    updatedAt: now,
  }
  const versionRow = {
    configObjectId,
    connectorSyncEventId: null,
    createdAt: now,
    createdByOrgMembershipId,
    createdVia: "cloud",
    id: createDenTypeId("configObjectVersion"),
    isDeletedVersion: false,
    normalizedPayloadJson: {
      mcpServers: {
        svc: {
          authType,
          configFields: [],
          serverKey: "svc",
          type: "remote",
          url: "https://mcp.example.com/mcp",
        },
      },
      schemaVersion: "openwork.den_mcp_template.v1",
    },
    organizationId,
    rawSourceText: null,
    schemaVersion: "openwork.den_mcp_template.v1",
    sourceRevisionRef: null,
  }
  const pluginId = createDenTypeId("plugin")
  const pluginRow = {
    createdAt: now,
    createdByOrgMembershipId,
    deletedAt: null,
    description: "Directory plugin",
    id: pluginId,
    name: "Svc",
    organizationId,
    status: "active",
    updatedAt: now,
  }
  rowsByTable = new Map<unknown, unknown[]>([
    [schema.ConfigObjectTable, [configObjectRow]],
    [schema.ConfigObjectVersionTable, [versionRow]],
    [schema.PluginTable, [pluginRow]],
  ])
  return { configObjectId, pluginId }
}

beforeAll(async () => {
  seedRequiredEnv()

  // Capture original values eagerly: bun's mock.module rewrites live
  // bindings, so lazy namespace access would resolve to the mock itself.
  const realDbInstance = (await import("../src/db.js")).db
  const realAccess = { ...(await import("../src/routes/org/plugin-system/access.js")) }
  const realUrlGuard = { ...(await import("../src/capability-sources/url-guard.js")) }
  const realOauthCredentials = { ...(await import("../src/capability-sources/oauth-credentials.js")) }
  const realClient = { ...(await import("../src/capability-sources/external-mcp-client.js")) }
  const realConnections = { ...(await import("../src/capability-sources/external-mcp-connections.js")) }

  mock.module("../src/db.js", () => ({
    db: scopedValue(mockScope, () => realDbInstance, dbStub as unknown as typeof realDbInstance),
  }))
  mock.module("../src/routes/org/plugin-system/access.js", () => ({
    ...realAccess,
    requirePluginArchCapability: scopedFn(mockScope, () => realAccess.requirePluginArchCapability, async () => {}),
    requirePluginArchResourceRole: scopedFn(mockScope, () => realAccess.requirePluginArchResourceRole, async () => "manager" as const),
    resolvePluginArchResourceRole: scopedFn(mockScope, () => realAccess.resolvePluginArchResourceRole, async () => "manager" as const),
  }))
  mock.module("../src/capability-sources/url-guard.js", () => ({
    ...realUrlGuard,
    assertPublicUrl: scopedFn(mockScope, () => realUrlGuard.assertPublicUrl, async () => {}),
  }))
  mock.module("../src/capability-sources/oauth-credentials.js", () => ({
    ...realOauthCredentials,
    upsertOrgOAuthClient: scopedFn(mockScope, () => realOauthCredentials.upsertOrgOAuthClient, async () => {}),
  }))
  mock.module("../src/capability-sources/external-mcp-client.js", () => ({
    ...realClient,
    connectExternalMcp: scopedFn(
      mockScope,
      () => realClient.connectExternalMcp,
      async (connection: { id: string }, redirectUri: string) => {
        probeCalls.push({ connectionId: connection.id, redirectUri })
        if (probeBehavior === "fail") {
          throw new Error("connect ECONNREFUSED")
        }
        return { status: "connected" as const }
      },
    ) as typeof realClient.connectExternalMcp,
  }))
  mock.module("../src/capability-sources/external-mcp-connections.js", () => ({
    ...realConnections,
    createExternalMcpConnection: scopedFn(
      mockScope,
      () => realConnections.createExternalMcpConnection,
      (async (input: Record<string, unknown>) => {
        createdConnections.push(input)
        const now = new Date()
        return {
          accessToken: null,
          apiKey: input.apiKey ?? null,
          authType: input.authType,
          configValues: input.configValues ?? null,
          connectedAt: null,
          createdAt: now,
          createdByOrgMembershipId: input.createdByOrgMembershipId,
          credentialMode: input.credentialMode,
          expiresAt: null,
          id: createDenTypeId("externalMcpConnection"),
          name: input.name,
          organizationId: input.organizationId,
          pendingCodeVerifier: null,
          refreshToken: null,
          scope: null,
          tokenType: null,
          updatedAt: now,
          url: input.url,
        }
      }) as unknown as typeof realConnections.createExternalMcpConnection,
    ),
    deleteExternalMcpConnection: scopedFn(
      mockScope,
      () => realConnections.deleteExternalMcpConnection,
      (async (input: { connectionId: string; organizationId: string }) => {
        deletedConnections.push(input)
        return true
      }) as unknown as typeof realConnections.deleteExternalMcpConnection,
    ),
  }))

  schema = await import("@openwork-ee/den-db/schema")
  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

beforeEach(() => {
  mockScope.active = true
  dbWrites = []
  probeBehavior = "ok"
  probeCalls = []
  deletedConnections = []
  createdConnections = []
})

afterEach(() => {
  mockScope.active = false
})

test("an unreachable non-OAuth instance is rejected and fully cleaned up", async () => {
  const { configObjectId, pluginId } = seedConfigObjectRows("apikey")
  probeBehavior = "fail"

  let failure: unknown = null
  try {
    await storeModule.configurePluginServerInstance({
      apiKey: "sk-test",
      authType: "apikey",
      configObjectId,
      context: adminContext(),
      credentialMode: "shared",
      pluginId,
      redirectUriBase: "http://127.0.0.1:8790",
      serverKey: "svc",
    })
  } catch (error) {
    failure = error
  }

  expect(failure).toBeInstanceOf(storeModule.PluginArchRouteFailure)
  expect((failure as { status: number }).status).toBe(400)
  expect((failure as Error).message).toContain("Could not reach")
  expect(deletedConnections.length).toBe(1)
  expect(deletedConnections[0].connectionId).toBe((createdConnections[0] && probeCalls[0]?.connectionId) as string)

  const bindingInserts = dbWrites.filter((write) => write.table === schema.PluginMcpServerInstanceTable)
  expect(bindingInserts).toEqual([])
  const connectionUpdates = dbWrites.filter((write) => write.table === schema.ExternalMcpConnectionTable && write.kind === "update")
  expect(connectionUpdates).toEqual([])
})

test("a reachable api-key instance is probed, stamped connected, and bound", async () => {
  const { configObjectId, pluginId } = seedConfigObjectRows("apikey")

  const result = await storeModule.configurePluginServerInstance({
    apiKey: "sk-test",
    authType: "apikey",
    configObjectId,
    context: adminContext(),
    credentialMode: "shared",
    pluginId,
    redirectUriBase: "http://127.0.0.1:8790",
    serverKey: "svc",
  })

  expect(probeCalls.length).toBe(1)
  expect(probeCalls[0].redirectUri).toBe(`http://127.0.0.1:8790/v1/mcp-connections/${encodeURIComponent(probeCalls[0].connectionId)}/connect/callback`)
  expect(deletedConnections).toEqual([])

  const connectedStamps = dbWrites.filter((write) =>
    write.table === schema.ExternalMcpConnectionTable && write.kind === "update" && write.values && "connectedAt" in write.values)
  expect(connectedStamps.length).toBe(1)
  const bindingInserts = dbWrites.filter((write) => write.table === schema.PluginMcpServerInstanceTable && write.kind === "insert")
  expect(bindingInserts.length).toBe(1)
  expect(result.connection?.url).toBe("https://mcp.example.com/mcp")
})

test("a no-auth instance is probed and stamped connected too", async () => {
  const { configObjectId, pluginId } = seedConfigObjectRows("none")

  await storeModule.configurePluginServerInstance({
    authType: "none",
    configObjectId,
    context: adminContext(),
    credentialMode: "shared",
    pluginId,
    redirectUriBase: "http://127.0.0.1:8790",
    serverKey: "svc",
  })

  expect(probeCalls.length).toBe(1)
  const connectedStamps = dbWrites.filter((write) =>
    write.table === schema.ExternalMcpConnectionTable && write.kind === "update" && write.values && "connectedAt" in write.values)
  expect(connectedStamps.length).toBe(1)
})
