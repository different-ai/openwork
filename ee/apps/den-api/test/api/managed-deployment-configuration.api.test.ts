/**
 * Configuration changes for an installed AWS deployment at its installed
 * installer version: what an owner may change, the command they approve in
 * their own AWS account, and when Den records the change as applied.
 */
import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { enrollmentProof, runnerRoleName } from "@openwork/managed-deployments/aws"
import { hashToken } from "@openwork/managed-deployments/lifecycle"
import { bootDen, field, isRecord, list, summary, text, type Call } from "./harness.js"

const ACCOUNT = "123456789012"
const STS = "https://sts.us-east-1.amazonaws.com/"
const SOURCE = "https://installer-fixture.s3.us-east-1.amazonaws.com/releases/aws/"
const coordinates = (version: string, bundleSha256: string) => ({
  version, bundleSha256,
  templateUrl: `${SOURCE}${version}/cloudformation.json?versionId=template-${version}`,
  bundleUrl: `${SOURCE}${version}/bundle.tar.gz?versionId=bundle-${version}`,
})
const published = coordinates("1.0.2", "a".repeat(64))
const older = coordinates("1.0.1", "b".repeat(64))

// Only STS's answer about who signed a request is synthetic: the real routes,
// proof binding, locks and MySQL run. Nothing else at AWS is ever requested.
const realFetch = globalThis.fetch
const identities = new Map<string, { arn: string; signature: string }>()
let stsRequests = 0
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.href !== STS) {
    if (url.hostname === "amazonaws.com" || url.hostname.endsWith(".amazonaws.com")) throw new Error(`A test tried to reach AWS at ${url.hostname}`)
    return realFetch(input, init)
  }
  stsRequests += 1
  assert.equal(init?.method, "POST")
  assert.equal(init?.body, "Action=GetCallerIdentity&Version=2011-06-15")
  const headers = new Headers(init?.headers)
  const identity = identities.get(headers.get("x-openwork-proof")?.split(":")[1] ?? "")
  if (!identity || !headers.get("authorization")?.endsWith(`Signature=${identity.signature}`)) return new Response("Invalid fixture signature", { status: 403 })
  return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${ACCOUNT}</Account><Arn>${identity.arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`, { headers: { "content-type": "text/xml" } })
}

const den = await bootDen({ productionLike: true, env: { DEN_DEPLOYMENT: "cloud", DEN_AUDIT_SELF_HOSTED_ENABLED: "true", DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify(published) } })
after(async () => { globalThis.fetch = realFetch; await den.close() })
const org = await den.createOrg(await den.signUp("Deployment Owner"), "Managed deployment workspace")
const member = await den.newMember(org.owner, org.orgId, "Deployment Member")
const foreign = await den.createOrg(await den.signUp("Other Owner"), "Other deployment workspace")
const owner = den.as(org.owner, org.orgId)
const organizationId = normalizeDenTypeId("organization", org.orgId)
for (const key of ["managedDeployments", "managedDeploymentAssistants", "managedDeploymentConfigUpdates"]) assert.equal((await den.setFeature(org.orgId, key, true)).status, 200)
for (const key of ["managedDeployments", "managedDeploymentConfigUpdates"]) assert.equal((await den.setFeature(foreign.orgId, key, true)).status, 200)
const { db } = await import("../../src/db.js")
const { dbQueryCounter } = await import("../../src/observability/db-query-count.js")

const DAY = 24 * 60 * 60 * 1000
const STEPS = ["runner_connected", "release_verified", "account_verified", "infrastructure_applied", "services_ready", "health_verified"]
const identity = { accountId: ACCOUNT, region: "us-east-1", route53ZoneId: "ZTEST" }
const gatewayTarget = { ...identity, network: { mode: "dedicated" }, runtimeProfile: "gateway", assistants: { headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true, computerProvider: "off" } }
const computerSecretArn = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:managed/computer-Ab12Cd`
const daytona = { computerProvider: "daytona", computerSnapshot: "computer-snapshot", computerSecretArn }
const createInput = { provider: "aws", name: "Managed deployment", domainName: "openwork.example.com", ownerEmail: "admin@example.com", target: { ...identity, runtimeProfile: "legacy" } }

/**
 * Arrange an existing customer installation: a deployment whose latest run
 * verified health with `release`. Assertions use only the public HTTP API.
 */
async function installed(options: { target?: Record<string, unknown>; release?: typeof published } = {}) {
  const id = randomUUID()
  const baseRunId = randomUUID()
  const release = options.release ?? published
  await db.insert(ManagedDeploymentTable).values({
    id, org_id: organizationId, provider: "aws", name: "Managed deployment", target: options.target ?? identity, domain_name: "openwork.example.com",
    owner_email: "admin@example.com", size: "small", installed_version: release.version, active_run_id: baseRunId,
  })
  await db.insert(ManagedDeploymentRunTable).values({
    id: baseRunId, deployment_id: id, kind: "install", version: release.version, template_url: release.templateUrl, bundle_url: release.bundleUrl,
    bundle_sha256: release.bundleSha256, api_origin: "https://previous-api.example.com", challenge: randomBytes(32).toString("hex"), state: "ready", last_sequence: 6,
    expires_at: new Date(Date.now() - DAY), created_at: new Date(Date.now() - 2 * DAY),
  })
  return { id, baseRunId, path: `/v1/managed-deployments/${id}/configuration-changes` }
}

async function view(id: string, as = owner) {
  const listed = await as("GET", "/v1/managed-deployments")
  assert.equal(listed.status, 200, summary(listed))
  const found = list(field(listed.body, "deployments")).find((entry) => entry.id === id)
  assert.ok(found, `deployment ${id} is listed`)
  return found
}

type Draft = { provider: "aws"; name: string; domainName: string; ownerEmail: string; target: Record<string, unknown> }
type Edit = (draft: Draft) => Draft

/** The complete document the dashboard sends: the deployment as it is shown, with one edit. */
function draft(shown: unknown): Draft {
  const target = field(shown, "target")
  if (!isRecord(target)) throw new Error("the deployment has no target")
  return { provider: "aws", name: text(field(shown, "name"), "name"), domainName: text(field(shown, "domainName"), "address"), ownerEmail: text(field(shown, "ownerEmail"), "email"), target }
}
const email = (ownerEmail: string): Edit => (current) => ({ ...current, ownerEmail })
const rename = (name: string): Edit => (current) => ({ ...current, name })
const target = (edit: Record<string, unknown>): Edit => (current) => ({ ...current, target: { ...current.target, ...edit } })
const gatewayWithDaytona = target({ runtimeProfile: "gateway", assistants: daytona })
const unchanged: Edit = (current) => current

async function change(id: string, edit: Edit, options: { revision?: string; as?: typeof owner } = {}) {
  const shown = await view(id)
  return (options.as ?? owner)("POST", `/v1/managed-deployments/${id}/configuration-changes`, {
    expectedRevision: options.revision ?? text(field(shown, "configuration", "revision"), "revision"), configuration: edit(draft(shown)),
  })
}

/** What the customer would run: the installer template and its parameters, read from the command itself. */
function handoff(call: Call) {
  assert.equal(call.status, 200, summary(call))
  assert.equal(field(call.body, "outcome"), "approval_required")
  const command = text(field(call.body, "command"), "command")
  const match = /--template-url '([^']+)' .*--parameters '(.+)'$/.exec(command)
  assert.ok(match, command)
  const parsed: unknown = JSON.parse(match[2] ?? "")
  const parameters = new Map(list(parsed).map((entry) => [String(entry.ParameterKey), String(entry.ParameterValue)]))
  return { command, templateUrl: match[1], parameters, runId: text(field(call.body, "deployment", "run", "id"), "run ID") }
}

