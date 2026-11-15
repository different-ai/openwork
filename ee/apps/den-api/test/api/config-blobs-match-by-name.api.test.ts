/**
 * Config blobs: a plugin or skill the target already holds under the same
 * name is dealt with when the plan is made, never in the middle of the apply.
 *
 * 1. A plugin create that the plugin store would refuse ("You already have an
 *    active plugin named …": one person can't have two) is blocked in the
 *    plan, with what to do about it; renamed, it applies.
 * 2. Two plugins of one name created by the same import are flagged in the
 *    plan.
 * 3. With `configImportMatchByName` on, a plugin or skill the organization
 *    already shares under the same name is planned as the same item instead
 *    of a second copy; off, it is planned as a new one.
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
const FEATURE = "configImportMatchByName"
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

/** A plugin and a skill in it, both shared with everyone when `shared`. */
async function seed(api: Api, shared: boolean, body: string): Promise<void> {
  const plugin = await ok(api("POST", "/v1/plugins", { name: "Field notes", description: "Notes from the field" }), "plugin")
  const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
  const skill = await ok(api("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("field-report", body) } }), "skill")
  if (!shared) return
  await ok(api("POST", `/v1/plugins/${pluginId}/access`, { orgWide: true, role: "viewer" }), "plugin grant")
  await ok(api("POST", `/v1/config-objects/${text(field(skill.body, "item", "id"), "skill id")}/access`, { orgWide: true, role: "viewer" }), "skill grant")
}

// ---------------------------------------------------------------------------

const ada = await den.signUp("Ada Owner")
const source = await den.createOrg(ada, "Name match source")
const apiA = den.as(ada, source.orgId)
await seed(apiA, true, "Write the report of the visit.")
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
  plugins.push({ ...plugins[0], id: `${plugins[0].id}`.replace(/.$/, (last) => (last === "0" ? "1" : "0")) })

  const { plan } = await upload(apiC, twice, "Import")
  const flagged = planItems(plan).filter((entry) => entry.area === "plugins.plugins" && entry.flags.includes("collision.unique"))
  assert.equal(flagged.length, 2, describe(planItems(plan).filter((entry) => entry.area === "plugins.plugins")))
  assert.match((flagged[0]?.reasons ?? []).join("\n"), /this import creates more than one item with the name "Field notes": rename this one or skip it/)
})

test("a shared plugin or skill of the same name: a second copy with the feature off, the same item with it on", async () => {
  const uma = await den.signUp("Uma Importer")
  const target = await den.createOrg(uma, "Name match shared")
  const apiD = den.as(uma, target.orgId)
  await seed(apiD, true, "Write the report of the visit.")
  const before = await counts(apiD)
  assert.deepEqual([before["Field notes"], before["field-report"]], [1, 1], JSON.stringify(before))

  // Off: both are new items; the plugin is the importer's own name twice, so it is blocked rather than failing at apply.
  const off = await upload(apiD, exported, "Feature off")
  assert.equal(item(off.plan, "plugins.skills", "field-report").op, "create", describe(planItems(off.plan)))
  const blockedPlugin = item(off.plan, "plugins.plugins", "Field notes")
  assert.equal(blockedPlugin.op, "create", describe([blockedPlugin]))
  assert.ok(blockedPlugin.flags.includes("blocked"), describe([blockedPlugin]))
  await ok(apiD("POST", `/v1/config-blobs/change-requests/${off.id}/cancel`, {}), "cancel")

  // On: each is the one the organization already shares.
  assert.equal((await den.setFeature(target.orgId, FEATURE, true)).status, 200, `${FEATURE} on`)
  const uploaded = await upload(apiD, exported, "Feature on")
  const on = { id: uploaded.id, plan: await decide(apiD, uploaded.id, uploaded.plan) }
  assert.deepEqual(blocking(on.plan).map(label), [], describe(blocking(on.plan)))
  assert.deepEqual(planItems(on.plan).filter((entry) => entry.op === "create").map(label), [], describe(planItems(on.plan)))
  const plugin = item(on.plan, "plugins.plugins", "Field notes")
  const skill = item(on.plan, "plugins.skills", "field-report")
  assert.equal(plugin.matchedBy, "natural", describe([plugin]))
  assert.equal(skill.matchedBy, "natural", describe([skill]))
  assert.match((plugin.reasons ?? []).join("\n"), /matched by name/)
  assert.match((skill.reasons ?? []).join("\n"), /matched by type and title/)
  await apply(uma, target.orgId, on.id, on.plan)
  const now = await counts(apiD)
  assert.deepEqual([now["Field notes"], now["field-report"]], [1, 1], JSON.stringify(now))
})
