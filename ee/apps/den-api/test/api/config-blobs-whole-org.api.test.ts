/**
 * Config blobs, whole organization, end to end through HTTP: organization A
 * is set up through the public API with something in as many of the 27 areas
 * as the API allows, exported whole, and imported into an empty organization
 * B (worker driven in-process): plan, secrets, decisions, approval from a
 * fresh sign-in, apply. Then B's export is compared with A's area by area
 * (ids and references normalized to names; intentional differences listed
 * below), A's blob is imported again (nothing to do: aliases and natural
 * keys), and B's own export is imported into B (all unchanged), counting the
 * statements a no-op apply makes.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigAreaKey, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem, ConfigSecretInput } from "@openwork/types/den/config-blobs"
import { CONFIG_AREA_KEYS } from "@openwork/types/den/config-blobs"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, isRecord, startFakeMcpServer, summary, text, type Call, type Session } from "./harness.js"

const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: {
  ...gatewayFixtureEnv,
  // Smart routers and OpenWork Models exist on cloud deployments only.
  DEN_DEPLOYMENT: "cloud",
  DEN_WORKBOT_URL: "http://localhost:3020",
  DEN_AUDIT_CAPTURE_ENABLED: "true",
  DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
} })
const mcpServer = await startFakeMcpServer({ tools: [{ name: "ping", description: "Ping", text: "pong" }] })
after(async () => {
  restoreFetch()
  await mcpServer.close()
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const { countDbQueries } = await import("../../src/observability/db-query-count.js")
const { client, db } = await import("../../src/db.js")
const { GatewayProviderCredentialTable } = await import("@openwork-ee/den-db/schema")
const { and, eq } = await import("@openwork-ee/den-db/drizzle")
const { AGENT_TEMPLATE_PATH } = await import("../../src/workbot-proactive/template.js")

const SECRETS = { byok: "sk-whole-byok-SECRET-1", gateway: "sk-whole-gateway-SECRET-1", oauth: "whole-oauth-client-SECRET-1", oidc: "whole-oidc-client-SECRET-1" }
const FEATURES: string[] = []
const skillMarkdown = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill of the whole-org round trip.\n---\n\n${body}\n`

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

function planItems(plan: ConfigPlan): ConfigPlanItem[] {
  return plan.areas.flatMap((area) => area.items)
}

function describe(items: readonly ConfigPlanItem[]): string {
  return JSON.stringify(items.map((item) => ({ area: item.area, name: item.blob?.name ?? item.target?.name, op: item.op, flags: item.flags, reasons: item.reasons, fields: item.fields.map((change) => change.path) })), null, 1)
}

/** `areas[a][b].items` of a blob, by area key. */
function areaItems(blob: ConfigBlob, key: string): Array<{ id?: string; key?: string | null; name: string; spec: Record<string, unknown> }> {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  const items = isRecord(node) && Array.isArray(node.items) ? node.items : []
  return JSON.parse(JSON.stringify(items))
}