/** The installer in the customer's account proving which role it runs as, for this run and challenge. */
function signedEnrollment(deploymentId: string, runId: string, challenge: string) {
  const signature = createHash("sha256").update(`fixture-identity:${runId}`).digest("hex")
  identities.set(runId, { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${runnerRoleName(deploymentId)}/installer-fixture`, signature })
  const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  return { headers: {
    authorization: `AWS4-HMAC-SHA256 Credential=fixture/${date.slice(0, 8)}/us-east-1/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof, Signature=${signature}`,
    "x-amz-date": date, "x-amz-security-token": "fixture-session-token", "x-openwork-proof": enrollmentProof(runId, challenge),
  } }
}

const enroll = (id: string, prepared: ReturnType<typeof handoff>) => den.request(null, "POST", `/v1/managed-deployments/${id}/runs/${prepared.runId}/enroll`, {
  body: signedEnrollment(id, prepared.runId, prepared.parameters.get("Challenge") ?? ""),
})

const report = (id: string, runId: string, token: string, sequence: number, failure?: string) => den.request(token, "POST", `/v1/managed-deployments/${id}/runs/${runId}/events`, {
  body: { sequence, step: STEPS[sequence - 1], outcome: failure ? "failed" : "succeeded", ...(failure ? { errorCode: failure } : {}) },
})

/** Arrange a run the installer has already enrolled for; its milestones are then reported over HTTP. */
async function enrolled(runId: string) {
  const token = randomBytes(32).toString("base64url")
  await db.update(ManagedDeploymentRunTable).set({ state: "provisioning", token_hash: hashToken(token) }).where(eq(ManagedDeploymentRunTable.id, runId))
  return token
}

function refused(call: Call, status: number, error: string) {
  assert.equal(call.status, status, summary(call))
  assert.equal(field(call.body, "error"), error)
  assert.ok(text(field(call.body, "message"), `${error} message`).length > 10)
}

test("an email change returns the CloudShell command for the installed installer and records nothing until AWS approves", async () => {
  const { id, baseRunId } = await installed()
  const before = await view(id)
  assert.equal(field(before, "configuration", "lock"), null)
  assert.equal(field(before, "configuration", "change"), null)
  assert.equal(field(before, "configuration", "gatewayAvailable"), true)

  const prepared = await change(id, email("first.admin@example.com"))
  const { command, parameters, templateUrl, runId } = handoff(prepared)
  assert.equal(field(prepared.body, "kind"), "configure")
  assert.equal(field(prepared.body, "approvalUrl"), null)
  assert.equal(field(prepared.body, "handoff", "action"), "run_in_cloud_shell")
  assert.equal(field(prepared.body, "handoff", "command"), command)
  assert.deepEqual(field(prepared.body, "changes"), [{ field: "ownerEmail", before: "admin@example.com", after: "first.admin@example.com", effect: "restarts_den" }])
  assert.equal(parameters.get("OwnerEmail"), "first.admin@example.com")
  assert.equal(parameters.get("OpenWorkVersion"), published.version)
  assert.equal(parameters.get("BundleSha256"), published.bundleSha256)
  assert.equal(parameters.get("ControlPlaneOrigin"), "http://127.0.0.1:8790", "the installer reports to the API's current address, not the one the base run used")
  assert.equal(parameters.get("DeploymentId"), id)
  assert.equal(parameters.get("RunId"), runId)
  assert.notEqual(runId, baseRunId)
  assert.equal(templateUrl, published.templateUrl)
  assert.ok(command.includes(`= '${ACCOUNT}' ]`), "the command refuses to run in another AWS account")

  const shown = await view(id)
  assert.equal(field(shown, "ownerEmail"), "admin@example.com", "the recorded email is the installed one")
  assert.equal(field(shown, "installedVersion"), published.version)
  assert.equal(field(shown, "run", "id"), runId)
  assert.equal(field(shown, "run", "kind"), "configure")
  assert.equal(field(shown, "run", "state"), "awaiting_approval")
  assert.equal(field(shown, "configuration", "lock"), null)
  assert.equal(field(shown, "configuration", "change", "runId"), runId)
  assert.equal(field(shown, "configuration", "change", "state"), "awaiting_approval")
  assert.equal(field(shown, "configuration", "change", "requested", "ownerEmail"), "first.admin@example.com")
  assert.deepEqual(field(shown, "configuration", "change", "changes"), field(prepared.body, "changes"))
  assert.notEqual(field(shown, "configuration", "revision"), field(before, "configuration", "revision"))
})

test("values fixed at installation, turning the gateway off, legacy computers and foreign secrets are refused by name and prepare nothing", async () => {
  const legacy = await installed()
  const fixed: [Edit, string, string][] = [
    [(current) => ({ ...current, domainName: "other.example.com" }), "domainName", "address"],
    [target({ region: "us-west-2" }), "target.region", "region"],
    [target({ accountId: "210987654321" }), "target.accountId", "AWS account"],
    [target({ route53ZoneId: "ZOTHER" }), "target.route53ZoneId", "hosted zone"],
    [target({ network: { mode: "existing", vpcId: "vpc-0abc12345", serviceSubnetIds: ["subnet-0abc12345", "subnet-0abc12346"], loadBalancerSubnetIds: ["subnet-0abc12347", "subnet-0abc12348"] } }), "target.network", "network"],
  ]
  for (const [edit, name, word] of fixed) {
    const call = await change(legacy.id, edit)
    refused(call, 400, "field_not_editable")
    assert.equal(field(call.body, "field"), name)
    assert.equal(field(call.body, "message"), `The ${word} can't be changed after installation. Create a new deployment to use a different one.`)
  }
  const computers = await change(legacy.id, target({ assistants: daytona }))
  refused(computers, 400, "computers_need_gateway")
  assert.equal(field(computers.body, "field"), "target.assistants.computerProvider")
  const ownRunner = await change(legacy.id, target({ assistants: { headlessRunnerEnabled: true } }))
  refused(ownRunner, 400, "legacy_runtime_not_editable")
  assert.equal(field((await view(legacy.id)), "run", "id"), legacy.baseRunId)

  const gateway = await installed({ target: gatewayTarget })
  const removed = await change(gateway.id, target({ runtimeProfile: "legacy" }))
  refused(removed, 400, "gateway_cannot_be_removed")
  assert.equal(field(removed.body, "field"), "target.runtimeProfile")
  const foreignSecret = await change(gateway.id, target({ assistants: { ...daytona, computerSecretArn: computerSecretArn.replace(ACCOUNT, "210987654321") } }))
  refused(foreignSecret, 400, "invalid_configuration")
  assert.equal(field(foreignSecret.body, "field"), "target.assistants.computerSecretArn")
  assert.equal(field(foreignSecret.body, "message"), "Use a Secrets Manager secret in this deployment's AWS account and region.")
  const shown = await view(gateway.id)
  assert.equal(field(shown, "run", "id"), gateway.baseRunId)
  assert.equal(field(shown, "configuration", "change"), null)
  const none = await change(gateway.id, unchanged)
  refused(none, 400, "no_changes")
})

