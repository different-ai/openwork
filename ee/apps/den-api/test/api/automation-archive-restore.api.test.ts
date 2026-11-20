import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AUTOMATION_FREE_MODEL, automationDetailSchema, automationListSchema } from "@openwork/types/automations"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("restoring an archived Automation leaves it paused and preserves its runs", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Archive Owner"), "Automation archive tests")
  const request = den.as(owner, orgId)
  const created = await request("POST", "/v1/automations", {
    name: "Draft reminder",
    instructions: "Review the draft.",
    schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    model: AUTOMATION_FREE_MODEL,
  })
  assert.equal(created.status, 201, summary(created))
  const { automation, revision } = automationDetailSchema.parse(created.body)
  const path = `/v1/automations/${automation.id}`
  const queued = await request("POST", `${path}/run`, {})
  assert.equal(queued.status, 202, summary(queued))
  const runId = field(queued.body, "run", "id")
  assert.equal(typeof runId, "string")
  const cancelled = await request("POST", `/v1/automation-runs/${runId}/cancel`)
  assert.equal(cancelled.status, 200, summary(cancelled))
  const history = await request("GET", `${path}/runs`)
  assert.equal(history.status, 200, summary(history))
  assert.deepEqual(list(field(history.body, "items")).map((run) => run.id), [runId])

  const archived = await request("DELETE", path)
  assert.equal(archived.status, 200, summary(archived))
  assert.ok(automationDetailSchema.parse(archived.body).automation.archivedAt)
  const listed = await request("GET", "/v1/automations")
  assert.equal(listed.status, 200, summary(listed))
  assert.equal(automationListSchema.parse(listed.body).items.find((item) => item.automation.id === automation.id)?.automation.state, "archived")

  const restored = await request("POST", `${path}/deactivate`)
  assert.equal(restored.status, 200, summary(restored))
  const detail = automationDetailSchema.parse(restored.body)
  assert.equal(detail.automation.id, automation.id)
  assert.equal(detail.revision.id, revision.id)
  assert.equal(detail.automation.state, "inactive")
  assert.equal(detail.automation.archivedAt, null)
  assert.equal(detail.automation.nextDueAt, null)
  const restoredHistory = await request("GET", `${path}/runs`)
  assert.equal(restoredHistory.status, 200, summary(restoredHistory))
  assert.deepEqual(restoredHistory.body, history.body)
})
