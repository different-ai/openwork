/**
 * On a deployment with the AI Gateway and a sandbox key, every new sandbox gets an AI Gateway provider that every
 * member who joins can use, and its workshop connectors, without anyone configuring them.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, list, summary, text } from "./harness.js"

const restoreCatalog = stubPublicModelCatalog()
const den = await bootDen({ env: {
  ...gatewayFixtureEnv,
  DEN_DEPLOYMENT: "cloud",
  DEN_SANDBOX_WORKPLACE_URL: "https://workplace.example.test",
  DEN_SANDBOX_GATEWAY_PROVIDER: "openai",
  DEN_SANDBOX_GATEWAY_MODELS: "gpt-6-luna",
  DEN_SANDBOX_GATEWAY_API_KEY: "sandbox-fixture-openai-key",
} })
after(async () => { restoreCatalog(); await den.close() })

const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)

test("a new sandbox gets the workshop connectors and a Luna AI Gateway provider every joiner can use", async () => {
  const listed = await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")
  assert.deepEqual(field(listed.body, "defaults"), { workplaceUrl: "https://workplace.example.test", gatewayModels: ["gpt-6-luna"], gatewayProviderId: "openai", creditUsd: null }, summary(listed), "a shared key has no per-sandbox credit")

  const created = await den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", { body: {
    name: "Gateway sandbox", connectorBaseUrl: "https://workplace.example.test", days: 7, memberLimit: 5, allowedEmailDomains: [],
  } })
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  assert.equal(field(sandbox, "connectorCount"), 5)
  assert.equal(field(sandbox, "modelProviderCount"), 1)
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  const token = text(new URL(text(field(sandbox, "joinLink"), "join link")).searchParams.get("token"), "join token")

  const person = await den.signUp("Gateway Joiner")
  assert.equal((await den.request(person.token, "POST", "/v1/sandbox-join", { body: { token } })).status, 200)
  const usable = await den.request(person.token, "GET", "/v1/inference-providers?scope=usable", { orgId })
  assert.equal(usable.status, 200, summary(usable))
  const providers = list(field(usable.body, "inferenceProviders"))
  const models = providers.flatMap(provider => list(field(provider, "models")))
  assert.ok(models.some(model => field(model, "upstreamModelId") === "gpt-6-luna"), `the joiner can use Luna: ${summary(usable)}`)
  assert.ok(!JSON.stringify(usable.body).includes("sandbox-fixture-openai-key"), "the key is never shown to members")
})
