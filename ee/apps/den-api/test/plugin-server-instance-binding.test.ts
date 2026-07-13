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

// A connection's binding row records which plugin governs the configured
// instance. Import-reuse from a second plugin must not steal it: the first
// plugin's marketplace item would silently lose its configured instance.
let selectRows: unknown[]
let writes: Array<{ kind: "insert" | "update"; values: Record<string, unknown> }>

function queryChain() {
  const proxy: any = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (onfulfilled?: (value: unknown[]) => unknown, onrejected?: (reason: unknown) => unknown) =>
          Promise.resolve(selectRows).then(onfulfilled, onrejected)
      }
      return () => proxy
    },
  })
  return proxy
}

const dbStub = {
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      writes.push({ kind: "insert", values })
      return Promise.resolve()
    },
  }),
  select: () => queryChain(),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      writes.push({ kind: "update", values })
      return { where: () => Promise.resolve() }
    },
  }),
}

function actorContext(): PluginArchActorContext {
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

beforeAll(async () => {
  seedRequiredEnv()
  // Capture original values eagerly: bun's mock.module rewrites live
  // bindings, so lazy namespace access would resolve to the mock itself.
  const realDbInstance = (await import("../src/db.js")).db
  mock.module("../src/db.js", () => ({
    db: scopedValue(mockScope, () => realDbInstance, dbStub as unknown as typeof realDbInstance),
  }))
  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

beforeEach(() => {
  mockScope.active = true
  selectRows = []
  writes = []
})

afterEach(() => {
  mockScope.active = false
})

function existingBinding(pluginId: string) {
  return {
    configObjectId: createDenTypeId("configObject"),
    createdAt: new Date(),
    createdByOrgMembershipId: createDenTypeId("member"),
    externalMcpConnectionId: createDenTypeId("externalMcpConnection"),
    id: createDenTypeId("pluginMcpServerInstance"),
    instanceLabel: "Original",
    organizationId: createDenTypeId("organization"),
    pluginId,
    serverKey: "original-server",
  }
}

test("a binding owned by another plugin is returned untouched", async () => {
  const originalPluginId = createDenTypeId("plugin")
  const existing = existingBinding(originalPluginId)
  selectRows = [existing]

  const result = await storeModule.ensurePluginMcpServerInstance({
    configObjectId: createDenTypeId("configObject"),
    connectionId: existing.externalMcpConnectionId,
    context: actorContext(),
    instanceLabel: "Thief",
    pluginId: createDenTypeId("plugin"),
    serverKey: "thief-server",
  })

  expect(writes).toEqual([])
  expect(result.pluginId).toBe(originalPluginId)
  expect(result.serverKey).toBe("original-server")
  expect(result.instanceLabel).toBe("Original")
})

test("a same-plugin re-import updates label, server key, and config object in place", async () => {
  const pluginId = createDenTypeId("plugin")
  const existing = existingBinding(pluginId)
  selectRows = [existing]
  const nextConfigObjectId = createDenTypeId("configObject")

  const result = await storeModule.ensurePluginMcpServerInstance({
    configObjectId: nextConfigObjectId,
    connectionId: existing.externalMcpConnectionId,
    context: actorContext(),
    instanceLabel: "Renamed",
    pluginId,
    serverKey: "renamed-server",
  })

  expect(writes).toEqual([{
    kind: "update",
    values: {
      configObjectId: nextConfigObjectId,
      instanceLabel: "Renamed",
      serverKey: "renamed-server",
    },
  }])
  expect(result.id).toBe(existing.id)
  expect(result.pluginId).toBe(pluginId)
  expect(result.serverKey).toBe("renamed-server")
})

test("an unbound connection gets a fresh binding row", async () => {
  const pluginId = createDenTypeId("plugin")
  const connectionId = createDenTypeId("externalMcpConnection")

  const result = await storeModule.ensurePluginMcpServerInstance({
    configObjectId: null,
    connectionId,
    context: actorContext(),
    instanceLabel: null,
    pluginId,
    serverKey: "fresh-server",
  })

  expect(writes.length).toBe(1)
  expect(writes[0].kind).toBe("insert")
  expect(writes[0].values.pluginId).toBe(pluginId)
  expect(writes[0].values.externalMcpConnectionId).toBe(connectionId)
  expect(result.pluginId).toBe(pluginId)
  expect(result.serverKey).toBe("fresh-server")
})
