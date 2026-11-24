/**
 * The installer has its own revision for one app version. Den here publishes
 * revision 2 of version 1.0.2: what that makes available to a deployment, what
 * each kind of run records, and what a record from before revisions means.
 */
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { hashToken } from "@openwork/managed-deployments/lifecycle"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

const ACCOUNT = "123456789012"
const SOURCE = "https://installer-fixture.s3.us-east-1.amazonaws.com/releases/aws/"
type Release = { version: string; installerRevision?: number; templateUrl: string; bundleUrl: string; bundleSha256: string }
function coordinates(version: string, revision: number, bundleSha256: string): Release {
  const folder = revision > 1 ? `${version}_r${revision}` : version
  return {
    version, ...(revision > 1 ? { installerRevision: revision } : {}), bundleSha256,
    templateUrl: `${SOURCE}${folder}/cloudformation.json?versionId=template-${folder}`,
    bundleUrl: `${SOURCE}${folder}/bundle.tar.gz?versionId=bundle-${folder}`,
  }
}
const first = coordinates("1.0.2", 1, "a".repeat(64))
const published = coordinates("1.0.2", 2, "b".repeat(64))
const third = coordinates("1.0.2", 3, "c".repeat(64))
const olderVersion = coordinates("1.0.1", 5, "d".repeat(64))

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify(published) } })
after(() => den.close())
const org = await den.createOrg(await den.signUp("Deployment Owner"), "Managed deployment workspace")
const owner = den.as(org.owner, org.orgId)
const organizationId = normalizeDenTypeId("organization", org.orgId)
for (const key of ["managedDeployments", "managedDeploymentConfigUpdates"]) assert.equal((await den.setFeature(org.orgId, key, true)).status, 200)
const { db } = await import("../../src/db.js")

const DAY = 24 * 60 * 60 * 1000
const STEPS = ["runner_connected", "release_verified", "account_verified", "infrastructure_applied", "services_ready", "health_verified"]
const target = { accountId: ACCOUNT, region: "us-east-1", route53ZoneId: "ZTEST" }

/**
 * Arrange an existing customer installation whose latest run verified health
 * with `release`. `recorded: false` writes the rows as Den wrote them before
 * revisions existed: neither row names a revision.
 */
async function installed(release: Release, options: { recorded?: boolean } = {}) {
  const id = randomUUID()
  const baseRunId = randomUUID()
  const revision = options.recorded === false ? {} : { installer_revision: release.installerRevision ?? 1 }
  await db.insert(ManagedDeploymentTable).values({
    id, org_id: organizationId, provider: "aws", name: "Managed deployment", target, domain_name: "openwork.example.com",
    owner_email: "admin@example.com", size: "small", installed_version: release.version, active_run_id: baseRunId,
    ...(options.recorded === false ? {} : { installed_installer_revision: release.installerRevision ?? 1 }),
  })
  await db.insert(ManagedDeploymentRunTable).values({
    id: baseRunId, deployment_id: id, kind: "install", version: release.version, template_url: release.templateUrl, bundle_url: release.bundleUrl,
    bundle_sha256: release.bundleSha256, api_origin: "https://previous-api.example.com", challenge: randomBytes(32).toString("hex"), state: "ready", last_sequence: 6,
    expires_at: new Date(Date.now() - DAY), created_at: new Date(Date.now() - 2 * DAY), ...revision,
  })
  return { id, baseRunId }
}

async function view(id: string) {
  const listed = await owner("GET", "/v1/managed-deployments")
  assert.equal(listed.status, 200, summary(listed))
  const found = list(field(listed.body, "deployments")).find((entry) => entry.id === id)
  assert.ok(found, `deployment ${id} is listed`)
  return found
}

const launch = (id: string, kind: "install" | "retry" | "update") => owner("POST", `/v1/managed-deployments/${id}/launch`, { kind })

