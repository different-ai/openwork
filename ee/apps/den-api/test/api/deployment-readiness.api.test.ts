import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_GCP_VERSION: "", DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL: "", DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: "", DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256: "" } })
after(() => den.close())

const input = { provider: "gcp", name: "Readiness fixture", domainName: "openwork.example.test", ownerEmail: "owner@example.test", target: { projectId: "openwork-fixture", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-test" } }

test("a real parent rollout refusal is distinct from scoped permission denial and restores only after enabling", async () => {
  const org = await den.createOrg(await den.signUp("Parent Guard Owner"), "Parent guard fixture")
  const owner = den.as(org.owner, org.orgId)
  assert.equal((await den.setFeature(org.orgId, "managedDeployments", true)).status, 200)
  for (const path of ["/v1/managed-deployments", "/v1/managed-deployments/configuration"]) assert.equal((await owner("GET", path)).status, 200)
  assert.equal((await den.setFeature(org.orgId, "managedDeployments", false)).status, 200)
  for (const path of ["/v1/managed-deployments", "/v1/managed-deployments/configuration"]) {
    const blocked = await owner("GET", path)
    assert.equal(blocked.status, 404, summary(blocked))
    assert.deepEqual(blocked.body, { error: "feature_disabled", feature: "managedDeployments" })
  }
  const member = await den.newMember(org.owner, org.orgId, "Parent Guard Member")
  const denied = await den.as(member, org.orgId)("GET", "/v1/managed-deployments")
  assert.equal(denied.status, 403, summary(denied))
  assert.notEqual(field(denied.body, "error"), "feature_disabled", "permission guard runs before the rollout guard")
  assert.equal((await den.setFeature(org.orgId, "managedDeployments", true)).status, 200)
  for (const path of ["/v1/managed-deployments", "/v1/managed-deployments/configuration"]) assert.equal((await owner("GET", path)).status, 200)
})

test("disabled and unpublished GCP installs return actionable recovery without making deployment records", async () => {
  const org = await den.createOrg(await den.signUp("Deployment Owner"), "Readiness fixture")
  assert.equal((await den.setFeature(org.orgId, "managedDeployments", true)).status, 200)
  const owner = den.as(org.owner, org.orgId)
  const disabled = await owner("POST", "/v1/managed-deployments", input)
  assert.equal(disabled.status, 404, summary(disabled))
  assert.equal(field(disabled.body, "error"), "feature_disabled")
  assert.match(String(field(disabled.body, "message")), /Google Cloud.*OpenWork operator/)
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentsGcp", true)).status, 200)
  const unpublished = await owner("POST", "/v1/managed-deployments", input)
  assert.equal(unpublished.status, 503, summary(unpublished))
  assert.equal(field(unpublished.body, "error"), "release_not_configured")
  assert.match(String(field(unpublished.body, "message")), /publish and configure a verified installer release/)
  const configuration = await owner("GET", "/v1/managed-deployments/configuration")
  assert.equal(configuration.status, 200, summary(configuration))
  const gcp = list(field(configuration.body, "providers")).find((entry) => entry.provider === "gcp")
  assert.equal(gcp?.available, false)
  assert.equal(gcp?.message, field(unpublished.body, "message"))
  assert.doesNotMatch(configuration.text, /secret|password/)
  const deployments = await owner("GET", "/v1/managed-deployments")
  assert.equal(deployments.status, 200, summary(deployments))
  assert.deepEqual(field(deployments.body, "deployments"), [])
  const member = await den.newMember(org.owner, org.orgId, "Deployment Member")
  const forbidden = await den.as(member, org.orgId)("POST", "/v1/managed-deployments", input)
  assert.equal(forbidden.status, 403, summary(forbidden))

  assert.equal((await den.setFeature(org.orgId, "managedDeploymentsMcp", true)).status, 200)
  const token = await den.mintMcpToken(org.owner, org.orgId)
  const matches: Record<string, unknown>[] = []
  for (const query of ["managed deployments configuration clouds readiness", "create managed deployment installation target"]) {
    const search = await den.callMcpTool(token, "search_capabilities", { query, limit: 20 })
    assert.equal(search.isError, false, search.raw.slice(0, 400))
    matches.push(...list(field(search.body, "matches")))
  }
  const readName = matches.find((entry) => typeof entry.name === "string" && /^getManagedDeploymentsConfiguration$/i.test(entry.name))?.name
  const createName = matches.find((entry) => typeof entry.name === "string" && /^postManagedDeployments$/i.test(entry.name))?.name
  assert.equal(typeof readName, "string", `readiness capability missing: ${matches.map((entry) => entry.name).join(", ")}`)
  assert.equal(typeof createName, "string", "create capability missing")
  if (typeof readName !== "string" || typeof createName !== "string") throw new Error("Missing discovered deployment capabilities")
  const mcpReadiness = await den.callMcpTool(token, "execute_capability", { name: readName })
  assert.equal(mcpReadiness.isError, false, mcpReadiness.raw.slice(0, 400))
  const mcpGcp = list(field(mcpReadiness.body, "providers")).find((entry) => entry.provider === "gcp")
  assert.equal(mcpGcp?.message, gcp?.message, "MCP and the page receive the same operator action")
  const mcpCreate = await den.callMcpTool(token, "execute_capability", { name: createName, body: input })
  assert.equal(mcpCreate.isError, true)
  assert.equal(field(mcpCreate.body, "error"), "release_not_configured")
  assert.equal(field(mcpCreate.body, "message"), field(unpublished.body, "message"))
  const memberToken = await den.mintMcpToken(member, org.orgId)
  const memberRead = await den.callMcpTool(memberToken, "execute_capability", { name: readName })
  assert.equal(memberRead.isError, true, "MCP never bypasses deployment permissions")
  assert.equal(field(memberRead.body, "providers"), undefined)
  assert.deepEqual(field((await owner("GET", "/v1/managed-deployments")).body, "deployments"), [])
})
