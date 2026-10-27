import assert from "node:assert/strict"
import { test } from "node:test"
import { gatewayGroupAssignmentsComplete } from "../src/llm/gateway-model-assignments.js"

const catalogModelsById = new Map([
  ["row-a", { model_id: "model-a" }],
  ["row-b", { model_id: "model-b" }],
])
const healthy = {
  linkedModelIds: ["row-a"], catalogModelsById, allowedModelIds: [],
  representedModelIds: new Set(["row-a"]), hasTarget: true,
}

test("healthy and member-auth projections can represent complete assignments", () => {
  assert.equal(gatewayGroupAssignmentsComplete(healthy), true)
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, linkedModelIds: [], hasTarget: false }), true)
})

test("one healthy grant never masks a second grant's missing credential target", () => {
  assert.equal(gatewayGroupAssignmentsComplete(healthy), true)
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, hasTarget: false }), false)
})

test("missing catalog rows and filtered invalid model configs are incomplete", () => {
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, linkedModelIds: ["row-a", "missing-row"] }), false)
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, linkedModelIds: ["row-a", "row-b"] }), false)
})

test("explicit universe exclusions and removed links permit real removals", () => {
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, linkedModelIds: ["row-a", "row-b"], allowedModelIds: ["model-a"] }), true)
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, allowedModelIds: ["model-b"], representedModelIds: new Set(), hasTarget: false }), true)
  assert.equal(gatewayGroupAssignmentsComplete({ ...healthy, linkedModelIds: [], representedModelIds: new Set() }), true)
})
