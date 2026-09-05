import { beforeAll, describe, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type {
  AutomationAuthorityMember,
  AutomationAuthorityModel,
  AutomationAuthorityProvider,
  AutomationModelAuthorityStore,
} from "../src/automations/authority.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
}

let resolveAutomationModelAccessWithStore: typeof import("../src/automations/authority.js")["resolveAutomationModelAccessWithStore"]
let isActiveAutomationOwnerWithStore: typeof import("../src/automations/authority.js")["isActiveAutomationOwnerWithStore"]

beforeAll(async () => {
  seedRequiredEnv()
  ;({ resolveAutomationModelAccessWithStore, isActiveAutomationOwnerWithStore } = await import("../src/automations/authority.js"))
})

const member: AutomationAuthorityMember = { id: createDenTypeId("member") }
const openWorkProvider: AutomationAuthorityProvider = {
  id: createDenTypeId("llmProvider"),
  source: "openwork",
  name: "OpenWork Models",
}
const customProvider: AutomationAuthorityProvider = {
  id: createDenTypeId("llmProvider"),
  source: "custom",
  name: "Team Provider",
}
const customModel: AutomationAuthorityModel = {
  modelId: "team-model",
  name: "Team Model",
}

function authorityStore(overrides: Partial<AutomationModelAuthorityStore> = {}): AutomationModelAuthorityStore {
  return {
    async findActiveMember() { return member },
    async findOpenWorkProvider() { return openWorkProvider },
    async findProvider() { return customProvider },
    async findModel() { return customModel },
    async canAccessProvider() { return true },
    async allowsZenModel() { return true },
    ...overrides,
  }
}

const base = { organizationId: "org_test", ownerMemberId: member.id }

describe("Automation normalized model authority", () => {
  test("accepts only the exact free starter model without resolving a credential", async () => {
    let providerLookups = 0
    const store = authorityStore({
      async findProvider() {
        providerLookups += 1
        return customProvider
      },
    })

    const result = await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: "opencode",
      modelId: "big-pickle",
    }, store)

    expect(result).toMatchObject({
      ok: true,
      value: {
        accessKind: "free",
        providerRecordId: null,
        providerId: "opencode",
        modelId: "big-pickle",
      },
    })
    expect(providerLookups).toBe(0)

    expect(await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: "opencode",
      modelId: "not-a-free-model",
    }, store)).toMatchObject({ ok: false, code: "model_access_lost" })
  })

  test("rejects the legacy free starter model when desktop policy disables OpenCode Zen", async () => {
    const result = await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: "opencode",
      modelId: "big-pickle",
    }, authorityStore({ async allowsZenModel() { return false } }))

    expect(result).toMatchObject({
      ok: false,
      code: "model_access_lost",
      message: expect.stringContaining("Choose a supported model"),
    })
  })

  test("resolves enabled OpenWork aliases through the owner's managed provider", async () => {
    const savedSelection = { ...base, providerId: "openwork", modelId: "z-ai/glm-5.2", variant: "medium" }
    expect(await resolveAutomationModelAccessWithStore(savedSelection, authorityStore())).toMatchObject({ ok: true })
    expect(savedSelection.variant).toBe("medium")
    expect(await resolveAutomationModelAccessWithStore(savedSelection, authorityStore({ async canAccessProvider() { return false } }))).toMatchObject({ ok: false, code: "model_access_lost" })
    const result = await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: "openwork",
      modelId: "z-ai/glm-5.2",
    }, authorityStore())

    expect(result).toMatchObject({
      ok: true,
      value: {
        accessKind: "openwork_managed",
        providerRecordId: openWorkProvider.id,
        providerId: "openwork",
        modelId: "z-ai/glm-5.2",
      },
    })

    expect(await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: "openwork",
      modelId: "unknown/model",
    }, authorityStore())).toMatchObject({ ok: false, code: "model_access_lost" })
  })

  test("requires both the selected custom model and current member or team access", async () => {
    const result = await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: customProvider.id,
      modelId: customModel.modelId,
    }, authorityStore())

    expect(result).toMatchObject({
      ok: true,
      value: {
        accessKind: "authorized_custom",
        providerRecordId: customProvider.id,
        providerId: customProvider.id,
        modelId: customModel.modelId,
      },
    })

    expect(await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: customProvider.id,
      modelId: customModel.modelId,
    }, authorityStore({ async canAccessProvider() { return false } }))).toMatchObject({
      ok: false,
      code: "model_access_lost",
    })

    expect(await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: customProvider.id,
      modelId: "removed-model",
    }, authorityStore({ async findModel() { return null } }))).toMatchObject({
      ok: false,
      code: "model_access_lost",
    })
  })

  test("never lets a removed membership inherit model access", async () => {
    const result = await resolveAutomationModelAccessWithStore({
      ...base,
      providerId: "opencode",
      modelId: "big-pickle",
    }, authorityStore({ async findActiveMember() { return null } }))

    expect(result).toMatchObject({ ok: false, code: "owner_membership_lost" })
  })

  test("a runner owner is only active while their membership row is live", async () => {
    expect(await isActiveAutomationOwnerWithStore(base, authorityStore())).toBe(true)
    expect(await isActiveAutomationOwnerWithStore(
      base,
      authorityStore({ async findActiveMember() { return null } }),
    )).toBe(false)
  })
})
