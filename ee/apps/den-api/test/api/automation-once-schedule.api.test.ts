import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, AUTOMATION_FREE_MODEL, automationDetailSchema } from "@openwork/types/automations"
import { bootDen, summary } from "./harness.js"

// Creation checks configuration, but does not contact the runner.
const den = await bootDen({ env: { DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) } })
after(() => den.close())

for (const placement of ["desktop", "cloud"]) test(`${placement} one-off saves reject times outside the clock-skew grace period`, async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Schedule Owner"), "Schedule tests")
  const request = den.as(owner, orgId)
  const schedule = (at: number) => ({ kind: "once", at, timezone: "UTC" })
  const instructions = "Review the draft."
  const definition = {
    name: "One-off reminder",
    ...(placement === "cloud"
      ? { action: { kind: "agent", instructions, model: AUTOMATION_CLOUD_DEFAULT_MODEL } }
      : { instructions, model: AUTOMATION_FREE_MODEL }),
  }
  const collection = placement === "cloud" ? "/v1/cloud-automations" : "/v1/automations"
  const expired = schedule(Date.now() - 120_000)
  const rejectedCreate = await request("POST", collection, { ...definition, schedule: expired })
  const expectedError = { error: "automation_once_time_in_past", message: "That time has already passed. Choose a future time for this Automation." }
  assert.equal(rejectedCreate.status, 400, summary(rejectedCreate))
  assert.deepEqual(rejectedCreate.body, expectedError)

  const future = schedule(Date.now() + 300_000)
  const created = await request("POST", collection, { ...definition, schedule: future })
  assert.equal(created.status, 201, summary(created))
  const original = automationDetailSchema.parse(created.body)
  const path = `/v1/automations/${original.automation.id}`
  assert.equal(original.automation.nextDueAt, future.at)
  const rejectedUpdate = await request("PATCH", path, { schedule: expired })
  assert.equal(rejectedUpdate.status, 400, summary(rejectedUpdate))
  assert.deepEqual(rejectedUpdate.body, expectedError)
  assert.deepEqual((await request("GET", path)).body, created.body)

  const withinGrace = schedule(Date.now() - 5_000)
  const updated = await request("PATCH", path, { schedule: withinGrace })
  assert.equal(updated.status, 200, summary(updated))
  assert.equal(automationDetailSchema.parse(updated.body).automation.nextDueAt, withinGrace.at)
  const graceCreate = await request("POST", collection, { ...definition, schedule: withinGrace })
  assert.equal(graceCreate.status, 201, summary(graceCreate))
  assert.equal(automationDetailSchema.parse(graceCreate.body).automation.nextDueAt, withinGrace.at)
})
