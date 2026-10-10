import assert from "node:assert/strict"
import { test } from "node:test"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
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

const { checkWorkbotModelChoice, organizationModelPolicy, slackAssistantModel, workbotSettingsView } = await import("../src/workbot/model.ts")
const { chooseModel } = await import("../src/automations/headless-agent-executor.ts")

const catalog = {
  defaultModel: "gateway/runner-default",
  models: [
    { id: "gateway/runner-default", name: "Runner default" },
    { id: "gateway/model-a", name: "Model A" },
    { id: "gateway/model-b", name: "Model B" },
  ],
}
const on = async () => ({ workbot: true, workbotDefaultModel: true })

test("the default model applies only while Workbot and its feature are on", async () => {
  let reads = 0
  const chosenModel = async () => {
    reads += 1
    return "gateway/model-a"
  }
  for (const features of [
    { workbot: false, workbotDefaultModel: true },
    { workbot: true, workbotDefaultModel: false },
    { workbot: false, workbotDefaultModel: false },
  ]) {
    assert.deepEqual(await organizationModelPolicy("org_1", { features: async () => features, chosenModel, catalog: async () => catalog }), { enabled: false, model: null })
  }
  // Off ignores the saved value without reading it.
  assert.equal(reads, 0)
})

test("unset, unavailable and available saved models", async () => {
  const policy = (chosen: string | null, served = catalog) =>
    organizationModelPolicy("org_1", { features: on, chosenModel: async () => chosen, catalog: async () => served })
  assert.deepEqual(await policy(null), { enabled: true, model: null })
  assert.deepEqual(await policy("gateway/model-a"), { enabled: true, model: "gateway/model-a" })
  // A model the runner no longer lists falls back to the runner's default, so chats keep working.
  assert.deepEqual(await policy("gateway/removed"), { enabled: true, model: null })
  // A runner that can't be asked right now: keep the choice; the send itself reports the outage.
  assert.deepEqual(
    await organizationModelPolicy("org_1", { features: on, chosenModel: async () => "gateway/model-a", catalog: async () => null }),
    { enabled: true, model: "gateway/model-a" },
  )
})

test("Slack uses the organization default while on, and its own model while off", async () => {
  const installation = { organizationId: "org_1", model: "gateway/model-b" }
  const off = async () => ({ workbot: true, workbotDefaultModel: false })
  assert.equal(await slackAssistantModel(installation, { features: off, catalog: async () => catalog }), "gateway/model-b")
  assert.equal(await slackAssistantModel({ ...installation, model: null }, { features: off }), undefined)
  assert.equal(
    await slackAssistantModel(installation, { features: on, chosenModel: async () => "gateway/model-a", catalog: async () => catalog }),
    "gateway/model-a",
  )
  // On with no default chosen: the runner's default, not the installation's old pick.
  assert.equal(await slackAssistantModel(installation, { features: on, chosenModel: async () => null, catalog: async () => catalog }), undefined)
  // A failed read keeps Slack answering as it did before.
  assert.equal(
    await slackAssistantModel(installation, { features: async () => { throw new Error("db_down") } }),
    "gateway/model-b",
  )
})

test("only a model the runner serves can be saved", () => {
  assert.equal(checkWorkbotModelChoice(null, null), "ok")
  assert.equal(checkWorkbotModelChoice(null, catalog), "ok")
  assert.equal(checkWorkbotModelChoice("gateway/model-a", catalog), "ok")
  assert.equal(checkWorkbotModelChoice("gateway/unknown", catalog), "unknown_model")
  assert.equal(checkWorkbotModelChoice("gateway/model-a", null), "runner_unavailable")

  assert.equal(workbotSettingsInputSchema.safeParse({ model: "" }).success, false)
  assert.equal(workbotSettingsInputSchema.safeParse({ model: "gateway/model-a", locked: true }).success, false)
  assert.equal(workbotSettingsInputSchema.safeParse({}).success, false)
  assert.deepEqual(workbotSettingsInputSchema.parse({ model: null }), { model: null })
})

test("the admin page sees whether the saved model is still served", () => {
  assert.deepEqual(workbotSettingsView("gateway/model-a", catalog), {
    model: "gateway/model-a",
    defaultModel: "gateway/runner-default",
    models: catalog.models,
    modelAvailable: true,
    runnerReachable: true,
  })
  assert.equal(workbotSettingsView("gateway/removed", catalog).modelAvailable, false)
  assert.deepEqual(workbotSettingsView("gateway/model-a", null), {
    model: "gateway/model-a",
    defaultModel: null,
    models: [],
    modelAvailable: true,
    runnerReachable: false,
  })
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

test("Automations on the cloud default run on the organization default; their own model is kept", async () => {
  let listed = 0
  const client = {
    listModels: async () => {
      listed += 1
      return catalog
    },
  }
  const cloudDefault = { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId }
  assert.deepEqual(await chooseModel(client, cloudDefault, "gateway/model-a"), { model: "gateway/model-a", warning: null })
  assert.deepEqual(await chooseModel(client, cloudDefault, null), { model: undefined, warning: null })
  assert.deepEqual(await chooseModel(client, cloudDefault), { model: undefined, warning: null })
  assert.equal(listed, 0)

  const explicit = { providerId: "openwork", modelId: "gateway/model-b" }
  assert.deepEqual(await chooseModel(client, explicit, "gateway/model-a"), { model: "gateway/model-b", warning: null })
  const gone = await chooseModel(client, { providerId: "openwork", modelId: "gateway/removed" }, "gateway/model-a")
  assert.equal(gone.model, undefined)
  assert.equal(gone.warning?.payload.code, "headless_default_model")
})