test("the gateway runtime and Daytona computers are added only from the published installer and only while gateway deployments are enabled", async () => {
  const current = await installed()
  const prepared = await change(current.id, gatewayWithDaytona)
  const { parameters } = handoff(prepared)
  assert.equal(parameters.get("ManagedRuntimeProfile"), "gateway")
  assert.equal(parameters.get("HeadlessRunnerEnabled"), "true")
  assert.equal(parameters.get("HeadlessComputerProvider"), "daytona")
  assert.equal(parameters.get("HeadlessComputerSecretArn"), computerSecretArn)
  assert.equal(parameters.get("HeadlessComputerSnapshot"), "computer-snapshot")
  assert.equal(parameters.get("OpenWorkVersion"), published.version)
  assert.deepEqual(list(field(prepared.body, "changes")).map((entry) => `${entry.field}:${entry.effect}`), [
    "target.runtimeProfile:adds_gateway_runtime", "target.assistants.computerProvider:restarts_runner",
    "target.assistants.computerSecretArn:restarts_runner", "target.assistants.computerSnapshot:restarts_runner",
  ])
  const shown = await view(current.id)
  assert.equal(field(shown, "target", "runtimeProfile"), "legacy", "the recorded profile is the installed one")
  assert.equal(field(shown, "target", "assistants", "computerProvider"), "off")
  assert.equal(field(shown, "configuration", "change", "requested", "target", "runtimeProfile"), "gateway")

  const behind = await installed({ release: older })
  assert.equal(field(await view(behind.id), "configuration", "gatewayAvailable"), false)
  refused(await change(behind.id, gatewayWithDaytona), 409, "gateway_needs_current_installer")
  assert.equal(field(await view(behind.id), "run", "id"), behind.baseRunId)

  const fresh = await installed()
  assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", false)).status, 200)
  try {
    const denied = await change(fresh.id, gatewayWithDaytona)
    refused(denied, 404, "feature_disabled")
    assert.equal(field(denied.body, "feature"), "managedDeploymentAssistants")
    const reopened = await change(current.id, gatewayWithDaytona)
    refused(reopened, 404, "feature_disabled")
    handoff(await change(fresh.id, email("first.admin@example.com")))
  } finally {
    assert.equal((await den.setFeature(org.orgId, "managedDeploymentAssistants", true)).status, 200)
  }
})

