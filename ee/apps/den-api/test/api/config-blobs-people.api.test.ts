/**
 * People references for callers who may not read the member directory
 * (format.md › People): a member who can view and manage desktop policies
 * and AI providers, but not the `members.people` area (`teams.view`), and a
 * config token limited to those areas, get assignments and grants as
 * `people/<member id>` with no email or name, in exports, dry runs, plans,
 * summaries and reports. A same-organization re-import of such an export
 * changes nothing; in another organization the ids stay unresolved (choose
 * or drop, never silently removed). Callers who may read people keep emails.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, isRecord, list, summary, text, type Call, type Method } from "./harness.js"

const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => {
  restoreFetch()
  await den.close()
})
const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")

type Api = (method: Method, pathname: string, body?: unknown) => Promise<Call>

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

function asBlob(value: unknown): ConfigBlob {
  assert.ok(isRecord(value) && value.format === "openwork.config-blob", "a config blob")
  return JSON.parse(JSON.stringify(value))
}

function asPlan(value: unknown): ConfigPlan {
  assert.ok(isRecord(value) && typeof value.planHash === "string", "a plan")
  return JSON.parse(JSON.stringify(value))
}

function asSummary(value: unknown): ConfigChangeRequestSummary {
  assert.ok(isRecord(value) && typeof value.id === "string", "a change request")
  return JSON.parse(JSON.stringify(value))
}

function planItems(plan: ConfigPlan): ConfigPlanItem[] {
  return plan.areas.flatMap((area) => area.items)
}

function areaItems(blob: ConfigBlob, key: string): Array<{ id?: string; name: string; spec: Record<string, unknown> }> {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  const items = isRecord(node) && Array.isArray(node.items) ? node.items : []
  return JSON.parse(JSON.stringify(items))
}

async function settle(api: Api, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(field((await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "detail")).body, "changeRequest"))
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

const owner = await den.signUp("People Owner")
const org = await den.createOrg(owner, "People redaction")
const other = await den.createOrg(owner, "People elsewhere")
for (const id of [org.orgId, other.orgId]) assert.equal((await den.setFeature(id, "configBlobs", true)).status, 200)
const ownerApi = den.as(owner, org.orgId)
const person = await den.newMember(owner, org.orgId, "Grace Grantee")
const reviewer = await den.newMember(owner, org.orgId, "Rita Reviewer")
const reviewers = await den.createTeam(owner, org.orgId, "Reviewers", [reviewer.memberId])
await ok(ownerApi("POST", "/v1/permissions/sets", {
  name: "Policies and providers",
  teamIds: [reviewers],
  permissions: ["desktop_policies.view", "desktop_policies.manage", "gateway_providers.view", "gateway_providers.manage"].map((key) => ({ key, status: "allow" })),
}), "role")
const reviewerApi: Api = den.as(reviewer, org.orgId)

// A desktop policy assigned to the person, and an AI provider with a grant to them.
await ok(ownerApi("POST", "/v1/desktop-policies", { policyName: "Grace's policy", policy: { execution: { commands: "allow" } }, priority: 5, teamIds: [], memberIds: [person.memberId], roles: [] }), "desktop policy")
const provider = await ok(ownerApi("POST", "/v1/inference-providers", { name: "People OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] }), "provider")
const providerId = text(field(provider.body, "inferenceProvider", "id"), "provider id")
const group = await ok(ownerApi("POST", `/v1/inference-providers/${providerId}/model-groups`, { name: "Luna", modelIds: ["gpt-6-luna"] }), "model group")
const set = await ok(ownerApi("POST", `/v1/inference-providers/${providerId}/credential-sets`, { name: "Shared key", credentialMode: "org", credential: { kind: "api_key", secret: "sk-people-fixture-secret-0001" } }), "credential set")
await ok(ownerApi("POST", `/v1/inference-providers/${providerId}/access-grants`, {
  modelGroupId: text(field(group.body, "modelGroup", "id"), "group id"),
  credentialSetId: text(field(set.body, "credentialSet", "id"), "set id"),
  audience: { type: "member", memberId: person.memberId },
}), "member grant")

const AREAS = "desktop-policies,ai-gateway.providers"
const personRef = `people/${person.memberId}`

function assertNoPerson(value: unknown, label: string): void {
  const json = JSON.stringify(value)
  assert.ok(!json.toLowerCase().includes(person.email.toLowerCase()), `${label} holds the person's email`)
  assert.ok(!json.includes(person.name), `${label} holds the person's name`)
}

function policyMembers(blob: ConfigBlob): unknown {
  return areaItems(blob, "desktop-policies").find((item) => item.name === "Grace's policy")?.spec.assignments
}

let redacted: ConfigBlob

test("the export of a caller without the member directory carries member ids, never emails or names", async () => {
  const areas = await ok(reviewerApi("GET", "/v1/config-blobs/areas"), "areas")
  const people = list(field(areas.body, "areas")).find((entry) => entry.key === "members.people")
  assert.equal(field(people, "canExport"), false, "the reviewer can't export members.people")

  redacted = asBlob((await ok(reviewerApi("GET", `/v1/config-blobs/export?areas=${AREAS}`), "reviewer export")).body)
  assertNoPerson(redacted, "the reviewer's export")
  assert.deepEqual(field(policyMembers(redacted), "members"), [{ $ref: personRef }])
  const grants = areaItems(redacted, "ai-gateway.providers").find((item) => item.id === providerId)?.spec.access
  assert.ok(Array.isArray(grants) && grants.some((grant) => isRecord(grant) && isRecord(grant.member) && grant.member.$ref === personRef && grant.member.name === undefined), JSON.stringify(grants))

  const full = asBlob((await ok(ownerApi("GET", `/v1/config-blobs/export?areas=${AREAS}`), "owner export")).body)
  assert.deepEqual(field(policyMembers(full), "members"), [{ $ref: `people/${person.email.toLowerCase()}` }])
  assert.ok(JSON.stringify(full).includes(person.name), "the owner sees the grantee's name hint")
  // Redaction never moves revs: both exports describe the same state.
  assert.equal(redacted.baseHash, full.baseHash)
})

test("a config token limited to those areas gets member ids too", async () => {
  const created = await ok(ownerApi("POST", "/v1/api-keys", { name: "Policies CI", type: "config", scopes: ["config:export", "config:submit"], areas: ["desktop-policies", "ai-gateway.providers"] }), "token")
  const key = text(field(created.body, "key"), "token")
  const exported = await den.request(null, "GET", `/v1/config-blobs/export?areas=${AREAS}`, { headers: { "x-api-key": key } })
  assert.equal(exported.status, 200, summary(exported))
  assertNoPerson(exported.body, "the token's export")
  assert.deepEqual(field(policyMembers(asBlob(exported.body)), "members"), [{ $ref: personRef }])
})

test("re-importing the redacted export into the same organization changes nothing", async () => {
  const dryRun = await ok(reviewerApi("POST", "/v1/config-blobs/change-requests?dryRun=true", { blob: redacted, mode: "merge" }), "dry run")
  assertNoPerson(dryRun.body, "the dry run")
  const plan = asPlan(field(dryRun.body, "plan"))
  assert.equal(plan.summary.blocking, 0, JSON.stringify(plan))
  const changed = planItems(plan).filter((item) => item.op !== "unchanged")
  assert.deepEqual(changed, [], "nothing to do")

  // Mirror mode too: the assignment is never planned away.
  const submitted = await ok(reviewerApi("POST", "/v1/config-blobs/change-requests", { blob: redacted, mode: "mirror" }), "submit")
  const request = await settle(reviewerApi, text(field(submitted.body, "changeRequest", "id"), "request id"))
  assert.equal(request.status, "needs_review", JSON.stringify(request))
  const stored = await ok(reviewerApi("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")
  assertNoPerson(stored.body, "the stored plan")
  const mirrored = asPlan(field(stored.body, "plan"))
  assert.equal(mirrored.summary.blocking, 0)
  assert.deepEqual(planItems(mirrored).filter((item) => item.op !== "unchanged").map((item) => `${item.area} ${item.op}`), [])
  const policy = planItems(mirrored).find((item) => item.target?.name === "Grace's policy")
  assert.equal(policy?.op, "unchanged", JSON.stringify(policy))
  await ok(reviewerApi("POST", `/v1/config-blobs/change-requests/${request.id}/cancel`, {}), "cancel")
})

test("plans, summaries and reports hide people from reviewers who may not read them, and keep them for those who may", async () => {
  const full = asBlob((await ok(ownerApi("GET", "/v1/config-blobs/export?areas=desktop-policies"), "owner export")).body)
  const policies = areaItems(full, "desktop-policies").map((item) => (item.name === "Grace's policy" ? { ...item, spec: { ...item.spec, assignments: { roles: [], teams: [], members: [] } } } : item))
  let node: unknown = full.areas
  node = isRecord(node) ? node["desktop-policies"] : undefined
  assert.ok(isRecord(node))
  node.items = policies
  const submitted = await ok(ownerApi("POST", "/v1/config-blobs/change-requests", { blob: full, mode: "merge", title: "Unassign Grace" }), "submit")
  const id = text(field(submitted.body, "changeRequest", "id"), "request id")
  await settle(ownerApi, id)

  const forOwner = asPlan(field((await ok(ownerApi("GET", `/v1/config-blobs/change-requests/${id}/plan`), "owner plan")).body, "plan"))
  const ownerItem = planItems(forOwner).find((item) => item.op === "update")
  assert.ok(JSON.stringify(ownerItem?.fields).includes(person.email.toLowerCase()), JSON.stringify(ownerItem))

  const reviewerPlan = await ok(reviewerApi("GET", `/v1/config-blobs/change-requests/${id}/plan`), "reviewer plan")
  assertNoPerson(reviewerPlan.body, "the reviewer's plan")
  const reviewerItem = planItems(asPlan(field(reviewerPlan.body, "plan"))).find((item) => item.op === "update")
  assert.ok(JSON.stringify(reviewerItem?.fields).includes(personRef), JSON.stringify(reviewerItem))
  const plan = asPlan(field(reviewerPlan.body, "plan"))

  // The reviewer approves (fresh sign-in) and applies; the report and the before-snapshot stay redacted.
  await ok(reviewerApi("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  const applied = await settle(reviewerApi, id)
  assert.equal(applied.status, "applied", JSON.stringify(applied))
  const detail = await ok(reviewerApi("GET", `/v1/config-blobs/change-requests/${id}`), "detail")
  assertNoPerson(detail.body, "the reviewer's detail and report")
  const snapshot = await ok(reviewerApi("GET", `/v1/config-blobs/change-requests/${id}/before-snapshot`), "snapshot")
  assertNoPerson(snapshot.body, "the reviewer's before-snapshot")
  assert.ok(JSON.stringify(snapshot.body).includes(personRef))
  const list = await ok(reviewerApi("GET", "/v1/config-blobs/change-requests?state=closed"), "list")
  assertNoPerson(list.body, "the reviewer's list")
  const ownerSnapshot = await ok(ownerApi("GET", `/v1/config-blobs/change-requests/${id}/before-snapshot`), "owner snapshot")
  assert.ok(JSON.stringify(ownerSnapshot.body).includes(person.email.toLowerCase()), "the owner's snapshot keeps emails")
})

test("in another organization a member id is unresolved: choose or drop, never removed silently", async () => {
  const otherApi = den.as(owner, other.orgId)
  const dryRun = await ok(otherApi("POST", "/v1/config-blobs/change-requests?dryRun=true", { blob: redacted, mode: "merge" }), "dry run elsewhere")
  const plan = asPlan(field(dryRun.body, "plan"))
  const policy = planItems(plan).find((item) => item.blob?.name === "Grace's policy")
  assert.ok(policy?.flags.includes("ref_unresolved"), JSON.stringify(policy))
  assert.ok(plan.summary.blocking > 0)
  const ref = policy?.refs?.find((entry) => entry.ref === personRef)
  assert.equal(ref?.resolvedId, null, JSON.stringify(policy?.refs))
})

test("summaries drop creator and approver names for callers who may not read people; member ids stay", async () => {
  const closed = await ok(reviewerApi("GET", "/v1/config-blobs/change-requests?state=closed"), "reviewer list")
  const requests = list(field(closed.body, "changeRequests")).map(asSummary)
  const appliedRequest = requests.find((request) => request.title === "Unassign Grace")
  assert.ok(appliedRequest, JSON.stringify(requests.map((request) => request.title)))
  assert.equal(appliedRequest.createdBy.memberId !== null, true)
  assert.equal(appliedRequest.createdBy.name, null)
  assert.ok(appliedRequest.approvals.length > 0 && appliedRequest.approvals.every((approval) => approval.name === null && approval.memberId.length > 0))
  const detail = await ok(reviewerApi("GET", `/v1/config-blobs/change-requests/${appliedRequest.id}`), "reviewer detail")
  assert.equal(field(detail.body, "changeRequest", "createdBy", "name"), null)
  assert.equal(field(detail.body, "report", "requestedBy", "name"), null)
  assert.equal(field(detail.body, "report", "runsAs", "name"), null)
  for (const name of [owner.name, reviewer.name]) assert.ok(!JSON.stringify([closed.body, detail.body]).includes(name), `${name} shown to the reviewer`)

  const forOwner = await ok(ownerApi("GET", `/v1/config-blobs/change-requests/${appliedRequest.id}`), "owner detail")
  assert.equal(field(forOwner.body, "changeRequest", "createdBy", "name"), owner.name)
})

test("a config token whose areas leave out members.people can't plan, approve or apply an invitation", async () => {
  const created = await ok(ownerApi("POST", "/v1/api-keys", { name: "Policies applier", type: "config", scopes: ["config:export", "config:submit", "config:apply"], areas: ["desktop-policies"] }), "token")
  const key = text(field(created.body, "key"), "token")
  const token: Api = (method, pathname, body) => den.request(null, method, pathname, { body, headers: { "x-api-key": key } })

  const blob = asBlob((await ok(ownerApi("GET", "/v1/config-blobs/export?areas=desktop-policies"), "owner export")).body)
  const policies = areaItems(blob, "desktop-policies").map((item) => (item.name === "Grace's policy" ? { ...item, spec: { ...item.spec, assignments: { roles: [], teams: [], members: [{ $ref: "people/invitee-by-token@example.test" }] } } } : item))
  const node = isRecord(blob.areas) ? blob.areas["desktop-policies"] : undefined
  assert.ok(isRecord(node))
  node.items = policies
  const policyRef = policies.find((item) => item.name === "Grace's policy")?.id
  assert.ok(policyRef)
  const invite = { matches: [], refs: [{ area: "desktop-policies", ref: policyRef, path: "assignments.members[0]", resolution: { invite: true } }], deletes: [], overrides: [], skips: [], renames: [], people: { sendInviteEmails: false } }

  // Uploaded by the token: choosing to invite is refused, and nothing invites on its own.
  const mine = asSummary(field((await ok(token("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title: "Token invite" }), "token submit")).body, "changeRequest"))
  await settle(token, mine.id)
  const refused = await token("PUT", `/v1/config-blobs/change-requests/${mine.id}/decisions`, invite)
  assert.equal(refused.status, 403, summary(refused))
  assert.deepEqual(field(refused.body, "areas"), ["members.people"])
  const tokenPlan = asPlan(field((await ok(token("GET", `/v1/config-blobs/change-requests/${mine.id}/plan`), "token plan")).body, "plan"))
  assert.ok(planItems(tokenPlan).every((item) => item.area !== "members.people"), JSON.stringify(tokenPlan))
  await ok(token("POST", `/v1/config-blobs/change-requests/${mine.id}/cancel`, {}), "cancel")

  // Uploaded by the owner, who chose to invite: the token can't approve or apply the invitation.
  const owners = asSummary(field((await ok(ownerApi("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title: "Owner invite" }), "owner submit")).body, "changeRequest"))
  await settle(ownerApi, owners.id)
  const decided = await ok(ownerApi("PUT", `/v1/config-blobs/change-requests/${owners.id}/decisions`, invite), "owner decides")
  const plan = asPlan(field(decided.body, "plan"))
  assert.ok(planItems(plan).some((item) => item.area === "members.people" && item.op === "create"), JSON.stringify(plan))
  for (const action of ["approve", "apply"]) {
    const denied = await token("POST", `/v1/config-blobs/change-requests/${owners.id}/${action}`, { planHash: plan.planHash })
    assert.equal(denied.status, 403, `${action}: ${summary(denied)}`)
    assert.deepEqual(field(denied.body, "areas"), ["members.people"])
  }
  await ok(ownerApi("POST", `/v1/config-blobs/change-requests/${owners.id}/cancel`, {}), "cancel owner's")
})
