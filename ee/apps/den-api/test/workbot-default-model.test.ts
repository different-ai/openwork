import assert from "node:assert/strict"
import { test } from "node:test"
import { readWorkbotModel, withWorkbotModel, workbotSettingsInputSchema } from "@openwork/types/den/workbot-settings"

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

const { checkWorkbotModelChoice, organizationModelPolicy, workbotSettingsView } = await import("../src/workbot/model.ts")

const catalog = {
  verified: true,
  defaultModel: "gateway/runner-default",
  models: [
    { id: "gateway/runner-default", name: "Runner default" },
    { id: "gateway/model-a", name: "Model A" },
    { id: "gateway/model-b", name: "Model B" },
  ],
}
test("unset, unavailable and available saved models", async () => {
  const policy = (chosen: string | null, served = catalog) =>
    organizationModelPolicy("org_1", { chosenModel: async () => chosen, catalog: async () => served })
  assert.deepEqual(await policy(null), { enabled: true, model: null })
  assert.deepEqual(await policy("gateway/model-a"), { enabled: true, model: "gateway/model-a" })
  // A model the runner no longer lists falls back to the runner's default, so chats keep working.
  assert.deepEqual(await policy("gateway/removed"), { enabled: true, model: null })
  // A runner that can't be asked right now: keep the choice; the send itself reports the outage.
  assert.deepEqual(
    await organizationModelPolicy("org_1", { chosenModel: async () => "gateway/model-a", catalog: async () => null }),
    { enabled: true, model: "gateway/model-a" },
  )
})

test("only a model the runner serves can be saved", () => {
  assert.equal(checkWorkbotModelChoice(null, null), "ok")
  assert.equal(checkWorkbotModelChoice(null, catalog), "ok")
  assert.equal(checkWorkbotModelChoice("gateway/model-a", catalog), "ok")
  assert.equal(checkWorkbotModelChoice("gateway/unknown", catalog), "unknown_model")
  assert.equal(checkWorkbotModelChoice("gateway/model-a", null), "runner_unavailable")
  assert.equal(checkWorkbotModelChoice("gateway/model-a", { ...catalog, verified: false }), "runner_unavailable")

  assert.equal(workbotSettingsInputSchema.safeParse({ model: "" }).success, false)
  assert.equal(workbotSettingsInputSchema.safeParse({ model: "gateway/model-a", locked: true }).success, false)
  assert.equal(workbotSettingsInputSchema.safeParse({}).success, false)
  assert.deepEqual(workbotSettingsInputSchema.parse({ model: null }), { model: null })
})

test("Gateway settings use the actor's exact default alias, never a display-name match or runner fallback", () => {
  const scoped = {
    verified: true,
    defaultModel: "gwm_exact_default",
    models: [{ id: "gwm_exact_default", name: "Assigned Luna" }, { id: "gwm_other", name: "GPT-6 Luna" }],
  }
  const view = workbotSettingsView(null, scoped)
  assert.equal(view.defaultModel, "gwm_exact_default")
  assert.equal(view.defaultReadiness, "available")
  assert.equal(view.gatewayModels, true)
  assert.equal(workbotSettingsView(null, { ...scoped, models: [scoped.models[1]!] }).defaultReadiness, "unavailable")
  assert.equal(workbotSettingsView(null, null).defaultReadiness, "unverified")
  // An unreachable catalog still names the model Workbot will ask for, so the page never shows an empty default.
  assert.equal(workbotSettingsView(null, null).defaultModel, "openai/gpt-6-luna")
  assert.equal(workbotSettingsView("removed_alias", scoped).modelAvailable, false)
})

test("the model is stored in organization metadata without touching anything else", () => {
  const metadata = { brandAppName: "Acme Helper", workbot: { other: 1 } }
  const saved = withWorkbotModel(metadata, "gateway/model-a")
  assert.deepEqual(saved, { brandAppName: "Acme Helper", workbot: { other: 1, model: "gateway/model-a" } })
  assert.equal(readWorkbotModel(saved), "gateway/model-a")
  assert.equal(readWorkbotModel(JSON.stringify(saved)), "gateway/model-a")
  assert.deepEqual(withWorkbotModel(saved, null), { brandAppName: "Acme Helper", workbot: { other: 1 } })
  assert.equal(readWorkbotModel(null), null)
  assert.equal(readWorkbotModel("not json"), null)
})