test("a request made against an older view of the deployment is refused", async () => {
  const { id, baseRunId } = await installed()
  const stale = text(field(await view(id), "configuration", "revision"), "revision")
  const renamed = await change(id, rename("Renamed elsewhere"))
  assert.equal(renamed.status, 200, summary(renamed))
  refused(await change(id, email("first.admin@example.com"), { revision: stale }), 409, "configuration_changed")
  const shown = await view(id)
  assert.equal(field(shown, "run", "id"), baseRunId)
  assert.equal(field(shown, "name"), "Renamed elsewhere")
})

test("asking again reopens the same approval, a different request supersedes it, and a superseded run cannot enroll", async () => {
  const { id } = await installed()
  const stale = text(field(await view(id), "configuration", "revision"), "revision")
  const first = handoff(await change(id, email("first.admin@example.com")))
  const again = handoff(await change(id, email("first.admin@example.com"), { revision: stale }))
  assert.equal(again.runId, first.runId)
  assert.equal(again.command, first.command)

  refused(await change(id, email("second.admin@example.com"), { revision: stale }), 409, "configuration_changed")
  const second = handoff(await change(id, email("second.admin@example.com")))
  assert.notEqual(second.runId, first.runId)
  assert.notEqual(second.parameters.get("Challenge"), first.parameters.get("Challenge"))
  assert.equal(field(await view(id), "configuration", "change", "requested", "ownerEmail"), "second.admin@example.com")

  const before = stsRequests
  const superseded = await enroll(id, first)
  assert.equal(superseded.status, 404, summary(superseded))
  assert.equal(field(superseded.body, "error"), "deployment_not_found")
  assert.equal(stsRequests, before, "a superseded run is refused before its identity is even checked")

  const accepted = await enroll(id, second)
  assert.equal(accepted.status, 200, summary(accepted))
  assert.equal(stsRequests, before + 1)
  const applying = await view(id)
  assert.equal(field(applying, "run", "state"), "provisioning")
  assert.equal(field(applying, "configuration", "lock"), "run_in_progress")
  assert.equal(field(applying, "configuration", "change", "state"), "applying")
  refused(await change(id, email("third.admin@example.com")), 409, "run_in_progress")
  refused(await change(id, email("second.admin@example.com")), 409, "run_in_progress")
  assert.equal(field(await view(id), "ownerEmail"), "admin@example.com")
})

test("asking for the recorded configuration withdraws a pending change, restores the installed run, and the withdrawn run cannot enroll", async () => {
  const { id, baseRunId } = await installed()
  const first = handoff(await change(id, email("first.admin@example.com")))
  const second = handoff(await change(id, email("second.admin@example.com")))
  const withdrawn = await change(id, unchanged)
  assert.equal(withdrawn.status, 200, summary(withdrawn))
  assert.equal(field(withdrawn.body, "outcome"), "withdrawn")
  assert.equal(field(withdrawn.body, "command"), undefined)
  assert.equal(field(withdrawn.body, "deployment", "run", "id"), baseRunId, "the run that never reached AWS before it is not restored either")
  const shown = await view(id)
  assert.equal(field(shown, "run", "id"), baseRunId)
  assert.equal(field(shown, "run", "state"), "ready")
  assert.equal(field(shown, "ownerEmail"), "admin@example.com")
  assert.equal(field(shown, "configuration", "change"), null)
  assert.equal(field(shown, "configuration", "lock"), null)

  const before = stsRequests
  for (const run of [first, second]) {
    const refusedRun = await enroll(id, run)
    assert.equal(refusedRun.status, 404, summary(refusedRun))
  }
  assert.equal(stsRequests, before)
  refused(await change(id, unchanged), 400, "no_changes")
})

test("an approval that expired is shown as expired, can be discarded, and can be prepared again", async () => {
  const { id, baseRunId } = await installed()
  const first = handoff(await change(id, email("first.admin@example.com")))
  await db.update(ManagedDeploymentRunTable).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(ManagedDeploymentRunTable.id, first.runId))
  const expired = await view(id)
  assert.equal(field(expired, "configuration", "change", "state"), "expired")
  assert.equal(field(expired, "configuration", "lock"), null)
  const late = await enroll(id, first)
  assert.equal(late.status, 409, summary(late))
  const again = handoff(await change(id, email("first.admin@example.com")))
  assert.notEqual(again.runId, first.runId)
  await db.update(ManagedDeploymentRunTable).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(ManagedDeploymentRunTable.id, again.runId))
  const discarded = await change(id, unchanged)
  assert.equal(field(discarded.body, "outcome"), "withdrawn", summary(discarded))
  assert.equal(field(await view(id), "run", "id"), baseRunId)
})