/** The installer template and parameters a prepared command would send to AWS. */
function command(call: Call) {
  assert.equal(call.status, 200, summary(call))
  const shell = text(field(call.body, "command"), "command")
  const match = /--template-url '([^']+)' .*--parameters '(.+)'$/.exec(shell)
  assert.ok(match, shell)
  const parsed: unknown = JSON.parse(match[2] ?? "")
  return { templateUrl: match[1], parameters: new Map(list(parsed).map((entry) => [String(entry.ParameterKey), String(entry.ParameterValue)])), runId: text(field(call.body, "deployment", "run", "id"), "run ID") }
}

/** The installer enrolled for this run and reported every milestone up to verified health. */
async function finish(id: string, runId: string) {
  const token = randomBytes(32).toString("base64url")
  await db.update(ManagedDeploymentRunTable).set({ state: "provisioning", token_hash: hashToken(token) }).where(eq(ManagedDeploymentRunTable.id, runId))
  for (let sequence = 1; sequence <= STEPS.length; sequence += 1) {
    const reported = await den.request(token, "POST", `/v1/managed-deployments/${id}/runs/${runId}/events`, { body: { sequence, step: STEPS[sequence - 1], outcome: "succeeded" } })
    assert.equal(reported.status, 200, summary(reported))
  }
}

async function recordedRevisions(id: string) {
  const [row] = await db.$primary.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, id))
  assert.ok(row)
  return { version: row.installed_version, revision: row.installed_installer_revision }
}

test("a deployment recorded before revisions existed is revision 1, and a higher revision of its version is an Update it can approve", async () => {
  const { id } = await installed(first, { recorded: false })
  assert.deepEqual(await recordedRevisions(id), { version: "1.0.2", revision: null }, "the deployment row names no revision")
  const [stored] = await db.$primary.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.deployment_id, id))
  assert.equal(stored?.installer_revision, 1, "a run written without a revision reads as revision 1")

  const shown = await view(id)
  assert.equal(field(shown, "installedVersion"), "1.0.2")
  assert.equal(field(shown, "installedInstallerRevision"), 1)
  assert.equal(field(shown, "availableVersion"), "1.0.2")
  assert.equal(field(shown, "availableInstallerRevision"), 2)
  assert.equal(field(shown, "updateAvailable"), true, "the same version at a higher installer revision is an update")
  assert.equal(field(shown, "run", "installerRevision"), 1)

  const update = await launch(id, "update")
  assert.equal(update.status, 200, summary(update))
  assert.equal(field(update.body, "kind"), "update")
  const prepared = command(update)
  assert.equal(prepared.templateUrl, published.templateUrl)
  assert.equal(prepared.parameters.get("OpenWorkVersion"), "1.0.2", "the app version the installer deploys is unchanged")
  assert.equal(prepared.parameters.get("BundleUrl"), published.bundleUrl)
  assert.equal(prepared.parameters.get("BundleSha256"), published.bundleSha256)
  assert.equal(field(update.body, "deployment", "run", "version"), "1.0.2")
  assert.equal(field(update.body, "deployment", "run", "installerRevision"), 2)
  assert.deepEqual(await recordedRevisions(id), { version: "1.0.2", revision: null }, "preparing an update records nothing as installed")

  await finish(id, prepared.runId)
  assert.deepEqual(await recordedRevisions(id), { version: "1.0.2", revision: 2 })
  const updated = await view(id)
  assert.equal(field(updated, "installedInstallerRevision"), 2)
  assert.equal(field(updated, "updateAvailable"), false)
  const again = await launch(id, "update")
  assert.equal(again.status, 409, summary(again))
  assert.equal(field(again.body, "error"), "already_current")
})

