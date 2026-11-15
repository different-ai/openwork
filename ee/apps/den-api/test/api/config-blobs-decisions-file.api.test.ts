/**
 * Config blobs: the answers of one import carry over to a later import of the
 * same source into the same organization, as a file (`configImportDecisionsFile`).
 *
 * The first import leaves a person out and with them every reference to
 * them, and skips a spend limit whose provider is not here. Its answers are
 * downloaded; the same export is uploaded again and given the file: nothing
 * is asked and nothing is written. A file of another organization or another
 * source is refused, and a replayed "leave it out" on a reference an item
 * can't be imported without is refused in the plan like one given by hand.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { configDecisionsFileSchema, type ConfigApplyReport, type ConfigBlob, type ConfigChangeRequestSummary, type ConfigDecisionsFile, type ConfigPlan, type ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, isRecord, summary, text, type Call, type Member, type Session } from "./harness.js"

const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => {
  restoreFetch()
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")

const AREAS = "members.people,plugins.plugins,plugins.skills,ai-gateway.limits"
const FEATURE = "configImportDecisionsFile"
const BLOCKING = ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked", "needs_input"]
const skillMarkdown = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill of the answers-file import.\n---\n\n${body}\n`

type Api = ReturnType<typeof den.as>

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

function asBlob(value: unknown): ConfigBlob {
  assert.ok(isRecord(value) && value.format === "openwork.config-blob", "a config blob")
  return JSON.parse(JSON.stringify(value))
}

function asSummary(call: Call): ConfigChangeRequestSummary {
  const value = field(call.body, "changeRequest")
  assert.ok(isRecord(value) && typeof value.id === "string", summary(call))
  return JSON.parse(JSON.stringify(value))
}

function asPlan(value: unknown): ConfigPlan {
  assert.ok(isRecord(value) && typeof value.planHash === "string", "a plan")
  return JSON.parse(JSON.stringify(value))
}

const planItems = (plan: ConfigPlan): ConfigPlanItem[] => plan.areas.flatMap((area) => area.items)
const nameOf = (item: ConfigPlanItem) => item.blob?.name ?? item.target?.name ?? ""
const label = (item: ConfigPlanItem) => `${item.area}:${nameOf(item)}:${item.op}`
const writes = (plan: ConfigPlan) => planItems(plan).filter((item) => ["create", "update", "rename", "delete"].includes(item.op))
const blocking = (plan: ConfigPlan) => planItems(plan).filter((item) => item.flags.some((flag) => BLOCKING.includes(flag)))

function describe(items: readonly ConfigPlanItem[]): string {
  return JSON.stringify(items.map((item) => ({ area: item.area, name: nameOf(item), op: item.op, tier: item.matchedBy, flags: item.flags, reasons: item.reasons, fields: item.fields.map((change) => change.path) })), null, 1)
}


async function drive(api: Api, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "change request"))
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function upload(api: Api, blob: ConfigBlob, title: string): Promise<{ id: string; plan: ConfigPlan }> {
  const request = asSummary(await ok(api("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title }), "upload"))
  const analyzed = await drive(api, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  return { id: request.id, plan: asPlan(field((await ok(api("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan")) }
}

async function apply(person: Session, orgId: string, id: string, plan: ConfigPlan): Promise<ConfigApplyReport> {
  const api = den.as(person, orgId)
  const queued = await ok(api("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  assert.equal(asSummary(queued).status, "queued")
  const settled = await drive(api, id)
  const detail = await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "detail")
  const runs: ConfigApplyReport[] = JSON.parse(JSON.stringify(field(detail.body, "runs") ?? []))
  const run = runs[0]
  assert.ok(run, "one run")
  assert.equal(settled.status, "applied", `${JSON.stringify(settled.errors)}\n${JSON.stringify(run.items.filter((entry) => entry.status === "failed"), null, 1)}`)
  assert.equal(run.counts.failed, 0)
  return run
}

function item(plan: ConfigPlan, area: string, name: string): ConfigPlanItem {
  const found = planItems(plan).find((entry) => entry.area === area && nameOf(entry) === name)
  assert.ok(found, `${area} "${name}" is in the plan`)
  return found
}

type Answers = {
  skips: Array<{ area: string; ref: string }>
  refs: Array<{ area: string; ref: string; path: string; resolution: { drop: true } }>
}

const reasons = (entry: ConfigPlanItem) => (entry.reasons ?? []).join("\n")

async function decide(api: Api, id: string, body: unknown): Promise<ConfigPlan> {
  return asPlan(field((await ok(api("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, body), "decisions")).body, "plan"))
}

/** The answers an admin gives by hand: these items are left out, and then every reference nothing here answers. */
async function answerByHand(api: Api, id: string, plan: ConfigPlan, leftOut: ConfigPlanItem[]): Promise<ConfigPlan> {
  const answers: Answers = { skips: leftOut.map((entry) => ({ area: entry.area, ref: entry.ref })), refs: [] }
  const waiting = await decide(api, id, answers)
  answers.refs = planItems(waiting)
    .filter((entry) => entry.flags.includes("ref_unresolved"))
    .flatMap((entry) => (entry.refs ?? [])
      .filter((ref) => ref.resolvedId === null && !ref.via)
      .map((ref) => ({ area: entry.area, ref: entry.ref, path: ref.path, resolution: { drop: true as const } })))
  return answers.refs.length > 0 ? decide(api, id, answers) : waiting
}

