import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import { createMockScope, scopedValue } from "./support/scoped-module-mocks"

const mockScope = createMockScope()

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

// Rows returned per FROM-table identity; writes captured per table identity.
// The lazy default-marketplace seeding runs inside the member-reachable
// GET /v1/marketplaces path, so these tests pin two invariants:
//  1. a fully seeded org performs ZERO writes on list (pure read), and
//  2. seeding triggered by a plain member never writes personal access
//     grants — the caller must not gain manage rights from listing.
let rowsByTable: Map<unknown, unknown[]>
let writes: Array<{ kind: "delete" | "insert" | "update"; table: unknown; values: Record<string, unknown> | null }>

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
    writes.push({ kind, table, values })
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

function memberContext(): PluginArchActorContext {
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
        userId: "user_member",
        role: "member",
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
let presets: typeof import("../src/capability-sources/external-mcp-presets.js")

function seedRows(options: { seededDirectory: boolean }) {
  const now = new Date()
  const organizationId = createDenTypeId("organization")
  const createdByOrgMembershipId = createDenTypeId("member")
  const marketplaceRow = {
    createdAt: now,
    createdByOrgMembershipId,
    deletedAt: null,
    description: "Seeded",
    id: createDenTypeId("marketplace"),
    logoUrl: "/openwork-mark.svg",
    name: "Seeded",
    organizationId,
    status: "active",
    updatedAt: now,
  }
  const pluginRow = {
    createdAt: now,
    createdByOrgMembershipId,
    deletedAt: null,
    description: "Seeded",
    id: createDenTypeId("plugin"),
    name: "Seeded",
    organizationId,
    status: "active",
    updatedAt: now,
  }
  const membershipRows = options.seededDirectory
    ? Array.from({ length: presets.EXTERNAL_MCP_PRESETS.length }, () => ({
        createdAt: now,
        id: createDenTypeId("marketplacePlugin"),
        marketplaceId: marketplaceRow.id,
        membershipSource: "system",
        pluginId: pluginRow.id,
        removedAt: null,
      }))
    : []

  rowsByTable = new Map<unknown, unknown[]>([
    [schema.MarketplaceTable, [marketplaceRow]],
    [schema.PluginTable, [pluginRow]],
    [schema.MarketplacePluginTable, membershipRows],
    [schema.MarketplaceAccessGrantTable, [{
      createdAt: now,
      createdByOrgMembershipId,
      id: createDenTypeId("marketplaceAccessGrant"),
      marketplaceId: marketplaceRow.id,
      organizationId,
      orgMembershipId: null,
      orgWide: true,
      removedAt: null,
      role: "viewer",
      teamId: null,
    }]],
    [schema.PluginAccessGrantTable, [{
      createdAt: now,
      createdByOrgMembershipId,
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      orgMembershipId: null,
      orgWide: true,
      pluginId: pluginRow.id,
      removedAt: null,
      role: "viewer",
      teamId: null,
    }]],
  ])
}

beforeAll(async () => {
  seedRequiredEnv()

  // Capture original values eagerly: bun's mock.module rewrites live
  // bindings, so lazy namespace access would resolve to the mock itself.
  const realDbInstance = (await import("../src/db.js")).db
  mock.module("../src/db.js", () => ({
    db: scopedValue(mockScope, () => realDbInstance, dbStub as unknown as typeof realDbInstance),
  }))

  schema = await import("@openwork-ee/den-db/schema")
  presets = await import("../src/capability-sources/external-mcp-presets.js")
  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

beforeEach(() => {
  mockScope.active = true
  writes = []
})

afterEach(() => {
  mockScope.active = false
})

test("a fully seeded org lists marketplaces as a member with zero writes", async () => {
  seedRows({ seededDirectory: true })

  await storeModule.listMarketplaces({ context: memberContext() })

  expect(writes).toEqual([])
})

test("member-triggered seeding never writes personal access grants", async () => {
  seedRows({ seededDirectory: false })

  await storeModule.listMarketplaces({ context: memberContext() })

  const pluginGrantWrites = writes.filter((write) => write.table === schema.PluginAccessGrantTable)
  expect(pluginGrantWrites).toEqual([])

  const configGrantWrites = writes.filter((write) => write.table === schema.ConfigObjectAccessGrantTable)
  expect(configGrantWrites.length).toBeGreaterThan(0)
  for (const write of configGrantWrites) {
    expect(write.kind).toBe("insert")
    expect(write.values?.orgWide).toBe(true)
    expect(write.values?.role).toBe("viewer")
    expect(write.values?.orgMembershipId).toBeNull()
  }

  // Seeding actually ran and produced system-owned rows.
  const configObjectWrites = writes.filter((write) => write.table === schema.ConfigObjectTable && write.kind === "insert")
  expect(configObjectWrites.length).toBe(presets.EXTERNAL_MCP_PRESETS.length)
  const membershipWrites = writes.filter((write) => write.table === schema.PluginConfigObjectTable && write.kind === "insert")
  for (const write of membershipWrites) {
    expect(write.values?.membershipSource).toBe("system")
  }
})
