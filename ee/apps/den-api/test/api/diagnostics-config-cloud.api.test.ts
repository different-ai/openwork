import assert from "node:assert/strict"
import { after, test } from "node:test"
import { orgDiagnosticsSchema } from "@openwork/types/den/diagnostics"
import { bootDen, summary } from "./harness.js"

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "cloud",
  DEN_API_VERSION: "0.19.2",
  OPENWORK_HELM_CHART_VERSION: "0.2.0",
  OPENWORK_HELM_APP_VERSION: "0.19.1",
} })
after(() => den.close())

const platformAdmin = await den.signUp("Platform Administrator", `platform-admin+${den.stamp}@example.test`)
const workspace = await den.createOrg(platformAdmin, "Cloud workspace")
const customer = await den.createOrg(await den.signUp("Customer Owner"), "Customer workspace")

test("on OpenWork Cloud the installation is managed for everyone, platform administrators included, asked or not", async () => {
  for (const request of [den.as(workspace.owner, workspace.orgId), den.as(customer.owner, customer.orgId)]) {
    for (const [method, path] of [["GET", "/v1/org/diagnostics?include=config"], ["POST", "/v1/org/diagnostics/check?include=config"], ["GET", "/v1/org/diagnostics"]] as const) {
      const call = await request(method, path)
      assert.ok(call.status === 200 || call.status === 202 || call.status === 429, summary(call))
      const report = orgDiagnosticsSchema.parse(call.body)
      assert.equal(report.deployment, "cloud")
      assert.deepEqual(report.installation, { access: "managed" })
      assert.doesNotMatch(call.text, /lockedFeatures|helmChartVersion|helmAppVersion|versionSkew|deploymentCapabilities|0\.19\.1/)
    }
  }
})
