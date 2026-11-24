/**
 * Config blobs: a plugin or skill the target already holds under the same
 * name is dealt with when the plan is made, never in the middle of the apply.
 *
 * 1. A plugin create that the plugin store would refuse ("You already have an
 *    active plugin named …": one person can't have two) is blocked in the
 *    plan, with what to do about it; renamed, it applies.
 * 2. Two plugins of one name created by the same import are flagged in the
 *    plan.
 * 3. A plugin or skill the organization already shares is the same item when
 *    it has the same stable key, whatever it is called there; without a key
 *    in common, the same name. The key gets a default on create and on export,
 *    is stored, never follows a rename, and can be edited.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { bootDen, field, isRecord, list, summary, text, type Call, type Session } from "./harness.js"

const den = await bootDen()
after(async () => {
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")

const AREAS = "plugins.plugins,plugins.skills"
const BLOCKING = ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked", "needs_input"]
const skillMarkdown = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill of the name-matching import.\n---\n\n${body}\n`

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

type Rename = { area: string; ref: string; name: string }

/**
 * Leaves out every reference the target can't resolve (the source creator's own access: they are not a member
 * here), with the renames given: the answers an admin gives in the review.
 */
async function decide(api: Api, id: string, plan: ConfigPlan, renames: Rename[] = []): Promise<ConfigPlan> {
  const refs = planItems(plan)
    .filter((entry) => entry.flags.includes("ref_unresolved"))
    .flatMap((entry) => (entry.refs ?? [])
      .filter((ref) => ref.resolvedId === null && !ref.via)
      .map((ref) => ({ area: entry.area, ref: entry.ref, path: ref.path, resolution: { drop: true as const } })))
  const decided = await ok(api("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { refs, renames }), "decisions")
  return asPlan(field(decided.body, "plan"))
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

/** How many plugins and skills of each name the organization holds, shared or not. */
async function counts(api: Api): Promise<Record<string, number>> {
  const [plugins, objects] = await Promise.all([ok(api("GET", "/v1/plugins?limit=100"), "plugins"), ok(api("GET", "/v1/config-objects?limit=100"), "config objects")])
  const out: Record<string, number> = {}
  for (const entry of [...list(field(plugins.body, "items")), ...list(field(objects.body, "items"))]) {
    const name = String(entry.name ?? entry.title)
    out[name] = (out[name] ?? 0) + 1
  }
  return out
}

type Seeded = { pluginId: string; skillId: string }

/** A plugin and a skill in it, both shared with everyone when `shared`. */
async function seed(api: Api, shared: boolean, body: string, names = { plugin: "Field notes", skill: "field-report" }): Promise<Seeded> {
  const plugin = await ok(api("POST", "/v1/plugins", { name: names.plugin, description: "Notes from the field" }), "plugin")
  const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
  const skill = await ok(api("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown(names.skill, body) } }), "skill")
  const skillId = text(field(skill.body, "item", "id"), "skill id")
  if (!shared) return { pluginId, skillId }
  await ok(api("POST", `/v1/plugins/${pluginId}/access`, { orgWide: true, role: "viewer" }), "plugin grant")
  await ok(api("POST", `/v1/config-objects/${skillId}/access`, { orgWide: true, role: "viewer" }), "skill grant")
  return { pluginId, skillId }
}

async function keysOf(api: Api, seeded: Seeded): Promise<{ plugin: unknown; skill: unknown }> {
  const [plugin, skill] = await Promise.all([ok(api("GET", `/v1/plugins/${seeded.pluginId}`), "plugin"), ok(api("GET", `/v1/config-objects/${seeded.skillId}`), "skill")])
  return { plugin: field(plugin.body, "item", "externalKey"), skill: field(skill.body, "item", "externalKey") }
}

async function setKeys(api: Api, seeded: Seeded, keys: { plugin: string | null; skill: string | null }): Promise<void> {
  await ok(api("PATCH", `/v1/plugins/${seeded.pluginId}`, { externalKey: keys.plugin }), "plugin key")
  await ok(api("PUT", `/v1/config-objects/${seeded.skillId}/key`, { externalKey: keys.skill }), "skill key")
}

/** Imports the export into an organization that already shares the two items, and expects them matched by `tier` with nothing created. */
async function importMatched(person: Session, orgId: string, tier: string): Promise<void> {
  const api = den.as(person, orgId)
  const uploaded = await upload(api, exported, `Import (${tier})`)
  const plan = await decide(api, uploaded.id, uploaded.plan)
  assert.deepEqual(blocking(plan).map(label), [], describe(blocking(plan)))
  assert.deepEqual(planItems(plan).filter((entry) => entry.op === "create").map(label), [], describe(planItems(plan)))
  assert.equal(item(plan, "plugins.plugins", "Field notes").matchedBy, tier, describe(planItems(plan)))
  assert.equal(item(plan, "plugins.skills", "field-report").matchedBy, tier, describe(planItems(plan)))
  await apply(person, orgId, uploaded.id, plan)
  const now = await counts(api)
  assert.deepEqual([now["Field notes"], now["field-report"]], [1, 1], JSON.stringify(now))
  // The same file again: nothing to ask and nothing to write.
  const again = await upload(api, exported, `Again (${tier})`)
  assert.deepEqual(blocking(again.plan).map(label), [], describe(blocking(again.plan)))
  assert.deepEqual(writes(again.plan).map(label), [], describe(writes(again.plan)))
  await ok(api("POST", `/v1/config-blobs/change-requests/${again.id}/cancel`, {}), "cancel")
}

// ---------------------------------------------------------------------------

const ada = await den.signUp("Ada Owner")
const source = await den.createOrg(ada, "Name match source")
const apiA = den.as(ada, source.orgId)
const seededA = await seed(apiA, true, "Write the report of the visit.")
const exported = asBlob((await ok(apiA("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)

test("a plugin name the importer already uses is blocked in the plan, and applies once renamed", async () => {
  const ian = await den.signUp("Ian Importer")
  const target = await den.createOrg(ian, "Name match personal")
  const apiB = den.as(ian, target.orgId)
  // Only the importer can reach this one: it is not an item of the target the file could be matched to.
  await seed(apiB, false, "A private report.")

  const { id, plan } = await upload(apiB, exported, "Import")
  const plugin = item(plan, "plugins.plugins", "Field notes")
  assert.equal(plugin.op, "create", describe([plugin]))
  assert.ok(plugin.flags.includes("blocked"), describe([plugin]))
  assert.match((plugin.reasons ?? []).join("\n"), /You already have an active plugin named "Field notes" \(.+\), and a person can't have two\./)
  assert.ok(plan.summary.blocking > 0)
  // Approving is refused while it is blocked: nothing reaches the apply.
  const refused = await apiB("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash })
  assert.ok(refused.status >= 400, summary(refused))

  const renamed = await decide(apiB, id, plan, [{ area: "plugins.plugins", ref: plugin.ref, name: "Field notes (imported)" }])
  assert.deepEqual(blocking(renamed).map(label), [], describe(blocking(renamed)))
  await apply(ian, target.orgId, id, renamed)
  const now = await counts(apiB)
  assert.equal(now["Field notes"], 1, JSON.stringify(now))
  assert.equal(now["Field notes (imported)"], 1, JSON.stringify(now))
})

test("two plugins of one name created by one import are flagged in the plan", async () => {
  const zed = await den.signUp("Zed Importer")
  const target = await den.createOrg(zed, "Name match twice")
  const apiC = den.as(zed, target.orgId)
  const twice: ConfigBlob = JSON.parse(JSON.stringify(exported))
  const plugins = twice.areas.plugins?.plugins?.items
  assert.ok(plugins && plugins[0])
  plugins.push({ ...plugins[0], key: "field-notes-copy", id: `${plugins[0].id}`.replace(/.$/, (last) => (last === "0" ? "1" : "0")) })

  const { plan } = await upload(apiC, twice, "Import")
  const flagged = planItems(plan).filter((entry) => entry.area === "plugins.plugins" && entry.flags.includes("collision.unique"))
  assert.equal(flagged.length, 2, describe(planItems(plan).filter((entry) => entry.area === "plugins.plugins")))
  assert.match((flagged[0]?.reasons ?? []).join("\n"), /this import creates more than one item with the name "Field notes": rename this one or skip it/)
})

test("a plugin and a skill get a key when created, and the export carries it", async () => {
  assert.deepEqual(await keysOf(apiA, seededA), { plugin: "field-notes", skill: "field-report" })
  assert.equal(exported.areas.plugins?.plugins?.items.find((entry) => entry.name === "Field notes")?.key, "field-notes")
  assert.equal(exported.areas.plugins?.skills?.items.find((entry) => entry.name === "field-report")?.key, "field-report")
})

test("an item without a key gets one when it is exported, and keeps it", async () => {
  const eve = await den.signUp("Eve Exporter")
  const org = await den.createOrg(eve, "Key on export")
  const api = den.as(eve, org.orgId)
  const seeded = await seed(api, true, "Write the report of the visit.")
  await setKeys(api, seeded, { plugin: null, skill: null })
  assert.deepEqual(await keysOf(api, seeded), { plugin: null, skill: null })
  const first = asBlob((await ok(api("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)
  assert.equal(first.areas.plugins?.plugins?.items[0]?.key, "field-notes")
  assert.equal(first.areas.plugins?.skills?.items[0]?.key, "field-report")
  assert.deepEqual(await keysOf(api, seeded), { plugin: "field-notes", skill: "field-report" })
  // A rename does not move the key.
  await ok(api("PATCH", `/v1/plugins/${seeded.pluginId}`, { name: "Field diary" }), "rename")
  const second = asBlob((await ok(api("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")).body)
  assert.equal(second.areas.plugins?.plugins?.items[0]?.name, "Field diary")
  assert.equal(second.areas.plugins?.plugins?.items[0]?.key, "field-notes")
})

test("a key another item of the organization has is refused", async () => {
  const kim = await den.signUp("Kim Keys")
  const org = await den.createOrg(kim, "Key taken")
  const api = den.as(kim, org.orgId)
  const first = await seed(api, true, "One.")
  const second = await seed(api, true, "Two.", { plugin: "Other notes", skill: "other-report" })
  // The second of a name gets a suffix, never the same key.
  assert.deepEqual(await keysOf(api, second), { plugin: "other-notes", skill: "other-report" })
  const plugin = await api("PATCH", `/v1/plugins/${second.pluginId}`, { externalKey: "field-notes" })
  assert.equal(plugin.status, 409, summary(plugin))
  assert.equal(field(plugin.body, "error"), "external_key_taken")
  const skill = await api("PUT", `/v1/config-objects/${second.skillId}/key`, { externalKey: "field-report" })
  assert.equal(skill.status, 409, summary(skill))
  assert.equal(field(skill.body, "error"), "external_key_taken")
  const invalid = await api("PUT", `/v1/config-objects/${second.skillId}/key`, { externalKey: "Not A Key" })
  assert.equal(invalid.status, 400, summary(invalid))
  assert.deepEqual(await keysOf(api, first), { plugin: "field-notes", skill: "field-report" })
  assert.deepEqual(await keysOf(api, second), { plugin: "other-notes", skill: "other-report" })
})

test("a shared plugin or skill with the same key is the same item, whatever it is called", async () => {
  const uma = await den.signUp("Uma Importer")
  const target = await den.createOrg(uma, "Key match renamed")
  const apiD = den.as(uma, target.orgId)
  // Created under the same names, so with the same default keys, then renamed: the keys stay.
  const seeded = await seed(apiD, true, "Write the report of the visit.")
  await ok(apiD("PATCH", `/v1/plugins/${seeded.pluginId}`, { name: "Field diary" }), "rename")
  assert.deepEqual(await keysOf(apiD, seeded), { plugin: "field-notes", skill: "field-report" })
  await importMatched(uma, target.orgId, "key")
  assert.deepEqual(await keysOf(apiD, seeded), { plugin: "field-notes", skill: "field-report" })
})

test("a key edited by hand links two items that were created apart", async () => {
  const ned = await den.signUp("Ned Importer")
  const target = await den.createOrg(ned, "Key match edited")
  const apiE = den.as(ned, target.orgId)
  const seeded = await seed(apiE, true, "A log of visits.", { plugin: "Visit diary", skill: "visit-log" })
  assert.deepEqual(await keysOf(apiE, seeded), { plugin: "visit-diary", skill: "visit-log" })
  await setKeys(apiE, seeded, { plugin: "field-notes", skill: "field-report" })
  await importMatched(ned, target.orgId, "key")
  const now = await counts(apiE)
  assert.deepEqual([now["Visit diary"], now["visit-log"]], [undefined, undefined], JSON.stringify(now))
})

test("without a key in common, the same name is the same item, and it takes the file's key", async () => {
  const oli = await den.signUp("Oli Importer")
  const target = await den.createOrg(oli, "Name match shared")
  const apiF = den.as(oli, target.orgId)
  const seeded = await seed(apiF, true, "Write the report of the visit.")
  await setKeys(apiF, seeded, { plugin: null, skill: null })
  await importMatched(oli, target.orgId, "natural")
  assert.deepEqual(await keysOf(apiF, seeded), { plugin: "field-notes", skill: "field-report" })
})
