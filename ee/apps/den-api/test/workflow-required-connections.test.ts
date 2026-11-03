import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { CapabilityRegistryContext, CapabilitySource, CapabilitySourceKind } from "../src/mcp/capability-registry.js"
import type { RequiredCapability } from "../src/mcp/codemode-tools.js"

// No database or network: the registry's sources are faked below. Its modules'
// default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/workflow_required_connections_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-workflow-required-connections-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-workflow-required-connections-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db.$primary, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policy: null }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()

const { CAPABILITY_SOURCE_KINDS, createCapabilityRegistry } = await import("../src/mcp/capability-registry.js")
const { connectionsRequiredBy } = await import("../src/mcp/codemode-tools.js")
const { executeWorkflow } = await import("../src/mcp/workflow-service.js")

const connections = [{ id: "emc_used" }, { id: "emc_also_used" }, { id: "emc_unrelated" }]

test("a Workflow lists only the connections its capabilities name", () => {
  assert.deepEqual(connectionsRequiredBy(connections, [
    { capabilityName: "mcp:emc_used:execute" },
    { capabilityName: "mcp:emc_used:search" },
    { capabilityName: "mcp:emc_also_used:whoami" },
  ]), [{ id: "emc_used" }, { id: "emc_also_used" }])
})

test("a Workflow that names no connection lists none", () => {
  assert.deepEqual(connectionsRequiredBy(connections, []), [])
  assert.deepEqual(connectionsRequiredBy(connections, [{ capabilityName: "getWorkers" }]), [])
})

test("without required capabilities every connection is listed, as saving a Workflow needs", () => {
  assert.deepEqual(connectionsRequiredBy(connections, undefined), connections)
})

test("the registry passes a Workflow's capabilities to every source and nothing otherwise", async () => {
  const seen: Array<readonly RequiredCapability[] | undefined> = []
  const fake = (kind: CapabilitySourceKind): CapabilitySource => ({
    kind,
    parseName: () => null,
    search: async () => [],
    enumerate: async (_ctx, required) => {
      seen.push(required)
      return []
    },
    execute: async () => ({ content: [] }),
  })
  const registry = createCapabilityRegistry(Object.fromEntries(CAPABILITY_SOURCE_KINDS.map((kind) => [kind, fake(kind)])) as Record<CapabilitySourceKind, CapabilitySource>)
  const context = {} as CapabilityRegistryContext

  const required = [{ capabilityName: "mcp:emc_used:execute" }]
  await registry.buildToolTree(context, required)
  assert.ok(seen.length > 0)
  assert.ok(seen.every((entry) => entry === required))

  seen.length = 0
  await registry.buildToolTree(context)
  assert.ok(seen.length > 0)
  assert.ok(seen.every((entry) => entry === undefined))
})

test("running a Workflow builds tools for exactly the capabilities it declared", async () => {
  const requiredCapabilities = [{ capabilityName: "mcp:emc_used:execute", scriptPath: "tools.used.execute" }]
  const built: unknown[][] = []
  const result = await executeWorkflow({
    database: { insert: () => ({ values: async () => undefined }) } as never,
    organizationId: createDenTypeId("organization"),
    orgMembershipId: createDenTypeId("member"),
    pluginId: createDenTypeId("plugin"),
    configObjectId: createDenTypeId("configObject"),
    normalizedPayloadJson: { language: "codemode-js", requiredCapabilities },
    code: "return 1",
    buildTools: async (...args) => {
      built.push(args)
      return { tools: {}, manifest: [] }
    },
  })
  assert.deepEqual(built, [[requiredCapabilities]])
  // A capability its connection no longer offers still stops the run before any code does.
  assert.equal(result.ok, false)
  assert.equal("error" in result && result.error, "capability_unavailable")
})
