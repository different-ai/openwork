/**
 * Config blobs: a whole organization is imported in one pass, on a database
 * that behaves like production's (reads go to a replica that lags, a
 * transaction takes one statement at a time) and with the seat limit of the
 * Free plan on.
 *
 * Organization A is set up through the public API with what makes an import
 * hard: people who own, administer, joined and were only invited; grants,
 * limits and access that name those people; an AI Gateway model as Workbot's
 * model; a feature only a platform admin turns on; SSO and SCIM. Then:
 *
 * 1. Another person imports A's export into their own organization. One
 *    person too many for the plan: they are blocked when the plan is made,
 *    the importer leaves them out, and the apply succeeds the first time.
 *    Importing the same file again writes nothing.
 * 2. A's owner copies A into a new organization of their own: Workbot's
 *    model follows the provider's new ids.
 * 3. Part of A is imported where what it references doesn't exist: an entry
 *    that can't stand without its reference is left out with it, and an item
 *    that can't stand without it isn't imported under a wider scope.
 *
 * Everything what the import can't do is said before approval (skipped,
 * blocked or warned) or as a warning of the run; no item fails.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem, ConfigSecretInput } from "@openwork/types/den/config-blobs"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, isRecord, list, startFakeMcpServer, summary, text, type Call, type Member, type Session } from "./harness.js"

const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ productionLike: true, env: {
  ...gatewayFixtureEnv,
  // Smart routers exist on cloud deployments only.
  DEN_DEPLOYMENT: "cloud",
  DEN_WORKBOT_URL: "http://localhost:3020",
  // Seat billing on, so the Free plan's user limit applies; the key is fake and nothing here reaches Stripe.
  STRIPE_SECRET_KEY: "sk_test_local_fake",
  STRIPE_SEAT_PRICE_ID: "price_local_fake",
} })
const mcpServer = await startFakeMcpServer({ tools: [{ name: "ping", description: "Ping", text: "pong" }] })
after(async () => {
  restoreFetch()
  await mcpServer.close()
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")

const production = den.production
assert.ok(production, "booted production-like")

const SECRETS = { gateway: "sk-first-pass-gateway-SECRET-1", oidc: "first-pass-oidc-client-SECRET-1" }
const FEATURE = "denGreySidebar"
const BLOCKING = ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked", "needs_input"]
const skillMarkdown = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill of the first-pass import.\n---\n\n${body}\n`

type Api = ReturnType<typeof den.as>
type Decisions = {
  skips: Array<{ area: string; ref: string }>
  refs: Array<{ area: string; ref: string; path: string; resolution: { drop: true } | { targetId: string } }>
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

function planItems(plan: ConfigPlan): ConfigPlanItem[] {
  return plan.areas.flatMap((area) => area.items)
}

const nameOf = (item: ConfigPlanItem) => item.blob?.name ?? item.target?.name ?? ""
const label = (item: ConfigPlanItem) => `${item.area}:${nameOf(item)}`
const isBlocking = (item: ConfigPlanItem) => item.flags.some((flag) => BLOCKING.includes(flag))
const writes = (plan: ConfigPlan) => planItems(plan).filter((item) => ["create", "update", "rename", "delete"].includes(item.op))

function describe(items: readonly ConfigPlanItem[]): string {
  return JSON.stringify(items.map((item) => ({
    area: item.area, name: nameOf(item), op: item.op, flags: item.flags, reasons: item.reasons,
    fields: item.fields.map((change) => change.path),
    open: (item.refs ?? []).filter((ref) => ref.resolvedId === null).map((ref) => `${ref.path} → ${ref.ref}`),
  })), null, 1)
}

function item(plan: ConfigPlan, area: string, name: string): ConfigPlanItem {
  const found = planItems(plan).find((entry) => entry.area === area && nameOf(entry) === name)
  assert.ok(found, `${area} "${name}" is in the plan: ${planItems(plan).filter((entry) => entry.area === area).map(nameOf).join(", ")}`)
  return found
}

function reasons(entry: ConfigPlanItem): string {
  return (entry.reasons ?? []).join("\n")
}

/** `areas[a][b].items` of a blob, by area key. */
function areaItems(blob: ConfigBlob, key: string): Array<{ id?: string; name: string; spec: Record<string, unknown> }> {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  const items = isRecord(node) && Array.isArray(node.items) ? node.items : []
  return JSON.parse(JSON.stringify(items))
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

async function decide(api: Api, id: string, decisions: Decisions): Promise<ConfigPlan> {
  const decided = await ok(api("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { ...decisions, people: { sendInviteEmails: false } }), "decisions")
  return asPlan(field(decided.body, "plan"))
}

/** Every reference still open on an item that waits for one: left out, the way an admin answers "Leave it out". */
function openReferenceDrops(plan: ConfigPlan): Decisions["refs"] {
  return planItems(plan)
    .filter((entry) => entry.flags.includes("ref_unresolved"))
    .flatMap((entry) => (entry.refs ?? [])
      .filter((ref) => ref.resolvedId === null && !ref.via)
      .map((ref) => ({ area: entry.area, ref: entry.ref, path: ref.path, resolution: { drop: true as const } })))
}

/** The importer types in every key the plan asks for: only the ones the source had. */
async function enterSecrets(api: Api, id: string, plan: ConfigPlan): Promise<ConfigPlan> {
  const asked = planItems(plan)
    .flatMap((entry) => (entry.op === "create" || entry.op === "update" ? entry.secrets ?? [] : []))
    .filter((secret) => secret.decision === null)
  assert.deepEqual(asked.filter((secret) => !secret.sourceHadValue).map((secret) => secret.path), [], "a key the source never had is not asked for")
  const inputs = asked.map((secret): ConfigSecretInput => ({ path: secret.path, decision: "value", value: secret.path.startsWith("settings.auth-security/") ? SECRETS.oidc : SECRETS.gateway }))
  if (inputs.length === 0) return plan
  return asPlan(field((await ok(api("PUT", `/v1/config-blobs/change-requests/${id}/inputs`, { inputs }), "inputs")).body, "plan"))
}

/** A new sign-in of the same person: approving and applying need a recently signed-in session. */
async function freshSession(person: Session): Promise<Session> {
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  return { ...person, token: text(field(signedIn.body, "token"), "session token"), cookie: signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "" }
}

/** Approves and applies from a recent sign-in (`recent`, or a new one), and expects the first run to apply everything. */
async function apply(person: Session, orgId: string, id: string, plan: ConfigPlan, recent?: Session): Promise<ConfigApplyReport> {
  const api = den.as(person, orgId)
  const fresh = den.as(recent ?? await freshSession(person), orgId)
  const queued = await ok(fresh("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  assert.equal(asSummary(queued).status, "queued")
  const settled = await drive(api, id)
  const detail = await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "detail")
  const runs: ConfigApplyReport[] = JSON.parse(JSON.stringify(field(detail.body, "runs") ?? []))
  const run = runs[0]
  assert.ok(run, "one run")
  const unfinished = run.items.filter((entry) => entry.status !== "applied" && entry.status !== "noop")
  assert.equal(settled.status, "applied", `${JSON.stringify(settled.errors)}\n${JSON.stringify(unfinished, null, 1)}`)
  assert.equal(runs.length, 1, "applied by the first run")
  assert.deepEqual(unfinished, [], "every item applied")
  return run
}

/** The warnings of a run, as `<area>: <warning>`. */
function runWarnings(run: ConfigApplyReport): string[] {
  return run.items.flatMap((entry) => entry.warnings.map((warning) => `${entry.area}: ${warning}`))
}

async function exportOf(api: Api, areas?: string): Promise<ConfigBlob> {
  const response = await ok(api("GET", `/v1/config-blobs/export${areas ? `?areas=${areas}` : ""}`), "export")
  for (const secret of Object.values(SECRETS)) assert.ok(!response.text.includes(secret), "no secret value in an export")
  return asBlob(response.body)
}

/** The AI Gateway models this person can use in the organization, as aliases. */
async function usableModels(person: Session, orgId: string): Promise<string[]> {
  const usable = await ok(den.as(person, orgId)("GET", "/v1/inference-providers?scope=usable"), "usable providers")
  return list(field(usable.body, "inferenceProviders")).flatMap((provider) => list(provider.models).map((model) => text(model.id, "model alias")))
}

// ---------------------------------------------------------------------------
// Organization A: five people (the Free plan's limit), set up through the public API.

const ada = await den.signUp("Ada Owner")
const orgA = await den.createOrg(ada, "First-pass source")
const apiA = den.as(ada, orgA.orgId)
const cal: Member = await den.newMember(ada, orgA.orgId, "Cal Member")
const eve: Member = await den.newMember(ada, orgA.orgId, "Eve Admin", "admin")
const platform = await den.createTeam(ada, orgA.orgId, "Platform", [cal.memberId])
const deeEmail = `dee-invited+${den.stamp}@example.test`
await ok(apiA("POST", "/v1/invitations", { email: deeEmail, role: "member", teamId: platform }), "invite")
// The last to arrive: the one the seat limit leaves out where the importer takes a seat too.
const zoe: Member = await den.newMember(ada, orgA.orgId, "Zoe Member")
assert.equal((await den.setFeature(orgA.orgId, FEATURE, true)).status, 200, `${FEATURE} on`)

// AI Gateway: a provider granted to the team and to people by name, limits assigned to people, a smart router.
const gateway = await ok(apiA("POST", "/v1/inference-providers", { name: "Fixture OpenAI", providerId: "openai", modelIds: ["gpt-6-luna", "gpt-fixture-other"] }), "gateway provider")
const gatewayId = text(field(gateway.body, "inferenceProvider", "id"), "gateway id")
const group = await ok(apiA("POST", `/v1/inference-providers/${gatewayId}/model-groups`, { name: "All", modelIds: ["gpt-6-luna", "gpt-fixture-other"] }), "model group")
const set = await ok(apiA("POST", `/v1/inference-providers/${gatewayId}/credential-sets`, { name: "Shared", credentialMode: "org", credential: { kind: "api_key", secret: SECRETS.gateway } }), "credential set")
for (const audience of [{ type: "team", teamId: platform }, { type: "member", memberId: orgA.owner.memberId }, { type: "member", memberId: cal.memberId }, { type: "member", memberId: zoe.memberId }]) {
  await ok(apiA("POST", `/v1/inference-providers/${gatewayId}/access-grants`, {
    modelGroupId: text(field(group.body, "modelGroup", "id"), "group id"),
    credentialSetId: text(field(set.body, "credentialSet", "id"), "set id"),
    audience,
  }), "gateway grant")
}
const teamLimit = await ok(apiA("POST", "/v1/gateway/usage-limit-policies", { name: "Engineering spend", providerId: gatewayId, hardLimit: true, allowRequestReset: false, limits: [{ timeframe: "month", costUsd: "200.5" }] }), "limit")
for (const target of [{ teamId: platform }, { memberId: cal.memberId }, { memberId: zoe.memberId }]) {
  await ok(apiA("POST", `/v1/gateway/usage-limit-policies/${text(field(teamLimit.body, "id"), "limit id")}/assignments`, target), "limit assignment")
}
const soloLimit = await ok(apiA("POST", "/v1/gateway/usage-limit-policies", { name: "Solo spend", hardLimit: false, allowRequestReset: true, limits: [{ timeframe: "day", costUsd: "5" }] }), "limit of one person")
await ok(apiA("POST", `/v1/gateway/usage-limit-policies/${text(field(soloLimit.body, "id"), "limit id")}/assignments`, { memberId: eve.memberId }), "limit assignment")
const router = await ok(apiA("POST", "/v1/org/auto-routers", { name: "Smart Engineering", models: [
  { providerId: gatewayId, modelId: "gpt-fixture-other", tasks: ["Code review"] },
  { providerId: gatewayId, modelId: "gpt-6-luna", tasks: ["Quick questions"] },
] }), "smart router")
await ok(apiA("PUT", `/v1/org/auto-routers/${text(field(router.body, "routerId"), "router id")}/assignment`, { assignment: { everyone: false, teamIds: [platform], memberIds: [] } }), "router assignment")

// Connectors and plugins that name people.
await ok(apiA("POST", "/v1/mcp-connections", { name: "Docs MCP", url: `${mcpServer.url}/mcp`, authType: "none", access: { orgWide: false, teamIds: [platform], memberIds: [cal.memberId, zoe.memberId] } }), "MCP connection")
await ok(apiA("POST", "/v1/desktop-policies", { policyName: "Engineering", policy: { execution: { commands: "allow", blockedCommands: ["rm -rf /"] } }, priority: 5, teamIds: [platform], memberIds: [zoe.memberId], roles: [] }), "desktop policy")
const marketplace = await ok(apiA("POST", "/v1/marketplaces", { name: "Research tools", description: "Tools for research" }), "collection")
const marketplaceId = text(field(marketplace.body, "item", "id"), "collection id")
await ok(apiA("POST", `/v1/marketplaces/${marketplaceId}/access`, { teamId: platform, role: "viewer" }), "collection grant")
const plugin = await ok(apiA("POST", "/v1/plugins", { name: "Research", description: "Research helpers" }), "plugin")
const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
for (const person of [cal, zoe]) await ok(apiA("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: person.memberId, role: "viewer" }), "plugin grant")
await ok(apiA("POST", `/v1/marketplaces/${marketplaceId}/plugins`, { pluginId }), "plugin in collection")
const skill = await ok(apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("summarize", "Summarize the sources first.") } }), "skill")
await ok(apiA("POST", `/v1/config-objects/${text(field(skill.body, "item", "id"), "skill id")}/access`, { orgWide: true, role: "viewer" }), "skill grant")

// Workbot uses a model of that provider: for everyone, and another for the team.
const aliasesA = await usableModels(ada, orgA.orgId)
assert.equal(aliasesA.length, 2, "the owner can use both models")
const [orgModelA, teamModelA] = aliasesA
assert.ok(orgModelA && teamModelA)
await ok(apiA("PUT", "/v1/org/workbot-settings", { model: orgModelA }), "Workbot model")
await ok(apiA("PUT", `/v1/org/workbot-settings/teams/${platform}`, { name: { inherit: false, value: "Scout" }, model: { inherit: false, value: teamModelA } }), "team Workbot settings")

// SSO, enabled, with SCIM provisioning (a loopback issuer: its domain counts as verified in tests).
const issuer = `http://127.0.0.1/oidc/first-pass-${den.stamp}`
const idp = `https://idp-${den.stamp}.example.test`
await ok(apiA("POST", "/v1/sso/oidc", {
  issuer, domain: `first-pass-${den.stamp}.example.test`, clientId: "oidc-client-id", clientSecret: SECRETS.oidc, skipDiscovery: true,
  authorizationEndpoint: `${idp}/authorize`, tokenEndpoint: `${idp}/token`, jwksEndpoint: `${idp}/jwks`, name: "Okta",
}), "OIDC connection")
await den.arrangeSsoConnectionEnabled(orgA.orgId)
await ok(apiA("POST", "/v1/scim/token"), "SCIM token")

const exportedA = await exportOf(apiA)
const people = { ada: ada.email, cal: cal.email, dee: deeEmail, eve: eve.email, zoe: zoe.email }

// ---------------------------------------------------------------------------

test("the export holds what the import has to deal with", () => {
  assert.deepEqual(areaItems(exportedA, "members.people").map((entry) => entry.spec.email), [people.ada, people.cal, people.eve, people.dee, people.zoe])
  assert.deepEqual(areaItems(exportedA, "settings.features").map((entry) => entry.name).length, 1, "one feature on")
  const workbot = areaItems(exportedA, "workbot.settings")[0]
  assert.equal(workbot?.spec.model, orgModelA)
  // The alias is three row ids of A; what it names travels beside it.
  assert.deepEqual(workbot?.spec.gatewayModel, { modelGroup: "All", credentialSet: "Shared", modelId: field(workbot?.spec.gatewayModel, "modelId") }, JSON.stringify(workbot?.spec))
  assert.ok(areaItems(exportedA, "settings.auth-security").some((entry) => entry.spec.kind === "scim"), "SCIM provisioning")
})

test("another person imports the whole organization: applied by the first run", async () => {
  const ian = await den.signUp("Ian Importer")
  const orgB = await den.createOrg(ian, "First-pass copy")
  const apiB = den.as(ian, orgB.orgId)

  // From the upload to the end of the apply, the replica holds nothing newer than this moment
  // (the sign-in the approval needs is made before it: a session is read where it was written).
  const recent = await freshSession(ian)
  await production.freeze()
  const { id, plan: first } = await upload(apiB, exportedA, "Whole organization")

  // Six people for five seats: the last invitation is refused when the plan is made, not in the middle of the apply.
  // A whole organization carries every area a reference points into: nothing more to list.
  assert.equal(first.refTargets, undefined, JSON.stringify(first.refTargets))
  const blocked = planItems(first).filter((entry) => entry.flags.includes("blocked"))
  assert.deepEqual(blocked.map(label), [`members.people:${zoe.name}`], describe(blocked))
  assert.match(reasons(item(first, "members.people", zoe.name)), /there is no seat left for them\. The Free plan is limited to 5 users, counting pending invitations\./)
  assert.match(reasons(item(first, "members.people", zoe.name)), /Or skip this person/)

  // What an importer who isn't a platform admin can't do is skipped with the reason, never blocked.
  const feature = planItems(first).find((entry) => entry.area === "settings.features")
  assert.ok(feature)
  assert.equal(feature.op, "skip", describe([feature]))
  assert.match(reasons(feature), /only a platform admin can turn a feature on/)
  const scim = item(first, "settings.auth-security", "SCIM provisioning")
  assert.equal(scim.op, "skip", describe([scim]))
  assert.match(reasons(scim), /generate a SCIM token in Settings › Auth & Security/)
  // Said before approval: the source's owner is invited as an admin; people who haven't joined get no limit yet.
  assert.match(reasons(item(first, "members.people", ada.name)), /invited as an admin \(an import never moves ownership\)/)
  assert.match(reasons(item(first, "ai-gateway.limits", "Solo spend")), /will not be assigned yet/)

  // The importer leaves the person out, and then everything that names them.
  const decisions: Decisions = { skips: [{ area: "members.people", ref: item(first, "members.people", zoe.name).ref }], refs: [] }
  let plan = await decide(apiB, id, decisions)
  const waiting = planItems(plan).filter((entry) => entry.flags.includes("ref_unresolved"))
  assert.deepEqual(waiting.map(label).sort(), [
    "ai-gateway.limits:Engineering spend",
    "ai-gateway.providers:Fixture OpenAI",
    "connectors.mcp:Docs MCP",
    "desktop-policies:Engineering",
    "plugins.plugins:Research",
  ], describe(waiting))
  // Each of those references says who it is, and that inviting them anyway is not a choice: they were left out on purpose.
  const toZoe = planItems(plan).flatMap((entry) => (entry.refs ?? []).filter((ref) => ref.resolvedId === null && ref.via !== "planned"))
  assert.deepEqual(toZoe.map((ref) => `${ref.name ?? ""}: ${(ref.refuses ?? []).join(",")}`), Array.from({ length: 5 }, () => `${zoe.name}: invite`))
  decisions.refs = openReferenceDrops(plan)
  assert.equal(decisions.refs.length, 5, JSON.stringify(decisions.refs))
  plan = await enterSecrets(apiB, id, await decide(apiB, id, decisions))
  assert.equal(plan.summary.blocking, 0, describe(planItems(plan).filter(isBlocking)))
  assert.match(reasons(item(plan, "settings.auth-security", "Okta")), /warning: The connection is enabled in the source but will start disabled here/)

  const run = await apply(ian, orgB.orgId, id, plan, recent)
  await production.thaw()
  assert.equal(run.counts.failed, 0)
  assert.equal(run.counts.not_reached, 0)
  const warnings = runWarnings(run)
  // What the run could not do is a warning on the item, with what to do about it.
  assert.ok(warnings.some((warning) => warning.startsWith("workbot.settings: Workbot's model was not changed")), warnings.join("\n"))
  assert.ok(warnings.some((warning) => warning.startsWith("ai-gateway.limits: Not assigned to")), warnings.join("\n"))

  // The importer still manages what they imported, though the file names other managers.
  const collection = await ok(apiB("GET", "/v1/marketplaces"), "collections")
  assert.ok(list(field(collection.body, "items")).some((entry) => entry.name === "Research tools"), summary(collection))
  const exportedB = await exportOf(apiB)
  const roles = Object.fromEntries(areaItems(exportedB, "members.people").map((entry) => [String(entry.spec.email), `${String(entry.spec.role)} ${String(entry.spec.status)}`]))
  assert.deepEqual(roles, {
    [ian.email]: "owner active",
    [people.ada]: "admin invited",
    [people.cal]: "member invited",
    [people.dee]: "member invited",
    [people.eve]: "admin invited",
  })

  // The same file again, with the same answers: nothing to write.
  const again = await upload(apiB, exportedA, "Whole organization again")
  let replan = await decide(apiB, again.id, { skips: [{ area: "members.people", ref: item(again.plan, "members.people", zoe.name).ref }], refs: [] })
  replan = await decide(apiB, again.id, { skips: [{ area: "members.people", ref: item(replan, "members.people", zoe.name).ref }], refs: openReferenceDrops(replan) })
  assert.deepEqual(writes(replan).map((entry) => `${label(entry)}:${entry.op}`), [], describe(writes(replan)))
  assert.equal(replan.summary.blocking, 0, describe(planItems(replan).filter(isBlocking)))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${again.id}/cancel`, {}), "cancel")

  // The organization's own export: all unchanged.
  const own = await upload(apiB, exportedB, "Own export")
  const changed = planItems(own.plan).filter((entry) => entry.op !== "unchanged")
  assert.deepEqual(changed.map((entry) => `${label(entry)}:${entry.op}`), [], describe(changed))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${own.id}/cancel`, {}), "cancel")
})

test("the owner copies their organization into a new one: Workbot's model follows the provider", async () => {
  const orgC = await den.createOrg(ada, "First-pass twin")
  const apiC = den.as(ada, orgC.orgId)
  const { id, plan: first } = await upload(apiC, exportedA, "Whole organization")

  // Five people for five seats, and everyone the file names is invited: nothing to answer but the keys.
  const blocking = planItems(first).filter(isBlocking)
  assert.deepEqual([...new Set(blocking.flatMap((entry) => entry.flags.filter((flag) => BLOCKING.includes(flag))))], ["needs_input"], describe(blocking))
  // And only the keys the source had: the provider's OAuth client secret was never set, so it stays empty unasked.
  const providerSecrets = Object.fromEntries((item(first, "ai-gateway.providers", "Fixture OpenAI").secrets ?? []).map((secret) => [secret.field.replace(/^.*\./, ""), secret.decision]))
  assert.deepEqual(providerSecrets, { credential: null, oauthClientSecret: "unset" })
  assert.doesNotMatch(reasons(item(first, "ai-gateway.providers", "Fixture OpenAI")), /oauthClientSecret/)
  const plan = await enterSecrets(apiC, id, first)
  assert.equal(plan.summary.blocking, 0, describe(planItems(plan).filter(isBlocking)))

  const run = await apply(ada, orgC.orgId, id, plan)
  assert.equal(run.counts.failed, 0)
  assert.deepEqual(runWarnings(run).filter((warning) => warning.startsWith("workbot.")), [])

  // The alias saved here is made of this organization's ids: one of the models the owner can use here.
  const exportedC = await exportOf(apiC)
  const aliasesC = await usableModels(ada, orgC.orgId)
  assert.equal(aliasesC.length, 2, "the owner can use both models here")
  const orgModelC = areaItems(exportedC, "workbot.settings")[0]?.spec.model
  assert.ok(typeof orgModelC === "string" && aliasesC.includes(orgModelC), `${String(orgModelC)} is one of ${aliasesC.join(", ")}`)
  assert.ok(!aliasesA.includes(String(orgModelC)), "not the source's alias")
  assert.deepEqual(areaItems(exportedC, "workbot.settings")[0]?.spec.gatewayModel, areaItems(exportedA, "workbot.settings")[0]?.spec.gatewayModel, "the same model of the same provider")
  // The team's own model too, and it is the other one.
  const teamSettingsA = field(areaItems(exportedA, "workbot.team-settings")[0]?.spec, "settings")
  const teamSettingsC = field(areaItems(exportedC, "workbot.team-settings")[0]?.spec, "settings")
  assert.equal(field(teamSettingsA, "model"), teamModelA)
  const teamModelC = field(teamSettingsC, "model")
  assert.ok(typeof teamModelC === "string" && aliasesC.includes(teamModelC) && teamModelC !== orgModelC, `${String(teamModelC)} is the other one of ${aliasesC.join(", ")}`)
  assert.equal(field(teamSettingsC, "name"), "Scout")
  assert.deepEqual(areaItems(exportedC, "workbot.team-settings")[0]?.spec.gatewayModel, areaItems(exportedA, "workbot.team-settings")[0]?.spec.gatewayModel)

  // The same file again: nothing to write, nothing to answer.
  const again = await upload(apiC, exportedA, "Whole organization again")
  assert.deepEqual(writes(again.plan).map((entry) => `${label(entry)}:${entry.op}`), [], describe(writes(again.plan)))
  assert.equal(again.plan.summary.blocking, 0, describe(planItems(again.plan).filter(isBlocking)))
  await ok(apiC("POST", `/v1/config-blobs/change-requests/${again.id}/cancel`, {}), "cancel")
})

test("part of an organization, where what it references is missing: an entry goes with its reference, an item doesn't widen", async () => {
  const dan = await den.signUp("Dan Scoped")
  const orgD = await den.createOrg(dan, "First-pass partial")
  const apiD = den.as(dan, orgD.orgId)
  const drop = (entry: ConfigPlanItem, path: string) => ({ area: entry.area, ref: entry.ref, path, resolution: { drop: true as const } })
  const openPaths = (entry: ConfigPlanItem) => (entry.refs ?? []).filter((ref) => ref.resolvedId === null).map((ref) => ref.path)

  // A limit on one provider's spending, without the provider: leaving the provider out would make it a limit on everything.
  const limits = await upload(apiD, await exportOf(apiA, "ai-gateway.limits"), "Limits only")
  assert.ok(openPaths(item(limits.plan, "ai-gateway.limits", "Engineering spend")).includes("provider"), describe(planItems(limits.plan)))
  // The plan says so before anyone tries it, and only for that reference: the people it names can be left out or invited.
  const refusals = Object.fromEntries((item(limits.plan, "ai-gateway.limits", "Engineering spend").refs ?? []).map((ref) => [ref.path.replace(/\[\d+\]/g, "[]"), (ref.refuses ?? []).join(",")]))
  assert.deepEqual(refusals, { provider: "drop", "assignments.teams[]": "", "assignments.members[]": "" }, JSON.stringify(refusals))
  let plan = await decide(apiD, limits.id, { skips: [], refs: planItems(limits.plan).flatMap((entry) => openPaths(entry).map((path) => drop(entry, path))) })
  const refused = item(plan, "ai-gateway.limits", "Engineering spend")
  assert.ok(refused.flags.includes("ref_unresolved"), describe([refused]))
  assert.match(reasons(refused), /provider.*can't be dropped \(this item can't be imported without it\): choose one here, or skip the item/)
  await ok(apiD("POST", `/v1/config-blobs/change-requests/${limits.id}/cancel`, {}), "cancel")

  // A Smart Router without the provider its models use: with every model left out, no model would be left.
  const routerBlob = await exportOf(apiA, "ai-gateway.smart-routers")
  const routers = await upload(apiD, routerBlob, "Smart routers only")
  const router = item(routers.plan, "ai-gateway.smart-routers", "Smart Engineering")
  assert.ok(router.flags.includes("ref_unresolved"), describe([router]))
  const modelRefs = openPaths(router).filter((path) => /^models\[\d+\]\.provider$/.test(path))
  assert.equal(modelRefs.length, 2, openPaths(router).join(", "))
  plan = await decide(apiD, routers.id, { skips: [], refs: openPaths(router).map((path) => drop(router, path)) })
  const emptied = item(plan, "ai-gateway.smart-routers", "Smart Engineering")
  assert.ok(emptied.flags.includes("blocked"), describe([emptied]))
  assert.match(reasons(emptied), /would have no model left: every provider its models use was dropped/)
  await ok(apiD("POST", `/v1/config-blobs/change-requests/${routers.id}/cancel`, {}), "cancel")

  // With a provider chosen here for one model and the other's left out, that model goes and the router keeps the first.
  const providerD = await ok(apiD("POST", "/v1/inference-providers", { name: "Fixture OpenAI", providerId: "openai", modelIds: ["gpt-6-luna", "gpt-fixture-other"] }), "gateway provider")
  const partial = await upload(apiD, routerBlob, "Smart routers, one model left out")
  const kept = item(partial.plan, "ai-gateway.smart-routers", "Smart Engineering")
  plan = await decide(apiD, partial.id, { skips: [], refs: [
    ...openPaths(kept).filter((path) => path !== "models[1].provider").map((path) => drop(kept, path)),
    { area: kept.area, ref: kept.ref, path: "models[1].provider", resolution: { targetId: text(field(providerD.body, "inferenceProvider", "id"), "provider id") } },
  ] })
  const narrowed = item(plan, "ai-gateway.smart-routers", "Smart Engineering")
  assert.deepEqual(narrowed.flags.filter((flag) => BLOCKING.includes(flag)), [], describe([narrowed]))
  assert.match(reasons(narrowed), /warning: 1 of the 2 models of "Smart Engineering" is left out: its provider was dropped\./)
  await ok(apiD("POST", `/v1/config-blobs/change-requests/${partial.id}/cancel`, {}), "cancel")

  // A desktop policy without the team and the person it is assigned to. The file carries neither area, so the plan
  // lists what is already here to point them at: otherwise all that is left is leaving them out.
  const rae: Member = await den.newMember(dan, orgD.orgId, "Rae Reviewer")
  const reviewers = await den.createTeam(dan, orgD.orgId, "Reviewers", [rae.memberId])
  await ok(apiD("POST", "/v1/permissions/sets", { name: "Desktop policies", teamIds: [reviewers], permissions: ["desktop_policies.view", "desktop_policies.manage"].map((key) => ({ key, status: "allow" })) }), "role")
  const policies = await upload(apiD, await exportOf(apiA, "desktop-policies"), "Desktop policies only")
  const policy = item(policies.plan, "desktop-policies", "Engineering")
  assert.deepEqual(openPaths(policy).sort(), ["assignments.members[0]", "assignments.teams[0]"], describe([policy]))
  const listed = Object.fromEntries((policies.plan.refTargets ?? []).map((entry) => [entry.area, entry.items]))
  assert.deepEqual(listed, {
    "members.teams": [{ id: reviewers, name: "Reviewers" }],
    "members.people": [{ id: orgD.owner.memberId, name: dan.name }, { id: rae.memberId, name: rae.name }],
  }, JSON.stringify(policies.plan.refTargets))
  // Someone who may read this request but neither teams nor people is shown the plan without them.
  const asRae = asPlan(field((await ok(den.as(rae, orgD.orgId)("GET", `/v1/config-blobs/change-requests/${policies.id}/plan`), "plan of a reviewer")).body, "plan"))
  assert.equal(asRae.planHash, policies.plan.planHash)
  assert.equal(asRae.refTargets, undefined, JSON.stringify(asRae.refTargets))
  assert.ok(!JSON.stringify(asRae).includes(dan.name), "the reviewer's plan names a member")
  // Pointed at the team and the person here, the policy goes in with both.
  plan = await decide(apiD, policies.id, { skips: [], refs: [
    { area: policy.area, ref: policy.ref, path: "assignments.teams[0]", resolution: { targetId: reviewers } },
    { area: policy.area, ref: policy.ref, path: "assignments.members[0]", resolution: { targetId: rae.memberId } },
  ] })
  const pointed = item(plan, "desktop-policies", "Engineering")
  assert.deepEqual((pointed.refs ?? []).map((ref) => `${ref.path}: ${ref.via} ${ref.resolvedId}`).sort(), [`assignments.members[0]: decision ${rae.memberId}`, `assignments.teams[0]: decision ${reviewers}`])
  assert.deepEqual(pointed.flags.filter((flag) => BLOCKING.includes(flag)), [], describe([pointed]))
  assert.deepEqual((plan.refTargets ?? []).map((entry) => entry.area).sort(), ["members.people", "members.teams"], "the choices stay listed once made")
  await ok(apiD("POST", `/v1/config-blobs/change-requests/${policies.id}/cancel`, {}), "cancel")
})

test("no transaction sent a statement before the previous one answered", () => {
  assert.deepEqual(production.concurrentStatements, [])
})
