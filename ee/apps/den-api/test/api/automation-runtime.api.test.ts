import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationRevisionDigest } from "@openwork/automations"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, AUTOMATION_FREE_MODEL, automationDetailSchema, automationRunReceiptSchema, automationRunSchema } from "@openwork/types/automations"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) } })
after(() => den.close())

const { orgId, owner } = await den.createOrg(await den.signUp("Runtime Owner"), "Runtime fixture")
const other = await den.newMember(owner, orgId, "Other Owner")
const request = den.as(owner, orgId)
const schedule = { kind: "once", at: Date.now() + 86_400_000, timezone: "UTC" }
const created = await request("POST", "/v1/cloud-automations", {
  name: "Prepare a report", schedule,
  action: { kind: "agent", instructions: "Prepare the report.", model: AUTOMATION_CLOUD_DEFAULT_MODEL },
})
assert.equal(created.status, 201, summary(created))
const original = automationDetailSchema.parse(created.body)
const path = `/v1/automations/${original.automation.id}`
let originalRunId = ""

async function runReport() {
  const started = await request("POST", `${path}/run`, {})
  assert.equal(started.status, 202, summary(started))
  const run = automationRunSchema.parse(field(started.body, "run"))
  const cancelled = await request("POST", `/v1/automation-runs/${run.id}/cancel`, {})
  assert.equal(cancelled.status, 200, summary(cancelled))
  const read = await request("GET", `/v1/automation-runs/${run.id}`)
  assert.equal(read.status, 200, summary(read))
  return automationRunReceiptSchema.parse(read.body)
}

test("the default and existing revision stay at 15 minutes while the setting is off", async () => {
  assert.equal(original.revision.maximumRuntimeMs, 900_000)
  const denied = await request("PATCH", path, { maximumRuntimeMs: 3_600_000 })
  assert.equal(denied.status, 404, summary(denied))
  assert.deepEqual(denied.body, { error: "feature_disabled", feature: "automationHourRuntime" })
  assert.deepEqual((await request("GET", path)).body, created.body)
  const receipt = await runReport()
  originalRunId = receipt.run.id
  assert.equal(receipt.revision.maximumRuntimeMs, 900_000)
})

test("an owner explicitly saves a one-hour revision without changing the original or other owners' access", async () => {
  assert.equal((await den.setFeature(orgId, "automationHourRuntime", true)).status, 200)
  const foreign = await den.as(other, orgId)("PATCH", path, { maximumRuntimeMs: 3_600_000 })
  assert.equal(foreign.status, 404, summary(foreign))
  const updated = await request("PATCH", path, { maximumRuntimeMs: 3_600_000 })
  assert.equal(updated.status, 200, summary(updated))
  const current = automationDetailSchema.parse(updated.body)
  assert.equal(current.revision.maximumRuntimeMs, 3_600_000)
  assert.equal(current.revision.version, original.revision.version + 1)
  assert.notEqual(current.revision.id, original.revision.id)
  assert.notEqual(current.revision.digest, original.revision.digest)
  assert.equal(current.revision.action?.kind, "agent")
  if (current.revision.action?.kind !== "agent") throw new Error("Expected an agent revision")
  assert.equal(current.revision.digest, automationRevisionDigest({
    instructions: current.revision.instructions, schedule: current.revision.schedule,
    model: current.revision.action.model, action: current.revision.action, executionTarget: "cloud", maximumRuntimeMs: 3_600_000,
  }))
  const same = await request("PATCH", path, { maximumRuntimeMs: 3_600_000 })
  assert.equal(automationDetailSchema.parse(same.body).revision.id, current.revision.id)
  assert.deepEqual((await request("GET", path)).body, same.body)
  const receipt = await runReport()
  assert.equal(receipt.revision.maximumRuntimeMs, 3_600_000)
  const historical = await request("GET", `/v1/automation-runs/${originalRunId}`)
  const pinned = automationRunReceiptSchema.parse(historical.body)
  assert.equal(pinned.revision.id, original.revision.id)
  assert.equal(pinned.revision.maximumRuntimeMs, 900_000, "historical runs keep their original deadline")
})

