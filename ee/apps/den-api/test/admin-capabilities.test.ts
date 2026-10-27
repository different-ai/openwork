import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Hono } from "hono"
import { FEATURE_KEYS } from "@openwork/features"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { CapabilityRegistryContext, ExecuteCapabilityToolResult } from "../src/mcp/capability-registry.js"

// No database: every admin call below must be decided before a query runs.
// The modules' default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/admin_capabilities_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-admin-capabilities-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-admin-capabilities-unit-test-encryption-key"
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

const {
  buildCapabilityToolTree,
  CAPABILITY_SOURCES,
  createCapabilityRegistryContext,
  executeCapability,
  searchCapabilityRegistry,
} = await import("../src/mcp/capability-registry.js")

const noDatabase = () => {
  throw new Error("This test must not reach the database.")
}
mock.method(db, "select", noDatabase)
mock.method(db, "execute", noDatabase)

const organizationId = createDenTypeId("organization")

/** A verified platform admin's agent context whose token carries `scopes`. */
function adminContext(scopes: string[]): CapabilityRegistryContext {
  const context = createCapabilityRegistryContext({
    app: new Hono(),
    env: undefined,
    catalog: [],
    principal: { userId: createDenTypeId("user"), organizationId, scopes: new Set(scopes), payload: {} },
    organizationId,
    member: null,
    redirectUriBase: "http://unit.test",
    generatedArtifactViewsEnabled: false,
    organizationFeatures: {},
    usageSource: "agent",
  })
  return { ...context, resolvePlatformAdmin: async () => true }
}

function resultText(result: ExecuteCapabilityToolResult): string {
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

const feature = FEATURE_KEYS[0]

test("admin write tools refuse a token without mcp:write, as connection writes do", async () => {
  const context = adminContext(["mcp:read"])
  for (const [tool, args] of [
    ["den_update_org_plan", { organizationId: "org_unit", tier: "enterprise", seatLimit: 50 }],
    ["den_set_org_capability", { organizationId: "org_unit", capability: feature, enabled: true }],
    ["den_set_feature_rollout", { feature, killed: true }],
  ] as const) {
    const result = await executeCapability(context, { name: `admin:${tool}`, arguments: args })
    assert.equal(result.isError, true, tool)
    assert.deepEqual(JSON.parse(resultText(result)), {
      error: "insufficient_mcp_scope",
      requiredScope: "mcp:write",
      message: `${tool} requires the mcp:write scope.`,
    })
  }
})

test("admin read tools still run with mcp:read, and den_query refuses credential tables", async () => {
  const result = await executeCapability(adminContext(["mcp:read"]), {
    name: "admin:den_query",
    arguments: { sql: "SELECT s.token FROM `session` s" },
  })
  assert.equal(result.isError, true)
  assert.match(resultText(result), /den_query cannot read session: it holds credentials/)
})

test("Code Mode scripts get no admin tools, while search and full-view listing still find them", async () => {
  const context = adminContext(["mcp:read", "mcp:write"])
  const built = await buildCapabilityToolTree(context)
  assert.equal(built.tools.admin, undefined)
  assert.equal(built.manifest.some((entry) => entry.capabilityName.startsWith("admin:")), false)

  const leaves = await CAPABILITY_SOURCES.admin.enumerate(context)
  assert.ok(!("excluded" in leaves) && leaves.some((leaf) => leaf.capabilityName === "admin:den_query"))

  const { matches } = await searchCapabilityRegistry(context, { query: "den query sql", limit: 5, type: "admin" })
  const match = matches.find((candidate) => candidate.name === "admin:den_query")
  assert.ok(match)
  // A script path would point at a namespace scripts no longer have.
  assert.equal(match.scriptPath, undefined)
})