test("a new name is saved at once without a run, and beside a pending email change", async () => {
  const { id, baseRunId } = await installed()
  const saved = await change(id, rename("Production"))
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "outcome"), "saved")
  assert.equal(field(saved.body, "command"), undefined)
  assert.equal(field(saved.body, "deployment", "name"), "Production")
  const shown = await view(id)
  assert.equal(field(shown, "name"), "Production")
  assert.equal(field(shown, "run", "id"), baseRunId)
  assert.equal(field(shown, "configuration", "change"), null)

  const both = await change(id, (current) => ({ ...current, name: "Production EU", ownerEmail: "first.admin@example.com" }))
  const { parameters } = handoff(both)
  assert.equal(parameters.get("OwnerEmail"), "first.admin@example.com")
  assert.deepEqual(list(field(both.body, "changes")).map((entry) => entry.field), ["ownerEmail"])
  const pending = await view(id)
  assert.equal(field(pending, "name"), "Production EU")
  assert.equal(field(pending, "ownerEmail"), "admin@example.com")
  assert.equal(field(pending, "configuration", "change", "requested", "name"), "Production EU")

  // Renaming again while the change awaits approval keeps the change and its command.
  const kept = await owner("POST", `/v1/managed-deployments/${id}/configuration-changes`, {
    expectedRevision: field(pending, "configuration", "revision"), configuration: { ...draft(pending), name: "Production EU 2", ownerEmail: "first.admin@example.com" },
  })
  assert.equal(handoff(kept).command, handoff(both).command)
  assert.equal(field(await view(id), "name"), "Production EU 2")
})

test("with the feature off the route and the configuration block are gone and list, create and launch answer as before", async () => {
  const { id, path } = await installed({ release: older })
  const runSelects: string[] = []
  const count = dbQueryCounter.logQuery
  dbQueryCounter.logQuery = (query, params) => {
    if (/from `managed_deployment_run`/.test(query)) runSelects.push(query)
    count(query, params)
  }
  try {
    const on = await owner("GET", "/v1/managed-deployments")
    assert.ok(list(field(on.body, "deployments")).every((entry) => isRecord(entry.configuration)))
    assert.equal(runSelects.length, 2, "active runs, then each deployment's run history")
    const revision = text(field(await view(id), "configuration", "revision"), "revision")

    assert.equal((await den.setFeature(org.orgId, "managedDeploymentConfigUpdates", false)).status, 200)
    runSelects.length = 0
    const off = await owner("GET", "/v1/managed-deployments")
    assert.equal(off.status, 200, summary(off))
    assert.equal(runSelects.length, 1, "only the active runs are read")
    const byId = (left: Record<string, unknown>, right: Record<string, unknown>) => String(left.id).localeCompare(String(right.id))
    const withoutBlock = list(field(on.body, "deployments")).map(({ configuration: _, ...rest }) => rest).sort(byId)
    assert.deepEqual(list(field(off.body, "deployments")).sort(byId), withoutBlock, "the list is exactly today's")
    assert.ok(!off.text.includes("\"configuration\""))

    const created = await owner("POST", "/v1/managed-deployments", createInput)
    assert.equal(created.status, 200, summary(created))
    assert.ok(!created.text.includes("\"configuration\""))
    const launched = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "update" })
    assert.equal(launched.status, 200, summary(launched))
    assert.ok(!launched.text.includes("\"configuration\""))
    assert.deepEqual(Object.keys(isRecord(launched.body) ? launched.body : {}).sort(), ["approvalUrl", "command", "deployment", "expiresAt", "handoff", "kind"])

    const denied = await owner("POST", path, { expectedRevision: revision, configuration: draft(await view(id)) })
    refused(denied, 404, "feature_disabled")
    assert.equal(field(denied.body, "feature"), "managedDeploymentConfigUpdates")
  } finally {
    dbQueryCounter.logQuery = count
    assert.equal((await den.setFeature(org.orgId, "managedDeploymentConfigUpdates", true)).status, 200)
  }
  const createdWithFlag = await owner("POST", "/v1/managed-deployments", createInput)
  assert.equal(field(createdWithFlag.body, "configuration", "lock"), "not_installed", summary(createdWithFlag))
})

test("turning the feature off withdraws a prepared change when its installer enrolls, and lets a change that already started finish", async () => {
  const prepared = await installed()
  const started = await installed()
  const waiting = handoff(await change(prepared.id, email("first.admin@example.com")))
  const running = handoff(await change(started.id, email("first.admin@example.com")))
  const token = await enrolled(running.runId)
  assert.equal((await report(started.id, running.runId, token, 1)).status, 200)

  assert.equal((await den.setFeature(org.orgId, "managedDeploymentConfigUpdates", false)).status, 200)
  try {
    const forged = await den.request(null, "POST", `/v1/managed-deployments/${prepared.id}/runs/${waiting.runId}/enroll`, {
      body: { headers: { ...signedEnrollment(prepared.id, waiting.runId, waiting.parameters.get("Challenge") ?? "").headers, "x-openwork-proof": enrollmentProof(waiting.runId, "0".repeat(64)) } },
    })
    assert.equal(forged.status, 401, summary(forged))
    const before = stsRequests
    const stopped = await enroll(prepared.id, waiting)
    assert.equal(stopped.status, 409, summary(stopped))
    assert.equal(field(stopped.body, "error"), "deployment_run_conflict")
    assert.equal(stsRequests, before + 1, "only the deployment's own installer can end the change")
    const gone = await enroll(prepared.id, waiting)
    assert.equal(gone.status, 404, summary(gone))

    for (let sequence = 2; sequence <= 6; sequence += 1) assert.equal((await report(started.id, running.runId, token, sequence)).status, 200)
    const finished = await view(started.id)
    assert.equal(field(finished, "ownerEmail"), "first.admin@example.com", "the customer approved it and AWS changed, so the record follows")
    assert.equal(field(finished, "run", "state"), "ready")
    assert.equal(field(finished, "configuration"), undefined)
  } finally {
    assert.equal((await den.setFeature(org.orgId, "managedDeploymentConfigUpdates", true)).status, 200)
  }
  const restored = await view(prepared.id)
  assert.equal(field(restored, "run", "id"), prepared.baseRunId)
  assert.equal(field(restored, "ownerEmail"), "admin@example.com")
  assert.equal(field(restored, "configuration", "change"), null)
  assert.equal(field(restored, "configuration", "lock"), null)
})

