import assert from "node:assert/strict"
import { after, test } from "node:test"
import { cloudCodingOverviewSchema } from "@openwork/types/den/cloud-coding"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", GITHUB_CLOUD_CODING_APP_ID: "" } })
after(() => den.close())

test("Cloud coding is off by default and cannot connect without a GitHub App", async () => {
  const org = await den.createOrg(await den.signUp("Maya Chen", "maya@acme.dev"), "Acme Corp")
  const call = den.as(org.owner, org.orgId)
  const root = "/v1/cloud-coding"
  const routes = [
    ["GET", ""], ["PUT", "/settings"], ["POST", "/github/install/start"], ["GET", "/github/installations"],
    ["POST", "/github/install/complete"], ["POST", "/github/sync"], ["POST", "/github/link/start"],
    ["DELETE", "/github/link"], ["POST", `/people/${org.owner.memberId}/send-link`], ["POST", "/admin-requests"],
  ] as const
  for (const [method, path] of routes) {
    const result = await call(method, root + path, method === "POST" || method === "PUT" ? {} : undefined)
    assert.equal(result.status, 404, summary(result))
    assert.equal(field(result.body, "error"), "feature_disabled")
  }
  assert.equal((await den.setFeature(org.orgId, "cloudCoding", true)).status, 200)
  const result = await call("GET", root)
  assert.equal(result.status, 200, summary(result))
  const overview = cloudCodingOverviewSchema.parse(result.body)
  assert.equal(overview.configured, false)
  assert.equal(overview.connection, null)
  assert.deepEqual([overview.people, overview.repositories, overview.pullRequests], [[], [], []])
  const start = await call("POST", `${root}/github/install/start`, {})
  assert.equal(start.status, 409, summary(start))
  assert.equal(field(start.body, "error"), "cloud_coding_not_configured")
})