test("an Update is offered only when the version and revision pair increases", async () => {
  for (const [release, available] of [[published, false], [third, false], [olderVersion, true]] satisfies [Release, boolean][]) {
    const { id } = await installed(release)
    const shown = await view(id)
    assert.equal(field(shown, "installedInstallerRevision"), release.installerRevision ?? 1)
    assert.equal(field(shown, "updateAvailable"), available, `${release.version} revision ${release.installerRevision ?? 1} against published 1.0.2 revision 2`)
    const update = await launch(id, "update")
    assert.equal(update.status, available ? 200 : 409, summary(update))
    if (!available) assert.equal(field(update.body, "error"), "already_current")
    else assert.equal(field(update.body, "deployment", "run", "installerRevision"), 2, "a newer version outranks any revision of an older one")
  }
})

test("Install and Retry record the published revision", async () => {
  const created = await owner("POST", "/v1/managed-deployments", { provider: "aws", name: "New deployment", domainName: "new.example.com", ownerEmail: "admin@example.com", target: { ...target, runtimeProfile: "legacy" } })
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "deployment ID")
  assert.equal(field(created.body, "installedInstallerRevision"), null, "nothing is installed yet")
  assert.equal(field(created.body, "availableInstallerRevision"), 2)
  const install = await launch(id, "install")
  assert.equal(install.status, 200, summary(install))
  assert.equal(field(install.body, "deployment", "run", "installerRevision"), 2)
  const approvalUrl = new URL(text(field(install.body, "approvalUrl"), "approval link"))
  assert.equal(new URL(approvalUrl.hash.slice(1), approvalUrl).searchParams.get("templateURL"), published.templateUrl)
  const installRunId = text(field(install.body, "deployment", "run", "id"), "run ID")
  await db.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, installRunId))

  const retry = await launch(id, "retry")
  assert.equal(retry.status, 200, summary(retry))
  assert.equal(field(retry.body, "deployment", "run", "installerRevision"), 2)
  const prepared = command(retry)
  assert.equal(prepared.templateUrl, published.templateUrl)
  await finish(id, prepared.runId)
  assert.deepEqual(await recordedRevisions(id), { version: "1.0.2", revision: 2 })
})

test("a configuration change re-runs the installed revision and leaves the newer one available", async () => {
  const { id } = await installed(first)
  const shown = await view(id)
  assert.equal(field(shown, "configuration", "lock"), null)
  assert.equal(field(shown, "configuration", "gatewayAvailable"), false, "the gateway is added only from the published revision")
  const changed = await owner("POST", `/v1/managed-deployments/${id}/configuration-changes`, {
    expectedRevision: text(field(shown, "configuration", "revision"), "revision"),
    configuration: { provider: "aws", name: "Managed deployment", domainName: "openwork.example.com", ownerEmail: "first.admin@example.com", target: field(shown, "target") },
  })
  assert.equal(field(changed.body, "outcome"), "approval_required", summary(changed))
  const prepared = command(changed)
  assert.equal(prepared.templateUrl, first.templateUrl)
  assert.equal(prepared.parameters.get("BundleUrl"), first.bundleUrl)
  assert.equal(field(changed.body, "deployment", "run", "kind"), "configure")
  assert.equal(field(changed.body, "deployment", "run", "installerRevision"), 1, "the change runs the installer the deployment already has")

  await finish(id, prepared.runId)
  assert.deepEqual(await recordedRevisions(id), { version: "1.0.2", revision: 1 })
  const applied = await view(id)
  assert.equal(field(applied, "ownerEmail"), "first.admin@example.com")
  assert.equal(field(applied, "installedInstallerRevision"), 1)
  assert.equal(field(applied, "updateAvailable"), true, "revision 2 is still an update")
  assert.equal(field(applied, "configuration", "lock"), null, "the applied change is what the next change re-runs")

  const current = await installed(published)
  assert.equal(field(await view(current.id), "configuration", "gatewayAvailable"), true, "a deployment on the published revision can add the gateway")
})

test("a deployment whose recorded revision is not the one its last successful run installed cannot be edited", async () => {
  const { id } = await installed(first)
  await db.update(ManagedDeploymentTable).set({ installed_installer_revision: 2 }).where(eq(ManagedDeploymentTable.id, id))
  assert.equal(field(await view(id), "configuration", "lock"), "installer_unknown")
})
