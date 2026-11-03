import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "self_hosted" } })
after(() => den.close())
const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)

test("graduating sandbox rollout does not expose sandboxes on self-hosted deployments", async () => {
  const listed = await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")
  assert.equal(listed.status, 200, summary(listed))
  assert.deepEqual(listed.body, { enabled: false, sandboxes: [] })
  const created = await den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", {
    body: { name: "Unavailable sandbox", connectorBaseUrl: null, days: 1, memberLimit: 1, allowedEmailDomains: [] },
  })
  assert.equal(created.status, 404, summary(created))
  assert.equal(field(created.body, "error"), "not_found")
  for (const action of ["rotate-link", "join-role", "extend", "credit", "close"]) {
    const result = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/example/${action}`, {
      body: action === "join-role" ? { joinRole: "member" } : action === "extend" ? { days: 1 } : action === "credit" ? { creditUsd: 1 } : {},
    })
    assert.equal(result.status, 404, summary(result))
    assert.equal(field(result.body, "error"), "not_found")
  }
  const preview = await den.request(null, "GET", "/v1/sandbox-join/preview?token=example")
  assert.equal(preview.status, 404, summary(preview))
  assert.equal(field(preview.body, "error"), "sandbox_not_found")
  const joined = await den.request(admin.token, "POST", "/v1/sandbox-join", { body: { token: "example" } })
  assert.equal(joined.status, 404, summary(joined))
  assert.equal(field(joined.body, "error"), "sandbox_not_found")
})
