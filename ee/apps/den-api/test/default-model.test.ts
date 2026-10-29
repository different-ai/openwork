import assert from "node:assert/strict"
import { test } from "node:test"
import {
  countDefaultModelConflicts,
  defaultModelWriteSchema,
  resolveDefaultModel,
  type DefaultModelOption,
} from "@openwork/types/den/default-model"
import { normalizeDesktopConfig } from "@openwork/types/den/desktop-policies"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const { checkDefaultModelChoice, desktopConfigDefaultModel, listDefaultModelOptions } = await import("../src/default-model.ts")

const orgId = "org_01k0000000000000000000000"
const memberId = "om_01k0000000000000000000000"
const opus = { providerId: "lpr_01k0000000000000000000001", modelId: "opus" }
const sonnet = { providerId: "ipr_01k0000000000000000000002", modelId: "claude-sonnet" }
const kimi = { providerId: "openwork", modelId: "moonshotai/kimi-k3" }

function option(choice: { providerId: string; modelId: string }, source: DefaultModelOption["source"]): DefaultModelOption {
  return { ...choice, providerName: "Provider", modelName: choice.modelId, logoProviderId: "anthropic", source }
}

test("a member with no team override gets the organization default, and nothing without one", () => {
  assert.deepEqual(resolveDefaultModel({ everyone: kimi, teams: [] }), { model: kimi, from: { kind: "organization", teamConflict: false } })
  assert.deepEqual(resolveDefaultModel({ everyone: kimi, teams: [{ name: "Sales", model: null }] }), { model: kimi, from: { kind: "organization", teamConflict: false } })
  assert.equal(resolveDefaultModel({ everyone: null, teams: [{ name: "Sales", model: null }] }), null)
})

test("a team override replaces the organization default for its members", () => {
  assert.deepEqual(
    resolveDefaultModel({ everyone: kimi, teams: [{ name: "Research", model: opus }, { name: "Sales", model: null }] }),
    { model: opus, from: { kind: "team", teamName: "Research" } },
  )
  // Also without an organization default.
  assert.deepEqual(resolveDefaultModel({ everyone: null, teams: [{ name: "Research", model: opus }] })?.model, opus)
})

test("teams that agree name the first team by name; teams that disagree fall back to the organization default", () => {
  assert.deepEqual(
    resolveDefaultModel({ everyone: kimi, teams: [{ name: "Zeta", model: opus }, { name: "Alpha", model: { ...opus } }] }),
    { model: opus, from: { kind: "team", teamName: "Alpha" } },
  )
  const conflict = { everyone: kimi, teams: [{ name: "Research", model: opus }, { name: "Design", model: sonnet }] }
  assert.deepEqual(resolveDefaultModel(conflict), { model: kimi, from: { kind: "organization", teamConflict: true } })
  // Order never changes the answer.
  assert.deepEqual(resolveDefaultModel({ ...conflict, teams: [...conflict.teams].reverse() }), resolveDefaultModel(conflict))
  // A conflict with no organization default leaves the desktop on its own default.
  assert.equal(resolveDefaultModel({ everyone: null, teams: conflict.teams }), null)
})

test("each team counts the members a conflicting team sends to the organization default", () => {
  const counts = countDefaultModelConflicts({
    teams: [{ teamId: "research", model: opus }, { teamId: "design", model: sonnet }, { teamId: "sales", model: null }, { teamId: "ops", model: opus }],
    memberships: [
      { teamId: "research", memberId: "a" }, { teamId: "design", memberId: "a" }, // a: conflict
      { teamId: "research", memberId: "b" }, { teamId: "ops", memberId: "b" }, // b: same model twice, no conflict
      { teamId: "design", memberId: "c" }, { teamId: "sales", memberId: "c" }, // c: sales inherits, no conflict
    ],
  })
  assert.deepEqual(Object.fromEntries(counts), { research: 1, design: 1, sales: 0, ops: 0 })
})

test("only models the organization has are accepted, and a source that could not be read answers unavailable", () => {
  const options = { options: [option(opus, "provider"), option(kimi, "openwork")], unavailableSources: ["gateway" as const] }
  assert.equal(checkDefaultModelChoice(opus, options), "ok")
  assert.equal(checkDefaultModelChoice({ ...opus, modelId: "made-up" }, options), "unknown_model")
  assert.equal(checkDefaultModelChoice(sonnet, options), "source_unavailable")
  assert.equal(checkDefaultModelChoice(sonnet, { ...options, unavailableSources: [] }), "unknown_model")
  assert.equal(defaultModelWriteSchema.safeParse({ model: null }).success, true)
  assert.equal(defaultModelWriteSchema.safeParse({ model: { providerId: "", modelId: "x" } }).success, false)
  assert.equal(defaultModelWriteSchema.safeParse({ model: opus, extra: true }).success, false)
})

test("the model list keeps the other sources when the AI Gateway fails, ordered OpenWork, Gateway, providers", async () => {
  const listed = await listDefaultModelOptions(orgId, {
    openwork: async () => [option(kimi, "openwork")],
    gateway: async () => { throw new Error("gateway down") },
    provider: async () => [option(opus, "provider")],
  })
  assert.deepEqual(listed.unavailableSources, ["gateway"])
  assert.deepEqual(listed.options.map((entry) => entry.source), ["openwork", "provider"])

  const all = await listDefaultModelOptions(orgId, {
    openwork: async () => [],
    gateway: async () => [option(sonnet, "gateway")],
    provider: async () => [option(opus, "provider")],
  })
  assert.deepEqual(all.options.map((entry) => entry.source), ["gateway", "provider"])
  assert.deepEqual(all.unavailableSources, [])
})

test("the desktop config always resolves the saved default model", async () => {
  let reads = 0
  const read = async () => {
    reads += 1
    return { providerID: opus.providerId, modelID: opus.modelId, source: "organization" as const }
  }
  assert.deepEqual(await desktopConfigDefaultModel({ organizationId: orgId, memberId }, read), { providerID: opus.providerId, modelID: opus.modelId, source: "organization" })
  assert.equal(reads, 1)
  // A failed lookup leaves desktops on their own default instead of failing the config.
  assert.equal(await desktopConfigDefaultModel({ organizationId: orgId, memberId }, async () => { throw new Error("db") }), null)
})

test("desktops parse the default model from their config, and ignore a malformed one", () => {
  const withModel = normalizeDesktopConfig({ defaultModel: { providerID: "openwork", modelID: "moonshotai/kimi-k3", source: "team", teamName: "Research" } })
  assert.deepEqual(withModel.defaultModel, { providerID: "openwork", modelID: "moonshotai/kimi-k3", source: "team", teamName: "Research" })
  assert.equal(normalizeDesktopConfig({ defaultModel: { providerID: "", modelID: "x", source: "team" } }).defaultModel, undefined)
  assert.equal(normalizeDesktopConfig({}).defaultModel, undefined)
})