async function answersOf(api: Api, id: string): Promise<ConfigDecisionsFile> {
  const call = await ok(api("GET", `/v1/config-blobs/change-requests/${id}/decisions`), "answers file")
  return configDecisionsFileSchema.parse(call.body)
}

// ---------------------------------------------------------------------------
// The source: a plugin and a skill shared with one person, and a limit on one provider's spending.

const ada = await den.signUp("Ada Owner")
const source = await den.createOrg(ada, "Answers source")
const apiA = den.as(ada, source.orgId)
const cal: Member = await den.newMember(ada, source.orgId, "Cal Member")

const plugin = await ok(apiA("POST", "/v1/plugins", { name: "Field notes", description: "Notes from the field" }), "plugin")
const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
await ok(apiA("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: cal.memberId, role: "manager" }), "plugin grant")
const skill = await ok(apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("field-report", "Write the report of the visit.") } }), "skill")
await ok(apiA("POST", `/v1/config-objects/${text(field(skill.body, "item", "id"), "skill id")}/access`, { orgMembershipId: cal.memberId, role: "manager" }), "skill grant")
const gateway = await ok(apiA("POST", "/v1/inference-providers", { name: "Fixture OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] }), "gateway provider")
await ok(apiA("POST", "/v1/gateway/usage-limit-policies", { name: "Engineering spend", providerId: text(field(gateway.body, "inferenceProvider", "id"), "gateway id"), hardLimit: true, allowRequestReset: false, limits: [{ timeframe: "month", costUsd: "200.5" }] }), "limit")

const exported = asBlob((await ok(apiA("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)

const ian = await den.signUp("Ian Importer")
const target = await den.createOrg(ian, "Answers copy")
const apiB = den.as(ian, target.orgId)
/** The request of the first import, whose answers the later ones are given. */
let firstId = ""

test("the answers of one import, given to the next import of the same file, leave nothing to ask or write", async () => {
  const first = await upload(apiB, exported, "First import")
  const limit = item(first.plan, "ai-gateway.limits", "Engineering spend")
  const answered = await answerByHand(apiB, first.id, first.plan, [item(first.plan, "members.people", cal.name), limit])
  assert.deepEqual(blocking(answered).map(label), [], describe(blocking(answered)))
  await apply(ian, target.orgId, first.id, answered)
  firstId = first.id

  // Off, the same file again asks about the person again.
  const second = await upload(apiB, exported, "Second import")
  const unanswered = [...blocking(second.plan), ...writes(second.plan)]
  assert.ok(unanswered.length > 0, describe(planItems(second.plan)))

  // Off, there is no answers file to download or to give.
  const off = await apiB("GET", `/v1/config-blobs/change-requests/${first.id}/decisions`)
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")
  assert.equal((await den.setFeature(target.orgId, FEATURE, true)).status, 200, `${FEATURE} on`)

  const file = await answersOf(apiB, first.id)
  assert.equal(file.source?.organizationId, source.orgId)
  assert.equal(file.target.organizationId, target.orgId)
  assert.ok(file.decisions.skips.length === 2 && file.decisions.refs.length > 0, JSON.stringify(file.decisions))
  assert.deepEqual(Object.keys(file.decisions).sort(), ["matches", "refs", "renames", "skips"])

  const replayed = await decide(apiB, second.id, file)
  assert.deepEqual(blocking(replayed).map(label), [], describe(blocking(replayed)))
  assert.deepEqual(writes(replayed).map(label), [], describe(writes(replayed)))
  assert.equal(item(replayed, "members.people", cal.name).op, "skip")
  assert.equal(item(replayed, "ai-gateway.limits", "Engineering spend").op, "skip")
  // What the file says is what the request now holds, and its own answers file is the same.
  assert.deepEqual((await answersOf(apiB, second.id)).decisions, file.decisions)
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${second.id}/cancel`, {}), "cancel")
})

test("with the feature on, the next import of the same source starts with the earlier answers", async () => {
  const third = await upload(apiB, exported, "Third import")
  assert.deepEqual(blocking(third.plan).map(label), [], describe(blocking(third.plan)))
  assert.deepEqual(writes(third.plan).map(label), [], describe(writes(third.plan)))
  assert.equal(item(third.plan, "members.people", cal.name).op, "skip")
  // The plan says where the answers came from, and the request holds them.
  assert.ok(third.plan.issues.some((issue) => issue.level === "info" && issue.message.includes(firstId) && /reused from an earlier import/.test(issue.message)), JSON.stringify(third.plan.issues))
  const saved = field((await ok(apiB("GET", `/v1/config-blobs/change-requests/${third.id}/plan`), "plan")).body, "decisions")
  assert.equal(field(saved, "reusedFrom"), firstId)
  // The review can still change them: without the answers, the questions are back.
  const cleared = await decide(apiB, third.id, {})
  assert.ok(blocking(cleared).length + writes(cleared).length > 0, describe(planItems(cleared)))
  assert.ok(!cleared.issues.some((issue) => /reused from an earlier import/.test(issue.message)))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${third.id}/cancel`, {}), "cancel")

  // An export of another organization starts unanswered.
  const other = await den.createOrg(ada, "Answers other source")
  const apiO = den.as(ada, other.orgId)
  await ok(apiO("POST", "/v1/plugins", { name: "Other notes", description: "Notes of another organization" }), "other plugin")
  const fromOther = await upload(apiB, asBlob((await ok(apiO("GET", "/v1/config-blobs/export?areas=plugins.plugins"), "other export")).body), "Other source")
  assert.ok(!fromOther.plan.issues.some((issue) => /reused from an earlier import/.test(issue.message)), JSON.stringify(fromOther.plan.issues))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${fromOther.id}/cancel`, {}), "cancel")
})

test("an import told to create nothing blocks what the organization doesn't hold", async () => {
  const request = await upload(apiB, exported, "Match only")
  const off = await apiB("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, { createMissing: false })
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "feature"), "configImportMatchOnly")
  assert.equal((await den.setFeature(target.orgId, "configImportMatchOnly", true)).status, 200, "configImportMatchOnly on")

  const plan = await decide(apiB, request.id, { createMissing: false })
  const creates = planItems(plan).filter((entry) => entry.op === "create")
  assert.ok(creates.some((entry) => entry.area === "ai-gateway.limits"), describe(planItems(plan)))
  for (const entry of creates) {
    assert.ok(entry.flags.includes("blocked"), describe([entry]))
    assert.match(reasons(entry), /only changes what already exists/)
  }
  // What the first import created is still recognised, and not blocked.
  assert.ok(!item(plan, "plugins.plugins", "Field notes").flags.includes("blocked"), describe(planItems(plan)))
  // Left out, nothing is blocked any more.
  const skipped = await decide(apiB, request.id, { createMissing: false, skips: creates.map((entry) => ({ area: entry.area, ref: entry.ref })) })
  assert.deepEqual(planItems(skipped).filter((entry) => entry.flags.includes("blocked")).map(label), [])
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${request.id}/cancel`, {}), "cancel")
})

test("an answers file is refused for another organization, another source, and with the feature off", async () => {
  const file = await answersOf(apiB, firstId)
  const request = await upload(apiB, exported, "Refusals")

  const elsewhere = await apiB("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, { ...file, target: { organizationId: source.orgId } })
  assert.equal(elsewhere.status, 409, summary(elsewhere))
  assert.equal(field(elsewhere.body, "error"), "decisions_other_organization")

  const otherSource = await apiB("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, { ...file, source: { organizationId: target.orgId } })
  assert.equal(otherSource.status, 409, summary(otherSource))
  assert.equal(field(otherSource.body, "error"), "decisions_other_source")

  assert.equal((await den.setFeature(target.orgId, FEATURE, false)).status, 200, `${FEATURE} off`)
  const off = await apiB("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, file)
  assert.equal(off.status, 404, summary(off))
  // Plain decisions are not part of the feature.
  await decide(apiB, request.id, { skips: file.decisions.skips })
  assert.equal((await den.setFeature(target.orgId, FEATURE, true)).status, 200, `${FEATURE} on`)

  // None of the refusals changed the request.
  const plan = asPlan(field((await ok(apiB("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan"))
  assert.ok(blocking(plan).length > 0, describe(planItems(plan)))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${request.id}/cancel`, {}), "cancel")
})

test("a replayed \"leave it out\" is still refused where it would widen who an item applies to", async () => {
  const request = await upload(apiB, exported, "Widening")
  // Without the earlier answers (which skip the limit), the limit is planned.
  const limit = item(await decide(apiB, request.id, {}), "ai-gateway.limits", "Engineering spend")
  const provider = (limit.refs ?? []).find((ref) => ref.path === "provider")
  assert.ok(provider && (provider.refuses ?? []).includes("drop"), describe([limit]))

  // An answers file that leaves the provider out instead of skipping the limit: it would become a limit on everything.
  const file = await answersOf(apiB, request.id)
  const widened: ConfigDecisionsFile = { ...file, decisions: { ...file.decisions, refs: [{ area: limit.area, ref: limit.ref, path: "provider", resolution: { drop: true } }] } }
  const plan = await decide(apiB, request.id, widened)
  const refused = item(plan, "ai-gateway.limits", "Engineering spend")
  assert.notEqual(refused.op, "skip")
  assert.ok(refused.flags.includes("ref_unresolved"), describe([refused]))
  assert.match(reasons(refused), /provider.*can't be dropped \(this item can't be imported without it\)/)
  const approval = await apiB("POST", `/v1/config-blobs/change-requests/${request.id}/apply`, { planHash: plan.planHash })
  assert.ok(approval.status >= 400, summary(approval))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${request.id}/cancel`, {}), "cancel")
})