test("a Google Cloud deployment cannot be edited after installation", async () => {
  const id = randomUUID()
  await db.insert(ManagedDeploymentTable).values({
    id, org_id: organizationId, provider: "gcp", name: "Google Cloud fixture", domain_name: "openwork.example.com", owner_email: "admin@example.com", size: "small", installed_version: "1.0.1",
    target: { projectId: "openwork-test", projectNumber: ACCOUNT, region: "us-central1", dnsZoneName: "example-com" },
  })
  const shown = await view(id)
  assert.equal(field(shown, "configuration", "lock"), "aws_only")
  const call = await owner("POST", `/v1/managed-deployments/${id}/configuration-changes`, { expectedRevision: field(shown, "configuration", "revision"), configuration: { ...createInput, ownerEmail: "first.admin@example.com" } })
  refused(call, 400, "configuration_aws_only")
})

test("another workspace's owner and a member without deployment access cannot prepare a change", async () => {
  const { id, baseRunId, path } = await installed()
  const shown = await view(id)
  const body = { expectedRevision: field(shown, "configuration", "revision"), configuration: { ...draft(shown), ownerEmail: "first.admin@example.com" } }
  const outsider = await den.as(foreign.owner, foreign.orgId)("POST", path, body)
  refused(outsider, 404, "deployment_not_found")
  const teammate = await den.as(member, org.orgId)("POST", path, body)
  assert.equal(teammate.status, 403, summary(teammate))
  assert.equal(field(await view(id), "run", "id"), baseRunId)
})

test("the recorded email changes only when the approved run verifies health; a failed run and a replaced run change nothing", async () => {
  const { id } = await installed()
  const prepared = handoff(await change(id, email("first.admin@example.com")))
  const enrollment = await enroll(id, prepared)
  assert.equal(enrollment.status, 200, summary(enrollment))
  const token = text(field(enrollment.body, "token"), "run token")
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    assert.equal((await report(id, prepared.runId, token, sequence)).status, 200)
    const during = await view(id)
    assert.equal(field(during, "ownerEmail"), "admin@example.com", `milestone ${sequence} records nothing`)
    assert.equal(field(during, "configuration", "change", "state"), "applying")
  }
  const repeated = await report(id, prepared.runId, token, 5)
  assert.equal(repeated.status, 200, summary(repeated))
  const verified = await report(id, prepared.runId, token, 6)
  assert.equal(verified.status, 200, summary(verified))
  const applied = await view(id)
  assert.equal(field(applied, "ownerEmail"), "first.admin@example.com")
  assert.equal(field(applied, "installedVersion"), published.version)
  assert.equal(field(applied, "run", "state"), "ready")
  assert.equal(field(applied, "run", "kind"), "configure")
  assert.equal(field(applied, "configuration", "change"), null)
  assert.equal(field(applied, "configuration", "lock"), null)
  assert.equal(field(applied, "configuration", "gatewayAvailable"), true)
  assert.equal((await report(id, prepared.runId, token, 6)).status, 200, "the installer may repeat its last report")
  const conflicting = await report(id, prepared.runId, token, 6, "health_check_failed")
  assert.equal(conflicting.status, 409, summary(conflicting))
  assert.equal(field(conflicting.body, "error"), "event_sequence_conflict")
  assert.equal((await report(id, prepared.runId, "x".repeat(43), 6)).status, 401)
  assert.equal(field(await view(id), "ownerEmail"), "first.admin@example.com")

  // The applied run is now what a later change re-runs; this one fails in AWS.
  const failing = handoff(await change(id, email("second.admin@example.com")))
  assert.equal(failing.templateUrl, published.templateUrl)
  const failingToken = await enrolled(failing.runId)
  for (let sequence = 1; sequence <= 3; sequence += 1) assert.equal((await report(id, failing.runId, failingToken, sequence)).status, 200)
  assert.equal((await report(id, failing.runId, failingToken, 4, "infrastructure_failed")).status, 200)
  const failed = await view(id)
  assert.equal(field(failed, "ownerEmail"), "first.admin@example.com", "a failed run records nothing")
  assert.equal(field(failed, "run", "state"), "failed")
  assert.equal(field(failed, "configuration", "change", "state"), "failed")
  assert.equal(field(failed, "configuration", "change", "requested", "ownerEmail"), "second.admin@example.com")
  assert.equal(field(failed, "configuration", "lock"), null, "the owner can review and try again")
  assert.equal((await report(id, failing.runId, failingToken, 5)).status, 409, "a failed run accepts no further milestones")

  // A run that stopped reporting is replaced by the next change; its token then reports to nothing.
  const stalled = handoff(await change(id, email("third.admin@example.com")))
  const stalledToken = await enrolled(stalled.runId)
  assert.equal((await report(id, stalled.runId, stalledToken, 1)).status, 200)
  await db.update(ManagedDeploymentRunTable).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(ManagedDeploymentRunTable.id, stalled.runId))
  assert.equal(field(await view(id), "configuration", "change", "state"), "failed")
  const replacement = handoff(await change(id, email("fourth.admin@example.com")))
  await db.update(ManagedDeploymentRunTable).set({ expires_at: new Date(Date.now() + DAY) }).where(eq(ManagedDeploymentRunTable.id, stalled.runId))
  const late = await report(id, stalled.runId, stalledToken, 2)
  assert.equal(late.status, 404, summary(late))
  assert.equal(field(late.body, "error"), "deployment_not_found")
  const after = await view(id)
  assert.equal(field(after, "ownerEmail"), "first.admin@example.com")
  assert.equal(field(after, "run", "id"), replacement.runId)
  assert.equal(field(after, "run", "state"), "awaiting_approval")
})

