import assert from "node:assert/strict"
import { test } from "node:test"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-automation-authority-test-key-0000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-automation-authority-secret-0000"
process.env.DEN_BASE_URL ??= "https://console.example.test"
const { resolveAutomationModelAccessWithStore } = await import("../src/automations/authority.js")
type Store = Parameters<typeof resolveAutomationModelAccessWithStore>[1]

const scope = { organizationId: "org_01k0000000000000000000000a", ownerMemberId: "member_01k0000000000000000000000a" }

function store(overrides: Partial<Store> = {}): Store {
  return {
    findActiveMember: async () => ({ id: "member_01k0000000000000000000000a" }),
    findOpenWorkProvider: async () => null,
    findProvider: async () => null,
    findModel: async () => null,
    canAccessProvider: async () => false,
    ...overrides,
  }
}

test("a Desktop Automation can use a model only its desktop has", async () => {
  for (const providerId of ["nvidia", "opencode-go", "google", "ipr_01k0000000000000000000000a", "openwork-auto"]) {
    const result = await resolveAutomationModelAccessWithStore({ ...scope, providerId, modelId: "some-model", executionTarget: "desktop" }, store())
    assert.equal(result.ok, true, providerId)
    if (result.ok) assert.equal(result.value.accessKind, "desktop_runtime")
  }
})

test("a Cloud Automation still refuses a model only a desktop has", async () => {
  for (const providerId of ["nvidia", "ipr_01k0000000000000000000000a"]) {
    const result = await resolveAutomationModelAccessWithStore({ ...scope, providerId, modelId: "some-model", executionTarget: "cloud" }, store())
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "provider_unavailable")
  }
})

test("a desktop-only model still needs an active owner", async () => {
  const result = await resolveAutomationModelAccessWithStore(
    { ...scope, providerId: "nvidia", modelId: "some-model", executionTarget: "desktop" },
    store({ findActiveMember: async () => null }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "owner_membership_lost")
})

test("Den providers keep their grant checks and Zen stays refused on a desktop", async () => {
  const provider = { id: "lpr_01k0000000000000000000000a", source: "custom" as const, name: "Team", providerConfig: {} }
  const revoked = await resolveAutomationModelAccessWithStore(
    { ...scope, providerId: provider.id, modelId: "team-model", executionTarget: "desktop" },
    store({ findProvider: async () => provider, findModel: async () => ({ modelId: "team-model", name: "Team model" }) }),
  )
  assert.equal(revoked.ok, false)
  if (!revoked.ok) assert.equal(revoked.code, "model_access_lost")

  const zen = await resolveAutomationModelAccessWithStore({ ...scope, providerId: "opencode", modelId: "big-pickle", executionTarget: "desktop" }, store())
  assert.equal(zen.ok, false)

  const openwork = await resolveAutomationModelAccessWithStore({ ...scope, providerId: "openwork", modelId: "unknown", executionTarget: "desktop" }, store())
  assert.equal(openwork.ok, false)
})
