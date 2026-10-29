import assert from "node:assert/strict"
import { test } from "node:test"
import { AGENT_CONNECTION_REMOVAL_PATH, catalogOperationAvailableToCapabilities } from "../src/mcp/catalog-availability.ts"

const removal = { method: "POST", path: AGENT_CONNECTION_REMOVAL_PATH }
const base = { generatedArtifactViewsEnabled: true, managedDeploymentsEnabled: false }

test("connection removal is offered only to a person's own agent", () => {
  assert.equal(catalogOperationAvailableToCapabilities({ ...base, usageSource: "agent" }, removal), true)
  for (const usageSource of ["workflow", "automation", "app", "artifact", undefined]) {
    assert.equal(catalogOperationAvailableToCapabilities({ ...base, usageSource }, removal), false, String(usageSource))
  }
  // Other connection operations are unaffected.
  assert.equal(catalogOperationAvailableToCapabilities(base, { method: "GET", path: "/v1/mcp-connections" }), true)
})