test("a final milestone that arrives while its run is being replaced records nothing", async () => {
  const { id, baseRunId } = await installed()
  const prepared = handoff(await change(id, email("first.admin@example.com")))
  const token = await enrolled(prepared.runId)
  for (let sequence = 1; sequence <= 5; sequence += 1) assert.equal((await report(id, prepared.runId, token, sequence)).status, 200)
  // Hold the deployment as a launch or another change does while it replaces the active run:
  // the report has already read the run as active and now waits for the row.
  const late = await db.transaction(async (tx) => {
    await tx.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, id)).for("update")
    const waiting = report(id, prepared.runId, token, 6)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await tx.update(ManagedDeploymentTable).set({ active_run_id: baseRunId }).where(eq(ManagedDeploymentTable.id, id))
    return { waiting }
  })
  const answer = await late.waiting
  assert.ok(answer.status === 401 || answer.status === 404, summary(answer))
  const shown = await view(id)
  assert.equal(field(shown, "ownerEmail"), "admin@example.com")
  assert.equal(field(shown, "run", "id"), baseRunId)
  await db.update(ManagedDeploymentTable).set({ active_run_id: prepared.runId }).where(eq(ManagedDeploymentTable.id, id))
  const replaced = await view(id)
  assert.equal(field(replaced, "run", "state"), "provisioning", "the milestone was not recorded on the run either")
  assert.equal(list(field(replaced, "run", "events")).length, 5)
})

test("an Update prepared since the last successful run blocks configuration changes until it is finished", async () => {
  const { id, baseRunId } = await installed({ release: older })
  const update = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "update" })
  assert.equal(update.status, 200, summary(update))
  const updateRunId = text(field(update.body, "deployment", "run", "id"), "Update run")
  assert.equal(field(await view(id), "configuration", "lock"), "run_in_progress")
  refused(await change(id, email("first.admin@example.com")), 409, "run_in_progress")

  await db.update(ManagedDeploymentRunTable).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(ManagedDeploymentRunTable.id, updateRunId))
  assert.equal(field(await view(id), "configuration", "lock"), "unfinished_run")
  refused(await change(id, email("first.admin@example.com")), 409, "unfinished_run")

  await db.update(ManagedDeploymentRunTable).set({ state: "failed", expires_at: new Date(Date.now() + DAY) }).where(eq(ManagedDeploymentRunTable.id, updateRunId))
  refused(await change(id, email("first.admin@example.com")), 409, "unfinished_run")
  assert.equal(field(await view(id), "run", "id"), updateRunId)
  assert.notEqual(updateRunId, baseRunId)
})

test("a deployment that was never installed, or whose installer is unknown, cannot be edited", async () => {
  const created = await owner("POST", "/v1/managed-deployments", createInput)
  const id = text(field(created.body, "id"), "deployment ID")
  assert.equal(field(await view(id), "configuration", "lock"), "not_installed")
  refused(await change(id, email("first.admin@example.com")), 409, "not_installed")
  const launched = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "install" })
  assert.equal(launched.status, 200, summary(launched))
  refused(await change(id, email("first.admin@example.com")), 409, "not_installed")

  // Recorded as installed with no run that verified health: nothing says which installer to re-run.
  await db.update(ManagedDeploymentTable).set({ installed_version: published.version }).where(eq(ManagedDeploymentTable.id, id))
  await db.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.deployment_id, id))
  assert.equal(field(await view(id), "configuration", "lock"), "installer_unknown")
  refused(await change(id, email("first.admin@example.com")), 409, "installer_unknown")
})

test("the launch route never prepares a configuration change and Retry after a failed change re-applies the recorded email", async () => {
  const { id } = await installed({ release: older })
  const launch = `/v1/managed-deployments/${id}/launch`
  const configure = await owner("POST", launch, { kind: "configure" })
  assert.equal(configure.status, 400, summary(configure))
  const prepared = handoff(await change(id, email("first.admin@example.com")))
  for (const kind of ["retry", "update"]) {
    const blocked = await owner("POST", launch, { kind })
    assert.equal(blocked.status, 409, summary(blocked))
    assert.equal(field(blocked.body, "error"), "deployment_run_in_progress")
  }
  const token = await enrolled(prepared.runId)
  assert.equal((await report(id, prepared.runId, token, 1, "runner_failed")).status, 200)
  const retry = await owner("POST", launch, { kind: "retry" })
  assert.equal(retry.status, 200, summary(retry))
  assert.equal(field(retry.body, "kind"), "retry")
  const command = text(field(retry.body, "command"), "Retry command")
  assert.ok(command.includes(JSON.stringify({ ParameterKey: "OwnerEmail", ParameterValue: "admin@example.com" })))
  assert.ok(!command.includes("first.admin@example.com"))
  assert.ok(command.includes(JSON.stringify({ ParameterKey: "OpenWorkVersion", ParameterValue: published.version })), "Retry stays pinned to the published release")
  assert.equal(field(retry.body, "deployment", "ownerEmail"), "admin@example.com")
  assert.equal(field(retry.body, "deployment", "configuration", "lock"), "run_in_progress")
})

