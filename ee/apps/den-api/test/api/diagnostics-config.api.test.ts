import assert from "node:assert/strict"
import { after, test } from "node:test"
import { FEATURE_KEYS, featureAvailableOn, featureLockEnvName } from "@openwork/features"
import { CUSTOMER_CAPABILITY_IDS } from "@openwork/managed-deployments/capabilities"
import { orgDiagnosticsSchema } from "@openwork/types/den/diagnostics"
import { bootDen, field, isRecord, summary, type Call } from "./harness.js"

const lockedOn = FEATURE_KEYS.find((key) => featureAvailableOn(key, "self_hosted"))
assert.ok(lockedOn, "the registry has a feature a self-hosted install can lock")

const SECRETS = {
  DEN_MAINTENANCE_TOKEN: "diagnostics-test-maintenance-token-0123456789",
  DEN_GATEWAY_KEY: "diagnostics-test-gateway-key-0123456789abcdef",
  DEN_HEADLESS_RUNNER_TOKEN: "diagnostics-test-runner-token-0123456789abcdef",
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: "diagnostics-test-bootstrap-code-0123",
}

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  DEN_API_VERSION: "0.19.2",
  OPENWORK_HELM_CHART_VERSION: "0.2.0",
  OPENWORK_HELM_APP_VERSION: "0.19.1",
  [featureLockEnvName(lockedOn)]: "true",
  DEN_HEADLESS_RUNNER_URL: "http://headless-runner:8795",
  ...SECRETS,
} })
after(() => den.close())

const operator = await den.signUp("Installation Administrator", `platform-admin+${den.stamp}@example.test`)
const install = await den.createOrg(operator, "Self-hosted workspace")
const asOperator = den.as(install.owner, install.orgId)
const admin = await den.newMember(install.owner, install.orgId, "Organization Admin", "admin")
const member = await den.newMember(install.owner, install.orgId, "Workspace Member")
const elsewhere = await den.createOrg(await den.signUp("Other Owner"), "Other workspace")

function installation(call: Call) {
  assert.ok([200, 202, 429, 503].includes(call.status), summary(call))
  const report = orgDiagnosticsSchema.parse(call.body)
  return { report, installation: report.installation, raw: field(call.body, "installation") }
}

test("without include=config the installation section is exactly what older Den Web builds accept", async () => {
  const { installation: section, raw } = installation(await asOperator("GET", "/v1/org/diagnostics"))
  assert.equal(section.access, "operator")
  assert.ok(isRecord(raw))
  assert.deepEqual(Object.keys(raw).sort(), ["access", "server", "services"])
})

test("an installation administrator who asks gets versions, skew, capability states and locks", async () => {
  const { installation: section } = installation(await asOperator("GET", "/v1/org/diagnostics?include=config"))
  assert.equal(section.access, "operator")
  assert.ok(section.access === "operator" && section.config)
  assert.deepEqual(section.config, {
    appVersion: "0.19.2",
    helmChartVersion: "0.2.0",
    helmAppVersion: "0.19.1",
    versionSkew: true,
    deploymentCapabilities: section.config.deploymentCapabilities,
    lockedFeatures: { [lockedOn]: true },
  })
  assert.deepEqual(section.config.deploymentCapabilities.map((entry) => entry.id), [...CUSTOMER_CAPABILITY_IDS])
  const states = Object.fromEntries(section.config.deploymentCapabilities.map((entry) => [entry.id, `${entry.state}:${entry.reason}`]))
  assert.equal(states.automations, "on:configured")
  assert.equal(states.aiGateway, "needs_infrastructure:service_not_installed")
  assert.equal(states.workbot, "needs_infrastructure:service_not_installed")
})

test("version skew is listed under what needs attention only for a caller who asked for the configuration", async () => {
  const asked = installation(await asOperator("GET", "/v1/org/diagnostics?include=config")).report.attention
  assert.deepEqual(asked.filter((item) => item.code === "installation_version_skew"), [
    { section: "installation", targetId: "config", severity: "warning", code: "installation_version_skew", subject: "OpenWork server", count: null, detail: "0.19.1" },
  ])
  const plain = installation(await asOperator("GET", "/v1/org/diagnostics")).report.attention
  assert.equal(plain.some((item) => item.code === "installation_version_skew"), false)
  const strict = await asOperator("GET", "/v1/org/diagnostics?include=config&strict=1")
  const strictAttention = orgDiagnosticsSchema.parse(strict.body).attention
  assert.ok(strictAttention.some((item) => item.code === "installation_version_skew"))
  assert.equal(strict.status === 503, strictAttention.some((item) => item.severity === "error"), "a version mismatch is a warning and never fails a strict read by itself")
})

test("the configuration carries no secret, address, email or setting value", async () => {
  const call = await asOperator("GET", "/v1/org/diagnostics?include=config")
  const { installation: section } = installation(call)
  assert.ok(section.access === "operator" && section.config)
  const config = JSON.stringify(section.config)
  assert.doesNotMatch(config, /https?:|mysql:|redis|@|smtp|example\.test|password|token|secret/i)
  const whole = call.text
  for (const name of ["BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DATABASE_URL", ...Object.keys(SECRETS)]) {
    const value = process.env[name]
    assert.ok(value && value.length >= 16, `${name} is set for this test`)
    assert.equal(whole.includes(value), false, `${name} leaked into diagnostics`)
  }
  assert.equal(whole.includes(operator.email), false, "the administrator's email is not in diagnostics")
})

test("starting a check keeps the configuration in the answer for the same administrator", async () => {
  const { installation: section } = installation(await asOperator("POST", "/v1/org/diagnostics/check?include=config"))
  assert.ok(section.access === "operator" && section.config?.versionSkew === true)
  const plain = installation(await asOperator("POST", "/v1/org/diagnostics/check"))
  assert.ok(plain.installation.access === "operator" && plain.installation.config === undefined)
})

test("an organization admin, a member and another organization's owner never get it, asked or not", async () => {
  for (const request of [den.as(admin, install.orgId), den.as(member, install.orgId), den.as(elsewhere.owner, elsewhere.orgId)]) {
    for (const path of ["/v1/org/diagnostics?include=config", "/v1/org/diagnostics/check?include=config"]) {
      const call = await request(path.includes("/check") ? "POST" : "GET", path)
      const { installation: section } = installation(call)
      assert.deepEqual(section, { access: "locked", reason: "installation_admin_required" })
      assert.doesNotMatch(call.text, /lockedFeatures|helmChartVersion|versionSkew|deploymentCapabilities/)
    }
  }
})

test("an unknown include value is refused instead of ignored", async () => {
  assert.equal((await asOperator("GET", "/v1/org/diagnostics?include=environment")).status, 400)
  assert.equal((await asOperator("POST", "/v1/org/diagnostics/check?include=environment")).status, 400)
})
