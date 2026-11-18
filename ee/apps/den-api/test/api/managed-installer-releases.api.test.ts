import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { ManagedInstallerChangeTable, ManagedInstallerConfigTable, ManagedInstallerValidationTable } from "@openwork-ee/den-db/schema"
import { managedInstallerReportSchema } from "@openwork/types/den/managed-installer-releases"
import { bootDen, field, text, summary } from "./harness.js"
import { fixtureArtifacts, fixtureFetch, source } from "./managed-installer-fixtures.js"
import { verifyInstallerRelease } from "../../src/managed-deployments/release-verifier.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "1.2.2", DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: `${source}1.2.2/cloudformation.json?versionId=old`, DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: `${source}1.2.2/bundle.tar.gz?versionId=old`, DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "b".repeat(64) } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const releases = await import("../../src/managed-deployments/releases.js")
const org = await den.createOrg(await den.signUp("Release owner"), "Release workspace")
const member = await den.newMember(org.owner, org.orgId, "Release member")
const admin = await den.signUp("Release admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const reviewer = await den.signUp("Release reviewer")
const report = async () => {
  const call = await den.request(admin.token, "GET", "/v1/admin/managed-releases")
  assert.equal(call.status, 200, summary(call))
  return managedInstallerReportSchema.parse(call.body)
}
const aws = async () => {
  const state = (await report()).providers.find((entry) => entry.provider === "aws")
  assert.ok(state)
  return state
}
const qualification = { freshInstallUrl: "https://example.test/evidence/fresh", approvedUpdateUrl: "https://example.test/evidence/update" }
const fetcher = fixtureFetch(new Map(["1.2.1", "1.2.3", "1.2.4"].map((version) => [version, fixtureArtifacts(version)])))
const verifier: typeof verifyInstallerRelease = (provider, base, version) => verifyInstallerRelease(provider, base, version, fetcher)

test("all release routes require an authenticated platform administrator, not an organization owner or member", async () => {
  for (const [method, path, body] of [
    ["GET", "/v1/admin/managed-releases", undefined], ["GET", "/v1/admin/managed-releases/latest", undefined],
    ["PUT", "/v1/admin/managed-releases/aws/source", {}], ["PUT", "/v1/admin/managed-releases/aws/approval", {}], ["POST", "/v1/admin/managed-releases/validate", {}], ["POST", "/v1/admin/managed-releases/pin", {}], ["POST", "/v1/admin/managed-releases/reset", {}],
  ] satisfies ["GET" | "PUT" | "POST", string, unknown][]) {
    assert.equal((await den.request(null, method, path, { body })).status, 401)
    assert.equal((await den.request(org.owner.token, method, path, { body })).status, 403)
    assert.equal((await den.request(member.token, method, path, { body })).status, 403)
  }
})

test("independent approval is the default, ignores self-trusted JSON, and exposes a pending candidate to a second allowlisted platform admin", async () => {
  const current = await aws()
  assert.equal(current.approvalMode, "independent_admin")
  const validation = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.3", expectedRevision: current.revision }, admin.userId, verifier)
  assert.equal(validation.verifiedBy, admin.userId)
  assert.equal(validation.canPin, false)
  assert.equal((await aws()).pendingValidation?.id, validation.id)
  assert.equal((await aws()).pendingValidation?.canPin, false)
  await db.update(ManagedInstallerValidationTable).set({ validation: sql`JSON_SET(${ManagedInstallerValidationTable.validation}, '$.canPin', true, '$.verifiedBy', ${reviewer.userId})` }).where(eq(ManagedInstallerValidationTable.id, validation.id))
  assert.equal((await aws()).pendingValidation?.verifiedBy, admin.userId, "verifier identity is the server-owned actor column")
  assert.equal((await aws()).pendingValidation?.canPin, false, "stored preview cannot grant pin permission")
  const selfPin = await den.request(admin.token, "POST", "/v1/admin/managed-releases/pin", { body: { provider: "aws", validationId: validation.id, expectedRevision: current.revision, qualification } })
  assert.equal(selfPin.status, 403, summary(selfPin))
  assert.equal(field(selfPin.body, "error"), "independent_approval_required")
  assert.equal((await den.request(reviewer.token, "GET", "/v1/admin/managed-releases")).status, 403)
  const allowed = await den.request(admin.token, "POST", "/v1/admin/admins", { body: { email: reviewer.email } })
  assert.equal(allowed.status, 200, summary(allowed))
  const reviewCall = await den.request(reviewer.token, "GET", "/v1/admin/managed-releases")
  assert.equal(reviewCall.status, 200, summary(reviewCall))
  const pending = managedInstallerReportSchema.parse(reviewCall.body).providers.find((entry) => entry.provider === "aws")?.pendingValidation
  assert.equal(pending?.id, validation.id)
  assert.equal(pending?.canPin, true)
  assert.equal(pending?.verifiedBy, admin.userId)
  await releases.pinInstallerRelease({ provider: "aws", validationId: validation.id, expectedRevision: current.revision, qualification }, reviewer.userId, fetcher)
  assert.equal((await aws()).approvalMode, "independent_admin")
  await releases.resetInstallerRelease("aws", (await aws()).revision, reviewer.userId)
  assert.equal((await aws()).approvalMode, "independent_admin", "reset never weakens the approval policy")
})

test("persistent source CAS, immutable validation, atomic pin and explicit environment reset", async () => {
  const inherited = await aws()
  assert.equal(inherited.source, "environment")
  assert.equal(inherited.sourceBaseUrl, source)
  const saved = await den.request(admin.token, "PUT", "/v1/admin/managed-releases/aws/source", { body: { sourceBaseUrl: source, expectedRevision: inherited.revision } })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal((await den.request(admin.token, "PUT", "/v1/admin/managed-releases/aws/source", { body: { sourceBaseUrl: source + "other/", expectedRevision: inherited.revision } })).status, 409)
  const protectedState = await aws()
  assert.equal(protectedState.approvalMode, "independent_admin", "saving a source preserves independent approval")
  const oldPolicyPreview = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.3", expectedRevision: protectedState.revision }, admin.userId, verifier)
  const changedPolicy = await den.request(admin.token, "PUT", "/v1/admin/managed-releases/aws/approval", { body: { approvalMode: "platform_admin", expectedRevision: protectedState.revision } })
  assert.equal(changedPolicy.status, 200, summary(changedPolicy))
  const singleAdmin = await aws()
  assert.equal(singleAdmin.approvalMode, "platform_admin")
  assert.equal(singleAdmin.pendingValidation, null, "policy change invalidates previous previews")
  assert.notEqual(singleAdmin.revision, protectedState.revision)
  await assert.rejects(releases.pinInstallerRelease({ provider: "aws", validationId: oldPolicyPreview.id, expectedRevision: singleAdmin.revision, qualification }, admin.userId, fetcher), /source changed/)
  assert.equal((await den.request(admin.token, "PUT", "/v1/admin/managed-releases/aws/approval", { body: { approvalMode: "independent_admin", expectedRevision: protectedState.revision } })).status, 409)
  assert.equal((await den.request(admin.token, "PUT", `/v1/admin/organizations/${org.orgId}/capabilities`, { body: { capabilities: { managedDeployments: true } } })).status, 200)
  const owner = den.as(org.owner, org.orgId)
  const deploymentInput = { provider: "aws", name: "Frozen release installation", domainName: "release.example.test", ownerEmail: "owner@example.test", target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" } }
  const created = await owner("POST", "/v1/managed-deployments", deploymentInput)
  assert.equal(created.status, 200, summary(created))
  const deploymentId = text(field(created.body, "id"), "deployment")
  const oldLaunch = await owner("POST", `/v1/managed-deployments/${deploymentId}/launch`, { kind: "install" })
  assert.equal(oldLaunch.status, 200, summary(oldLaunch))
  assert.equal(field(oldLaunch.body, "deployment", "run", "version"), "1.2.2")
  const current = await aws()
  const validation = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.3", expectedRevision: current.revision }, admin.userId, verifier)
  assert.equal(validation.services.length, 5)
  assert.equal(validation.verifiedBy, admin.userId)
  assert.equal(validation.canPin, true, "single-administrator pinning requires an explicit policy change")
  assert.match(validation.release.templateUrl, /versionId=fixture/)
  const pinned = await releases.pinInstallerRelease({ provider: "aws", validationId: validation.id, expectedRevision: current.revision, qualification }, admin.userId, fetcher)
  assert.equal(pinned.providers.find((entry) => entry.provider === "aws")?.source, "admin")
  const updated = await aws()
  assert.equal(updated.release?.version, "1.2.3")
  assert.equal((await releases.effectiveInstallerRelease("aws"))?.version, "1.2.3")
  const reopened = await owner("POST", `/v1/managed-deployments/${deploymentId}/launch`, { kind: "install" })
  assert.equal(reopened.status, 200, summary(reopened))
  assert.equal(field(reopened.body, "deployment", "run", "id"), field(oldLaunch.body, "deployment", "run", "id"))
  assert.equal(field(reopened.body, "approvalUrl"), field(oldLaunch.body, "approvalUrl"), "pending run keeps its original immutable coordinates")
  const newCreated = await owner("POST", "/v1/managed-deployments", { ...deploymentInput, name: "New default installation" })
  assert.equal(newCreated.status, 200, summary(newCreated))
  const newLaunch = await owner("POST", `/v1/managed-deployments/${text(field(newCreated.body, "id"), "deployment")}/launch`, { kind: "install" })
  assert.equal(newLaunch.status, 200, summary(newLaunch))
  assert.equal(field(newLaunch.body, "deployment", "run", "version"), "1.2.3")
  const historyCount = (await report()).history.length
  await releases.pinInstallerRelease({ provider: "aws", validationId: validation.id, expectedRevision: updated.revision, qualification }, admin.userId, fetcher)
  assert.equal((await report()).history.length, historyCount, "same exact pin has no duplicate change")
  const alternateFetch = fixtureFetch(new Map([["1.2.3", fixtureArtifacts("1.2.3", { imageDigest: "c".repeat(64) })]]))
  const conflict = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.3", expectedRevision: updated.revision }, admin.userId, (provider, base, version) => verifyInstallerRelease(provider, base, version, alternateFetch))
  await assert.rejects(releases.pinInstallerRelease({ provider: "aws", validationId: conflict.id, expectedRevision: updated.revision, qualification }, admin.userId, alternateFetch), /different release bytes/)
  const old = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.1", expectedRevision: updated.revision }, admin.userId, verifier)
  await assert.rejects(releases.pinInstallerRelease({ provider: "aws", validationId: old.id, expectedRevision: updated.revision, qualification }, admin.userId, fetcher), /newer/)
  const later = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.4", expectedRevision: updated.revision }, admin.userId, verifier)
  await db.update(ManagedInstallerValidationTable).set({ expires_at: new Date(Date.now() - 60_000) }).where(eq(ManagedInstallerValidationTable.id, later.id))
  await assert.rejects(releases.pinInstallerRelease({ provider: "aws", validationId: later.id, expectedRevision: updated.revision, qualification }, admin.userId, fetcher), /again/)
  const reset = await den.request(admin.token, "POST", "/v1/admin/managed-releases/reset", { body: { provider: "aws", expectedRevision: updated.revision } })
  assert.equal(reset.status, 200, summary(reset))
  assert.equal((await aws()).release?.version, "1.2.2")
  assert.equal((await aws()).approvalMode, "platform_admin", "reset preserves the explicitly selected policy")
  const changes = await db.select().from(ManagedInstallerChangeTable)
  assert.ok(changes.some((change) => change.action === "pinned" && change.actor === admin.userId && change.qualification?.freshInstallUrl === qualification.freshInstallUrl && change.manifest_sha256 === validation.manifestSha256))
  assert.ok(changes.every((change) => change.before && change.after))
  assert.ok(changes.some((change) => change.action === "approval_saved" && change.actor === admin.userId && change.before.approvalMode === "independent_admin" && change.after.approvalMode === "platform_admin"))
})

test("source changes invalidate validation and concurrent writers cannot lose a setting", async () => {
  const current = await aws()
  const preview = await releases.validateInstallerRelease({ provider: "aws", version: "1.2.3", expectedRevision: current.revision }, admin.userId, verifier)
  const attempts = await Promise.all(["one/", "two/"].map((suffix) => den.request(admin.token, "PUT", "/v1/admin/managed-releases/aws/source", { body: { sourceBaseUrl: source + suffix, expectedRevision: current.revision } })))
  assert.deepEqual(attempts.map((call) => call.status).sort(), [200, 409])
  await assert.rejects(releases.pinInstallerRelease({ provider: "aws", validationId: preview.id, expectedRevision: (await aws()).revision, qualification }, admin.userId, fetcher), /source changed/)
})

test("invalid database pin never resurrects environment defaults", async () => {
  await db.update(ManagedInstallerConfigTable).set({ release: { version: "invalid", templateUrl: "invalid", bundleUrl: "invalid", bundleSha256: "invalid" } }).where(eq(ManagedInstallerConfigTable.provider, "aws"))
  assert.equal((await aws()).source, "invalid_configuration")
  assert.equal(await releases.effectiveInstallerRelease("aws"), null)
})