test("the locked writer rechecks runtime and placement after a stale preflight in either update order", async () => {
  const { automationRepository } = await import("../../src/automations/repository.js")
  const before = await request("GET", path)
  await assert.rejects(automationRepository.update({
    organizationId: orgId, ownerMemberId: owner.memberId, automationId: original.automation.id,
    changes: { executionTarget: "desktop" }, now: Date.now(),
  }), /automation_runtime_cloud_agent_only/)
  assert.deepEqual((await request("GET", path)).body, before.body)
  const createdDesktop = await request("POST", "/v1/automations", {
    name: "Concurrent placement fixture", schedule, instructions: "Prepare a report.", model: AUTOMATION_FREE_MODEL,
  })
  assert.equal(createdDesktop.status, 201, summary(createdDesktop))
  const desktop = automationDetailSchema.parse(createdDesktop.body)
  await assert.rejects(automationRepository.update({
    organizationId: orgId, ownerMemberId: owner.memberId, automationId: desktop.automation.id,
    changes: { maximumRuntimeMs: 3_600_000 }, now: Date.now(),
  }), /automation_runtime_cloud_agent_only/)
  assert.deepEqual((await request("GET", `/v1/automations/${desktop.automation.id}`)).body, createdDesktop.body)
})

test("limits outside 10 seconds through 60 minutes are rejected without changing the revision", async () => {
  const before = await request("GET", path)
  for (const maximumRuntimeMs of [9_999, 3_600_001, 3_600_000.5, null, "3600000"]) {
    const rejected = await request("PATCH", path, { maximumRuntimeMs })
    assert.equal(rejected.status, 400, summary(rejected))
  }
  assert.deepEqual((await request("GET", path)).body, before.body)
})

test("the setting does not imply a longer desktop or saved Workflow timeout", async () => {
  const desktop = await request("POST", "/v1/automations", {
    name: "Local report", schedule, instructions: "Prepare a local report.", model: AUTOMATION_FREE_MODEL,
  })
  assert.equal(desktop.status, 201, summary(desktop))
  const id = automationDetailSchema.parse(desktop.body).automation.id
  const rejected = await request("PATCH", `/v1/automations/${id}`, { maximumRuntimeMs: 3_600_000 })
  assert.equal(rejected.status, 400, summary(rejected))
  assert.deepEqual(rejected.body, { error: "automation_runtime_cloud_agent_only" })
  const workflow = await request("PATCH", path, { maximumRuntimeMs: 3_600_000, action: {
    kind: "saved_script", script: { pluginId: "plg_00000000000000000000000000", configObjectId: "cob_00000000000000000000000000", configObjectVersionId: "cov_00000000000000000000000000" }, input: {},
  } })
  assert.equal(workflow.status, 400, summary(workflow))
  assert.deepEqual(workflow.body, { error: "automation_runtime_cloud_agent_only" })
})

test("turning off the setting preserves saved limits and ordinary edits; lowering the limit is explicit", async () => {
  assert.equal((await den.setFeature(orgId, "automationHourRuntime", false)).status, 200)
  const renamed = await request("PATCH", path, { name: "Renamed report" })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(automationDetailSchema.parse(renamed.body).revision.maximumRuntimeMs, 3_600_000)
  const beforeMove = await request("GET", path)
  for (const action of [
    { method: "PATCH", path, body: { executionTarget: "desktop" } },
    { method: "POST", path: `${path}/run`, body: { executionTarget: "desktop" } },
    { method: "PATCH", path, body: { action: { kind: "saved_script", script: {
      pluginId: "plg_00000000000000000000000000", configObjectId: "cob_00000000000000000000000000", configObjectVersionId: "cov_00000000000000000000000000",
    }, input: {} } } },
  ] as const) {
    const refusedMove = await request(action.method, action.path, action.body)
    assert.equal(refusedMove.status, 400, summary(refusedMove))
    assert.deepEqual(refusedMove.body, { error: "automation_runtime_cloud_agent_only" })
  }
  assert.deepEqual((await request("GET", path)).body, beforeMove.body)
  const refused = await request("PATCH", path, { maximumRuntimeMs: 900_000 })
  assert.equal(refused.status, 404, summary(refused))
  assert.equal((await den.setFeature(orgId, "automationHourRuntime", true)).status, 200)
  const lowered = await request("PATCH", path, { maximumRuntimeMs: 900_000 })
  assert.equal(lowered.status, 200, summary(lowered))
  assert.equal(automationDetailSchema.parse(lowered.body).revision.maximumRuntimeMs, 900_000)
})
