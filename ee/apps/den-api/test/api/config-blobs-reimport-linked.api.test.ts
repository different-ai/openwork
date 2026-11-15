/**
 * Config blobs: importing the same file a second time recognises what the
 * first import created, whoever can reach it now.
 *
 * In the source a plugin and two skills are shared with one person only. Their
 * creator copies the organization into another one and leaves that person
 * out, so in the target nobody but the importer can reach those items: they are personal there, and the target's own export
 * leaves them out. The link the first import saved still names them, so the
 * second import of the file plans no write and creates nothing twice.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { bootDen, field, isRecord, list, summary, text, type Call, type Member, type Session } from "./harness.js"

const den = await bootDen()
after(async () => {
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")

const AREAS = "members.people,plugins.plugins,plugins.skills"
const BLOCKING = ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked", "needs_input"]
const skillMarkdown = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill shared with one person.\n---\n\n${body}\n`

type Api = ReturnType<typeof den.as>
type Decisions = {
  skips: Array<{ area: string; ref: string }>
  refs: Array<{ area: string; ref: string; path: string; resolution: { drop: true } }>
}

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

/** `areas[a][b].items` of a blob, by area key. */
function areaNames(blob: ConfigBlob, key: string): string[] {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  return list(isRecord(node) ? node.items : []).map((entry) => String(entry.name))
}

async function drive(api: Api, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "change request"))
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

/** Uploads the file, leaves the person out, and then every reference to them: the answers an admin gives. */
async function planWithout(api: Api, blob: ConfigBlob, person: string, title: string): Promise<{ id: string; plan: ConfigPlan }> {
  const request = asSummary(await ok(api("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title }), "upload"))
  const analyzed = await drive(api, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  const first = asPlan(field((await ok(api("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan"))
  const left = planItems(first).find((entry) => entry.area === "members.people" && nameOf(entry) === person)
  assert.ok(left, `${person} is in the plan`)
  const decisions: Decisions = { skips: [{ area: "members.people", ref: left.ref }], refs: [] }
  const decide = async () => asPlan(field((await ok(api("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, { ...decisions, people: { sendInviteEmails: false } }), "decisions")).body, "plan"))
  const waiting = await decide()
  decisions.refs = planItems(waiting)
    .filter((entry) => entry.flags.includes("ref_unresolved"))
    .flatMap((entry) => (entry.refs ?? [])
      .filter((ref) => ref.resolvedId === null && !ref.via)
      .map((ref) => ({ area: entry.area, ref: entry.ref, path: ref.path, resolution: { drop: true as const } })))
  return { id: request.id, plan: decisions.refs.length > 0 ? await decide() : waiting }
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
  return run
}

/** How many plugins and skills of these names the organization holds, shared or not. */
async function counts(api: Api): Promise<Record<string, number>> {
  const [plugins, objects] = await Promise.all([ok(api("GET", "/v1/plugins?limit=100"), "plugins"), ok(api("GET", "/v1/config-objects?limit=100"), "config objects")])
  const out: Record<string, number> = {}
  for (const entry of [...list(field(plugins.body, "items")), ...list(field(objects.body, "items"))]) {
    const name = String(entry.name ?? entry.title)
    out[name] = (out[name] ?? 0) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// The source: a plugin and two skills that only one person, besides their creator, can reach.

const ada = await den.signUp("Ada Owner")
const source = await den.createOrg(ada, "Linked import source")
const apiA = den.as(ada, source.orgId)
const cal: Member = await den.newMember(ada, source.orgId, "Cal Member")

const plugin = await ok(apiA("POST", "/v1/plugins", { name: "Field notes", description: "Notes from the field" }), "plugin")
const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
await ok(apiA("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: cal.memberId, role: "manager" }), "plugin grant")
const inPlugin = await ok(apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("field-report", "Write the report of the visit.") } }), "skill in the plugin")
await ok(apiA("POST", `/v1/config-objects/${text(field(inPlugin.body, "item", "id"), "skill id")}/access`, { orgMembershipId: cal.memberId, role: "manager" }), "skill grant")
const alone = await ok(apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", input: { rawSourceText: skillMarkdown("field-checklist", "Check the list before leaving.") } }), "skill on its own")
await ok(apiA("POST", `/v1/config-objects/${text(field(alone.body, "item", "id"), "skill id")}/access`, { orgMembershipId: cal.memberId, role: "manager" }), "skill grant")

const exported = asBlob((await ok(apiA("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)
const NAMES = ["Field notes", "field-checklist", "field-report"]

test("the second import of a file recognises items that only the importer can reach", async () => {
  assert.deepEqual(areaNames(exported, "plugins.plugins"), ["Field notes"])
  assert.deepEqual(areaNames(exported, "plugins.skills").sort(), ["field-checklist", "field-report"])

  // Their creator copies them into another organization of their own.
  const target = await den.createOrg(ada, "Linked import copy")
  const apiB = den.as(ada, target.orgId)

  const first = await planWithout(apiB, exported, cal.name, "First import")
  assert.deepEqual(blocking(first.plan).map(label), [], describe(blocking(first.plan)))
  assert.deepEqual(writes(first.plan).filter((entry) => entry.area !== "members.people").map(label).sort(), [
    "plugins.plugins:Field notes:create",
    "plugins.skills:field-checklist:create",
    "plugins.skills:field-report:create",
  ], describe(writes(first.plan)))
  const run = await apply(ada, target.orgId, first.id, first.plan)
  assert.equal(run.counts.failed, 0)

  // Without the person they were shared with, only the importer reaches them: the target's export leaves them out.
  const after = asBlob((await ok(apiB("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)
  assert.deepEqual([...areaNames(after, "plugins.plugins"), ...areaNames(after, "plugins.skills")].filter((name) => NAMES.includes(name)), [], "personal in the target")
  const before = await counts(apiB)
  assert.deepEqual(NAMES.map((name) => before[name]), [1, 1, 1], JSON.stringify(before))

  // The same file, the same answers: every item is the one the first import made, and nothing is written.
  const again = await planWithout(apiB, exported, cal.name, "Second import")
  assert.deepEqual(blocking(again.plan).map(label), [], describe(blocking(again.plan)))
  assert.deepEqual(writes(again.plan).map(label), [], describe(writes(again.plan)))
  for (const name of NAMES) {
    const entry = planItems(again.plan).find((candidate) => nameOf(candidate) === name)
    assert.ok(entry, `${name} is in the plan`)
    assert.equal(entry.op, "unchanged", describe([entry]))
    assert.equal(entry.matchedBy, "alias", describe([entry]))
  }
  const now = await counts(apiB)
  assert.deepEqual(NAMES.map((name) => now[name]), [1, 1, 1], JSON.stringify(now))
})

test("a saved link never shows a personal item the file does not hold", async () => {
  // Another personal skill of the importer's organization is not part of any plan of this file.
  const zed = await den.signUp("Zed Importer")
  const target = await den.createOrg(zed, "Linked import other")
  const apiC = den.as(zed, target.orgId)
  await ok(apiC("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", input: { rawSourceText: skillMarkdown("field-checklist", "A private list of the importer.") } }), "personal skill")
  const first = await planWithout(apiC, exported, cal.name, "First import")
  const entry = planItems(first.plan).find((candidate) => candidate.area === "plugins.skills" && nameOf(candidate) === "field-checklist")
  assert.ok(entry)
  assert.equal(entry.op, "create", describe([entry]))
  assert.deepEqual(entry.candidates ?? [], [], "the importer's personal skill is not offered as a match")
})
