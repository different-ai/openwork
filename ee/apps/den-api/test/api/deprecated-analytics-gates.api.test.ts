import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("deprecated analytics surfaces stay off while Models settings and consent-respecting runtime reporting remain available", async () => {
  const org = await den.createOrg(await den.signUp("Analytics Owner"), "Analytics gates")
  const owner = den.as(org.owner, org.orgId)
  const context = await owner("GET", "/v1/org")
  assert.equal(context.status, 200, summary(context))
  assert.equal(field(context.body, "features", "modelsAnalyticsUi"), false)
  assert.equal(field(context.body, "features", "taskAnalyticsUi"), false)
  for (const path of ["/v1/inference/analytics/usage", "/v1/inference/analytics/settings", "/v1/inference/analytics/activity", "/v1/inference/analytics/consumption"]) {
    const response = await owner("GET", path)
    assert.equal(response.status, 404, `${path}: ${summary(response)}`)
    assert.equal(field(response.body, "error"), "feature_disabled")
  }
  const choice = await owner("PATCH", "/v1/inference/analytics/settings", { enabled: true, consentVersion: 1 })
  assert.equal(choice.status, 404, summary(choice))
  const models = await owner("GET", "/v1/inference")
  assert.equal(models.status, 200, summary(models))
  const runtime = await owner("POST", "/v1/inference/analytics/events", {
    events: [{ id: "unconsented-event", type: "task.started", timestamp: new Date().toISOString(), taskId: "fixture-task", sessionId: "fixture-session" }],
  })
  assert.equal(runtime.status, 204, summary(runtime))
  assert.equal(runtime.text, "", "hidden dashboards never manufacture consent or usage")
  const unchanged = await owner("GET", "/v1/org")
  assert.equal(field(unchanged.body, "features", "modelsAnalyticsUi"), false)
  assert.equal(field(unchanged.body, "features", "taskAnalyticsUi"), false)
})