test("two different concurrent requests prepare exactly one change", async () => {
  const { id } = await installed()
  const shown = await view(id)
  const body = (ownerEmail: string) => ({ expectedRevision: field(shown, "configuration", "revision"), configuration: { ...draft(shown), ownerEmail } })
  const attempts = await Promise.all([
    owner("POST", `/v1/managed-deployments/${id}/configuration-changes`, body("first.admin@example.com")),
    owner("POST", `/v1/managed-deployments/${id}/configuration-changes`, body("second.admin@example.com")),
  ])
  assert.deepEqual(attempts.map((call) => call.status).sort(), [200, 409])
  const lost = attempts.find((call) => call.status === 409)
  assert.equal(field(lost?.body, "error"), "configuration_changed")
  const won = attempts.find((call) => call.status === 200)
  assert.ok(won)
  const after = await view(id)
  assert.equal(field(after, "run", "id"), field(won.body, "deployment", "run", "id"))
  assert.equal(field(after, "configuration", "change", "requested", "ownerEmail"), field(list(field(won.body, "changes"))[0], "after"))
  assert.deepEqual(den.production?.concurrentStatements ?? [], [])
})

test("a historical record keeps the parameters its installer template has, in the command and after the change is applied", async () => {
  const { id } = await installed()
  const prepared = handoff(await change(id, email("first.admin@example.com")))
  assert.equal(prepared.parameters.get("OwnerEmail"), "first.admin@example.com")
  for (const absent of ["ManagedRuntimeProfile", "HeadlessRunnerEnabled", "HeadlessComputerProvider"]) assert.equal(prepared.parameters.has(absent), false, `${absent} is not sent`)
  const token = await enrolled(prepared.runId)
  for (let sequence = 1; sequence <= 6; sequence += 1) assert.equal((await report(id, prepared.runId, token, sequence)).status, 200)
  assert.equal(field(await view(id), "ownerEmail"), "first.admin@example.com")
  const retry = await owner("POST", `/v1/managed-deployments/${id}/launch`, { kind: "retry" })
  assert.equal(retry.status, 200, summary(retry))
  const command = text(field(retry.body, "command"), "Retry command")
  assert.ok(command.includes(JSON.stringify({ ParameterKey: "OwnerEmail", ParameterValue: "first.admin@example.com" })))
  assert.ok(!command.includes("ManagedRuntimeProfile") && !command.includes("HeadlessRunnerEnabled"), "applying the change did not rewrite the stored target")
})

test("a change re-runs the installed installer, not the published one, and only when it can be run as it was installed", async () => {
  const { id } = await installed({ release: older })
  const shown = await view(id)
  assert.equal(field(shown, "availableVersion"), published.version)
  assert.equal(field(shown, "updateAvailable"), true)
  assert.equal(field(shown, "configuration", "lock"), null)
  const { command, parameters, templateUrl } = handoff(await change(id, email("first.admin@example.com")))
  assert.equal(parameters.get("OpenWorkVersion"), older.version)
  assert.equal(parameters.get("BundleUrl"), older.bundleUrl)
  assert.equal(parameters.get("BundleSha256"), older.bundleSha256)
  assert.equal(templateUrl, older.templateUrl)
  for (const current of [published.version, published.templateUrl, published.bundleUrl, published.bundleSha256]) assert.ok(!command.includes(current), `${current} is not in the command`)
  const pending = await view(id)
  assert.equal(field(pending, "run", "version"), older.version)
  assert.equal(field(pending, "installedVersion"), older.version)

  const movable = await installed({ release: { ...older, templateUrl: `${SOURCE}${older.version}/cloudformation.json` } })
  assert.equal(field(await view(movable.id), "configuration", "lock"), "installer_unavailable")
  refused(await change(movable.id, email("first.admin@example.com")), 409, "installer_unavailable")
  assert.equal(field(await view(movable.id), "run", "id"), movable.baseRunId)
})

test("a request, a rename and a withdrawal are audited; milestones are recorded on the run", async () => {
  const { id } = await installed({ target: gatewayTarget })
  const prepared = handoff(await change(id, (current) => ({ ...current, name: "Audited deployment", target: { ...current.target, assistants: daytona } })))
  assert.equal(field(await change(id, unchanged), "body", "outcome"), "withdrawn")
  const audit = den.as(org.owner, org.orgId)
  async function events(action: string) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const listed = await audit("GET", `/v1/audit/operations?limit=50&action=${encodeURIComponent(action)}`)
      assert.equal(listed.status, 200, summary(listed))
      for (const operation of list(field(listed.body, "operations"))) {
        const read = await audit("GET", `/v1/audit/operations/${String(operation.id)}/events?limit=50`)
        assert.equal(read.status, 200, summary(read))
        const found = list(field(read.body, "events")).find((event) => event.action === action && list(event.resources).some((resource) => resource.type === "managed_deployment" && resource.id === id))
        if (found) return found
      }
      assert.ok(Date.now() < deadline, `${action} was recorded for the deployment`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const requested = await events("managed_deployment.configuration_change_requested")
  assert.deepEqual(field(requested, "changes", "changedFields"), ["computerProvider", "computerSecretArn", "computerSnapshot"])
  assert.equal(field(requested, "changes", "before", "computerProvider"), "off")
  assert.equal(field(requested, "changes", "after", "computerProvider"), "daytona")
  assert.equal(field(requested, "changes", "after", "computerSecretArn"), computerSecretArn)
  assert.equal(field(requested, "changes", "after", "runId"), prepared.runId)
  assert.equal(field(requested, "changes", "after", "installerVersion"), published.version)
  const renamed = await events("managed_deployment.renamed")
  assert.deepEqual(field(renamed, "changes", "changedFields"), ["name"])
  assert.equal(field(renamed, "changes", "after", "name"), "Audited deployment")
  const withdrawn = await events("managed_deployment.configuration_change_withdrawn")
  assert.equal(field(withdrawn, "changes", "before", "computerProvider"), "daytona")
  assert.equal(field(withdrawn, "changes", "after", "computerProvider"), "off")
  assert.equal(field(withdrawn, "changes", "after", "runId"), prepared.runId)
})