async function drive(api: Api, id: string, done: (status: string) => boolean = (status) => !["uploaded", "analyzing", "queued", "applying", "stale"].includes(status)): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "change request"))
    if (done(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function planOf(api: Api, id: string): Promise<ConfigPlan> {
  return asPlan(field((await ok(api("GET", `/v1/config-blobs/change-requests/${id}/plan`), "plan")).body, "plan"))
}

async function exportWhole(api: Api): Promise<ConfigBlob> {
  const response = await ok(api("GET", "/v1/config-blobs/export"), "export")
  for (const secret of Object.values(SECRETS)) assert.ok(!response.text.includes(secret), "no secret value in an export")
  return asBlob(response.body)
}

async function upload(api: Api, blob: ConfigBlob, title: string): Promise<string> {
  const created = await ok(api("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title }), "upload")
  const request = asSummary(created)
  const analyzed = await drive(api, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  return request.id
}

/** A new sign-in of the same person: approving and applying need a recently signed-in session. */
async function freshSession(person: Session): Promise<Session> {
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  return { ...person, token: text(field(signedIn.body, "token"), "session token"), cookie: signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "" }
}

function asRuns(value: unknown): ConfigApplyReport[] {
  assert.ok(Array.isArray(value), "runs")
  return JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Comparing two exports: ids and references become names.

const TYPE_ID = /\b[a-z]{2,6}_[0-9a-z]{26}\b/g

/**
 * Every id an export holds (items, nested rows with a name or model id) → a
 * label that is the same on both organizations. References keep their area
 * and get the label of what they point at; ids nobody names are dropped.
 */
function idLabels(blob: ConfigBlob): Map<string, string> {
  const labels = new Map<string, string>()
  const visit = (value: unknown, area: string, owner: string) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, area, owner)
      return
    }
    if (!isRecord(value)) return
    if (typeof value.id === "string") {
      const name = typeof value.name === "string" ? value.name : typeof value.modelId === "string" ? value.modelId : typeof value.key === "string" ? value.key : null
      if (name !== null && !labels.has(value.id)) labels.set(value.id, `<${owner}:${name}>`)
    }
    for (const [key, child] of Object.entries(value)) if (key !== "$ref") visit(child, area, owner)
  }
  for (const key of CONFIG_AREA_KEYS) {
    for (const item of areaItems(blob, key)) {
      if (item.id) labels.set(item.id, `<${key}:${key === "members.people" ? String(item.spec.email) : item.name}>`)
      visit(item.spec, key, `${key}:${item.name}`)
    }
  }
  return labels
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

/** One area of an export, comparable across organizations. */
function portableArea(blob: ConfigBlob, key: ConfigAreaKey, labels: Map<string, string>, organizationId: string): unknown[] {
  const items = areaItems(blob, key).map((item) => {
    const out: Record<string, unknown> = { name: key === "members.people" ? String(item.spec.email) : item.name, spec: item.spec }
    if (item.key !== undefined && item.key !== null) out.key = item.key
    return out
  })
  const json = JSON.stringify(items, (name, value: unknown) => (name === "id" ? undefined : value))
    .replaceAll(organizationId, "<organization>")
    .replace(TYPE_ID, (id) => labels.get(id) ?? "<id>")
  return canonical(JSON.parse(json)) as unknown[]
}

// ---------------------------------------------------------------------------
// Organization A, set up through the public API.

const owner = await den.signUp("Whole Owner")
const orgA = await den.createOrg(owner, "Whole source")
const orgB = await den.createOrg(owner, "Whole clone")
for (const org of [orgA.orgId, orgB.orgId]) {
  for (const key of FEATURES) assert.equal((await den.setFeature(org, key, true)).status, 200, `${key} on`)
}
const apiA = den.as(owner, orgA.orgId)
const apiB = den.as(owner, orgB.orgId)

// Members: a team with a person, an admin, an invitation, a role, allowed domains.
const person = await den.newMember(owner, orgA.orgId, "Whole Person")
const admin = await den.newMember(owner, orgA.orgId, "Whole Admin", "admin")
const platform = await den.createTeam(owner, orgA.orgId, "Platform", [person.memberId])
await den.createTeam(owner, orgA.orgId, "Admins", [admin.memberId], { grantsOrganizationAdmin: true })
const invitedEmail = `whole-invited+${den.stamp}@example.test`
await ok(apiA("POST", "/v1/invitations", { email: invitedEmail, role: "member", teamId: platform }), "invite")
await ok(apiA("POST", "/v1/permissions/sets", { name: "Viewers", teamIds: [platform], permissions: [{ key: "teams.view", status: "allow" }] }), "role")
await ok(apiA("PATCH", "/v1/org", { allowedEmailDomains: ["example.test"] }), "allowed domains")
await ok(apiA("PUT", "/v1/org/automation-settings", { desktop: false }), "automation settings")
await ok(apiA("POST", "/v1/org/web-origins", { origin: "https://whole-source.example.com" }), "web origin")

// BYOK provider with a key, default models, agent permissions, prompts.
const byok = await ok(apiA("POST", "/v1/llm-providers", {
  name: "Acme LLM",
  source: "custom",
  customConfig: { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", env: ["ACME_API_KEY"], api: "https://llm.example.test/v1", models: [{ id: "acme-1", name: "Acme One" }, { id: "acme-2", name: "Acme Two" }] },
  apiKey: SECRETS.byok,
  teamIds: [platform],
}), "BYOK provider")
const byokId = text(field(byok.body, "llmProvider", "id"), "BYOK id")
await ok(apiA("PUT", "/v1/org/default-model/everyone", { model: { providerId: byokId, modelId: "acme-1" } }), "everyone model")
await ok(apiA("PUT", `/v1/org/default-model/teams/${platform}`, { model: { providerId: byokId, modelId: "acme-2" } }), "team model")
await ok(apiA("PUT", "/v1/agent-permissions/everyone", { settings: { commands: { decision: "ask", allow: ["npm test *"], block: ["rm -rf *"] }, webSearch: { decision: "deny" } } }), "everyone permissions")
await ok(apiA("PUT", `/v1/agent-permissions/teams/${platform}`, { settings: { websites: { decision: "deny", allow: ["docs.example.com"] } } }), "team permissions")
await ok(apiA("PUT", "/v1/org/prompts/everyone", { content: "Be concise." }), "everyone prompt")
await ok(apiA("PUT", `/v1/org/prompts/teams/${platform}`, { content: "Platform: prefer pnpm." }), "team prompt")

// AI Gateway: a catalog provider with a group, a shared key and a grant; a limit; a smart router.
const gateway = await ok(apiA("POST", "/v1/inference-providers", { name: "Fixture OpenAI", providerId: "openai", modelIds: ["gpt-6-luna", "gpt-fixture-other"] }), "gateway provider")
const gatewayId = text(field(gateway.body, "inferenceProvider", "id"), "gateway id")
const group = await ok(apiA("POST", `/v1/inference-providers/${gatewayId}/model-groups`, { name: "All", modelIds: ["gpt-6-luna", "gpt-fixture-other"] }), "model group")
const set = await ok(apiA("POST", `/v1/inference-providers/${gatewayId}/credential-sets`, { name: "Shared", credentialMode: "org", credential: { kind: "api_key", secret: SECRETS.gateway } }), "credential set")
await ok(apiA("POST", `/v1/inference-providers/${gatewayId}/access-grants`, {
  modelGroupId: text(field(group.body, "modelGroup", "id"), "group id"),
  credentialSetId: text(field(set.body, "credentialSet", "id"), "set id"),
  audience: { type: "team", teamId: platform },
}), "gateway grant")
const limit = await ok(apiA("POST", "/v1/gateway/usage-limit-policies", { name: "Engineering spend", providerId: gatewayId, hardLimit: true, allowRequestReset: false, limits: [{ timeframe: "month", costUsd: "200.5" }] }), "limit")
await ok(apiA("POST", `/v1/gateway/usage-limit-policies/${text(field(limit.body, "id"), "limit id")}/assignments`, { teamId: platform }), "limit assignment")
const router = await ok(apiA("POST", "/v1/org/auto-routers", { name: "Smart Engineering", models: [
  { providerId: gatewayId, modelId: "gpt-fixture-other", tasks: ["Code review"] },
  { providerId: gatewayId, modelId: "gpt-6-luna", tasks: ["Quick questions"] },
] }), "smart router")
await ok(apiA("PUT", `/v1/org/auto-routers/${text(field(router.body, "routerId"), "router id")}/assignment`, { assignment: { everyone: false, teamIds: [platform], memberIds: [] } }), "router assignment")

// Connectors: an OAuth app with a secret, a no-auth MCP connection, a desktop policy.
await ok(apiA("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "goog-client-id", clientSecret: SECRETS.oauth }), "OAuth app")
await ok(apiA("POST", "/v1/mcp-connections", { name: "Docs MCP", url: `${mcpServer.url}/mcp`, authType: "none", access: { orgWide: false, teamIds: [platform], memberIds: [person.memberId] } }), "MCP connection")
await ok(apiA("POST", "/v1/desktop-policies", { policyName: "Engineering", policy: { execution: { commands: "allow", blockedCommands: ["rm -rf /"] } }, priority: 5, teamIds: [platform], memberIds: [], roles: [] }), "desktop policy")

// Plugins: a collection, a plugin in it, a skill in the plugin; a GitHub source.
const marketplace = await ok(apiA("POST", "/v1/marketplaces", { name: "Research tools", description: "Tools for research" }), "collection")
const marketplaceId = text(field(marketplace.body, "item", "id"), "collection id")
await ok(apiA("POST", `/v1/marketplaces/${marketplaceId}/access`, { teamId: platform, role: "viewer" }), "collection grant")
const plugin = await ok(apiA("POST", "/v1/plugins", { name: "Research", description: "Research helpers" }), "plugin")
const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
await ok(apiA("POST", `/v1/plugins/${pluginId}/access`, { teamId: platform, role: "viewer" }), "plugin grant")
await ok(apiA("POST", `/v1/marketplaces/${marketplaceId}/plugins`, { pluginId }), "plugin in collection")
const skill = await ok(apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("summarize", "Summarize the sources first.") } }), "skill")
await ok(apiA("POST", `/v1/config-objects/${text(field(skill.body, "item", "id"), "skill id")}/access`, { orgWide: true, role: "viewer" }), "skill grant")
const account = await ok(apiA("POST", "/v1/connector-accounts", { connectorType: "github", remoteId: "515151", displayName: "acme", externalAccountRef: "acme" }), "GitHub account")
await ok(apiA("POST", "/v1/connector-instances", { connectorAccountId: text(field(account.body, "item", "id"), "account id"), connectorType: "github", name: "Acme docs", remoteId: "acme/docs", config: { autoImportNewPlugins: false, installationId: 515151 } }), "source")

// Settings and Workbot: brand name, audit capture, sign-in settings, members' agents (saves the "Your agent" template).
await ok(apiA("PATCH", "/v1/org", { brandAppName: "Acme Work", brandAccentColor: "#ff6600" }), "brand")
await ok(apiA("PATCH", "/v1/org", { sessionLengthHours: 24, maxSessionLengthDays: 14 }), "session settings")
const issuer = `https://idp-${den.stamp}.example.test`
await ok(apiA("POST", "/v1/sso/oidc", {
  issuer, domain: `whole-${den.stamp}.example.test`, clientId: "oidc-client-id", clientSecret: SECRETS.oidc, skipDiscovery: true,
  authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksEndpoint: `${issuer}/jwks`, name: "Okta",
}), "OIDC connection")
const usage = await ok(apiA("GET", "/v1/audit/usage"), "audit usage")
await ok(apiA("PATCH", "/v1/audit/settings", { captureOn: false, expectedRevision: Number(field(usage.body, "policy", "revision")) }), "audit off")
await ok(apiA("PUT", "/v1/org/workbot-settings/proactive", {
  enabled: true, leadMinutes: 30, startHour: 9, dailyCap: 5, membersStart: "opted_out",
  sources: { calendar: "members" }, responsibilities: { meeting_prep: false }, instructions: "Keep it short.",
}), "members' agents")
await ok(apiA("PUT", `/v1/org/workbot-settings/teams/${platform}`, { name: { inherit: false, value: "Scout" }, enabled: { inherit: false, value: false } }), "team Workbot settings")
// The "Your agent" template that save created, shared with everyone: still workbot.proactive's, never plugins.skills'.
if (!("getConnection" in client)) throw new Error("needs MySQL mode")
const [templates] = await client.query("SELECT id FROM config_object WHERE organization_id = ? AND current_relative_path = ?", [orgA.orgId, AGENT_TEMPLATE_PATH])
const templateId = Array.isArray(templates) && isRecord(templates[0]) ? String(templates[0].id) : ""
assert.ok(templateId, "the template object exists")
await ok(apiA("POST", `/v1/config-objects/${templateId}/access`, { orgWide: true, role: "viewer" }), "template shared")

// ---------------------------------------------------------------------------

/**
 * Intentional differences between A and B after the import, per area. Each
 * entry says why; anything else that differs fails the test.
 */
const INTENTIONAL: Partial<Record<ConfigAreaKey, string>> = {
  // An import invites people; it never makes them join (status is informational,
  // so B's people are "invited" and A's "active"), and names come from accounts.
  "members.people": "people are invited, not joined: status differs",
  // The GitHub App installation belongs to the instance and organization that made it:
  // the source is blocked at plan time (no account here) and skipped by the admin.
  "plugins.sources": "needs a GitHub installation on the target: skipped",
}

let exportedA: ConfigBlob
let importId = ""

test("export A: every area, no secret values", async () => {
  exportedA = await exportWhole(apiA)
  assert.deepEqual(exportedA.omitted ?? [], [], "nothing left out")
  assert.deepEqual([...exportedA.scope].sort(), [...CONFIG_AREA_KEYS].sort(), "all 27 areas")
  const empty = CONFIG_AREA_KEYS.filter((key) => areaItems(exportedA, key).length === 0)
  // Every feature this organization once turned on is now on for everyone, so no flag is left to export.
  assert.deepEqual(empty, FEATURES.length ? [] : ["settings.features"], "something in every other area")
  // Task 1: the "Your agent" template rides with workbot.proactive only.
  assert.ok(!areaItems(exportedA, "plugins.skills").some((item) => item.id === templateId || item.spec.type === "agent"), JSON.stringify(areaItems(exportedA, "plugins.skills").map((item) => [item.name, item.spec.type])))
})

test("import A into empty B: plan, secrets, decisions, fresh approval, apply", async () => {
  importId = await upload(apiB, exportedA, "Whole org")
  let plan = await planOf(apiB, importId)
  const items = planItems(plan)
  assert.deepEqual(items.filter((item) => item.op === "delete"), [], "merge never deletes")
  const writes = items.filter((item) => item.op !== "unchanged" && item.op !== "untouched" && item.op !== "skip")
  // Org-level singletons exist on every organization: they update; everything else is created.
  for (const item of writes) {
    assert.ok(item.op === "create" || item.matchedBy === "natural" || item.matchedBy === "key", `${item.area} ${item.blob?.name}: ${item.op} via ${item.matchedBy}`)
  }
  const blocked = items.filter((item) => item.flags.some((flag) => ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked"].includes(flag)))
  // Only the GitHub source is blocked (preflight: no installation here).
  assert.deepEqual(blocked.map((item) => `${item.area}:${item.blob?.name}`), ["plugins.sources:Acme docs"], describe(blocked))
  assert.ok(blocked[0]?.reasons?.some((reason) => reason.includes("connected here first")), describe(blocked))

  // Decisions: skip the source. Secrets: a value for every key the source had, unset otherwise.
  const decided = await ok(apiB("PUT", `/v1/config-blobs/change-requests/${importId}/decisions`, { skips: [{ area: "plugins.sources", ref: blocked[0]?.ref ?? "" }] }), "decisions")
  plan = asPlan(field(decided.body, "plan"))
  const secrets = planItems(plan).flatMap((item) => (item.op === "create" || item.op === "update" ? item.secrets ?? [] : []))
  const inputs = secrets.filter((secret) => secret.decision === null).map((secret): ConfigSecretInput => {
    if (!secret.sourceHadValue) return { path: secret.path, decision: "unset" }
    const value = secret.path.startsWith("ai-gateway.byok/") ? SECRETS.byok
      : secret.path.startsWith("ai-gateway.providers/") ? SECRETS.gateway
      : secret.path.startsWith("settings.auth-security/") ? SECRETS.oidc
      : SECRETS.oauth
    return { path: secret.path, decision: "value", value }
  })
  assert.ok(inputs.some((input) => input.decision === "value"), "keys to enter")
  const supplied = await ok(apiB("PUT", `/v1/config-blobs/change-requests/${importId}/inputs`, { inputs }), "inputs")
  plan = asPlan(field(supplied.body, "plan"))
  assert.equal(plan.summary.blocking, 0, describe(planItems(plan).filter((item) => item.flags.length > 0)))

  const fresh = den.as(await freshSession(owner), orgB.orgId)
  const queued = await ok(fresh("POST", `/v1/config-blobs/change-requests/${importId}/apply`, { planHash: plan.planHash }), "approve and apply")
  assert.equal(asSummary(queued).status, "queued")
  const applied = await drive(apiB, importId)
  const detail = await ok(apiB("GET", `/v1/config-blobs/change-requests/${importId}`), "detail")
  const runs = asRuns(field(detail.body, "runs"))
  assert.equal(applied.status, "applied", `${JSON.stringify(applied.errors)}\n${JSON.stringify(runs[0]?.items.filter((item) => item.status !== "applied" && item.status !== "noop"), null, 1)}`)
  assert.equal(runs.length, 1)
  const run = runs[0]
  assert.ok(run)
  assert.equal(run.counts.failed, 0)
  assert.equal(run.counts.not_reached, 0)
  assert.ok(run.items.every((item) => item.status === "applied" || item.status === "noop"), JSON.stringify(run.items.filter((item) => item.status !== "applied"), null, 1))
})

let exportedB: ConfigBlob

test("export B equals export A, area by area (ids and references by name)", async () => {
  exportedB = await exportWhole(apiB)
  const labelsA = idLabels(exportedA)
  const labelsB = idLabels(exportedB)
  const different: string[] = []
  for (const key of CONFIG_AREA_KEYS) {
    const left = portableArea(exportedA, key, labelsA, orgA.orgId)
    const right = portableArea(exportedB, key, labelsB, orgB.orgId)
    if (JSON.stringify(left) === JSON.stringify(right)) continue
    if (INTENTIONAL[key]) continue
    different.push(`${key}\nA: ${JSON.stringify(left)}\nB: ${JSON.stringify(right)}`)
  }
  assert.deepEqual(different, [], different.join("\n\n"))
  // The intentional differences, checked for what they are.
  const peopleA = areaItems(exportedA, "members.people").map((item) => String(item.spec.email)).sort()
  const peopleB = areaItems(exportedB, "members.people").map((item) => String(item.spec.email)).sort()
  assert.deepEqual(peopleB, peopleA, "the same people")
  assert.ok(areaItems(exportedB, "members.people").every((item) => item.spec.status === "invited" || item.spec.email === owner.email))
  assert.deepEqual(areaItems(exportedB, "plugins.sources"), [], "the source was skipped")
})

test("A's blob again into B: nothing to create, update or delete", async () => {
  const id = await upload(apiB, exportedA, "Whole org again")
  const plan = await planOf(apiB, id)
  const changed = planItems(plan).filter((item) => item.op === "create" || item.op === "update" || item.op === "rename" || item.op === "delete")
  // The skipped source is still missing (and still blocked); everything else matches B's items.
  assert.deepEqual(changed.map((item) => `${item.area}:${item.blob?.name}:${item.op}`), ["plugins.sources:Acme docs:create"], describe(changed))
  assert.ok(planItems(plan).some((item) => item.matchedBy === "alias"), "matched through the aliases of the first import")
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${id}/cancel`, {}), "cancel")
})

test("B's own export into B: all unchanged; a no-op apply writes nothing", async () => {
  const id = await upload(apiB, exportedB, "Own export")
  const plan = await planOf(apiB, id)
  const changed = planItems(plan).filter((item) => item.op !== "unchanged")
  assert.deepEqual(changed.map((item) => `${item.area}:${item.blob?.name ?? item.target?.name}:${item.op}`), [], describe(changed))
  const fresh = den.as(await freshSession(owner), orgB.orgId)
  await ok(fresh("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  const count = { count: 0 }
  await countDbQueries(count, () => runConfigBlobWorkerOnce())
  const settled = asSummary(await ok(apiB("GET", `/v1/config-blobs/change-requests/${id}`), "detail"))
  assert.equal(settled.status, "applied")
  const runs = asRuns(field((await ok(apiB("GET", `/v1/config-blobs/change-requests/${id}`), "detail")).body, "runs"))
  assert.equal(runs[0]?.items.length, 0, "no item written")
  // Claim, checks, run row and release; no area is exported or read.
  assert.ok(count.count < 60, `a no-op apply made ${count.count} statements`)
})

test("a new key for a credential set through an import: one update that writes just that key", async () => {
  const id = await upload(apiB, exportedB, "Rotate the gateway key")
  let plan = await planOf(apiB, id)
  const provider = planItems(plan).find((item) => item.area === "ai-gateway.providers")
  const secret = provider?.secrets?.find((entry) => entry.field.endsWith(".credential"))
  assert.ok(provider && secret, describe(planItems(plan)))
  assert.equal(secret.field, "credentialSets[id=Shared].credential", "sets are named by name in the plan")
  const rotated = "sk-whole-gateway-ROTATED-2"
  plan = asPlan(field((await ok(apiB("PUT", `/v1/config-blobs/change-requests/${id}/inputs`, { inputs: (provider.secrets ?? []).map((entry): ConfigSecretInput => entry.path === secret.path ? { path: entry.path, decision: "value", value: rotated } : { path: entry.path, decision: entry.targetHasValue ? "keep" : "unset" }) }), "inputs")).body, "plan"))
  const writes = planItems(plan).filter((item) => item.op !== "unchanged")
  assert.deepEqual(writes.map((item) => `${item.area}:${item.op}`), ["ai-gateway.providers:update"], describe(writes))
  assert.equal(plan.summary.blocking, 0, describe(writes))
  const fresh = den.as(await freshSession(owner), orgB.orgId)
  await ok(fresh("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  assert.equal((await drive(apiB, id)).status, "applied")
  const runs = asRuns(field((await ok(apiB("GET", `/v1/config-blobs/change-requests/${id}`), "detail")).body, "runs"))
  assert.deepEqual(runs[0]?.items.map((item) => [item.area, item.status, item.steps.map((step) => `${step.action} ${step.target}`)]), [["ai-gateway.providers", "applied", ["update credentialSets[Shared]"]]])
  const setId = areaItems(exportedB, "ai-gateway.providers")[0]?.spec.credentialSets
  const sharedSetId = Array.isArray(setId) && isRecord(setId[0]) ? String(setId[0].id) : ""
  const [row] = await db.select().from(GatewayProviderCredentialTable).where(and(eq(GatewayProviderCredentialTable.organization_id, orgB.orgId), eq(GatewayProviderCredentialTable.subject, "org")))
  assert.ok(sharedSetId && row, "the shared credential")
  assert.equal(row.secret, rotated, "the new key is stored")
})
