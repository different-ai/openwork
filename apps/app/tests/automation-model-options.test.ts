import { describe, expect, test } from "bun:test"
import type { DenOrgLlmProvider } from "../src/app/lib/den"
import { automationModelOptions } from "../src/react-app/domains/automations/automation-model-options"

function provider(input: Partial<DenOrgLlmProvider> & Pick<DenOrgLlmProvider, "id" | "name" | "source">): DenOrgLlmProvider {
  return {
    providerId: input.id,
    providerConfig: {},
    models: [],
    canManage: false,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...input,
  }
}

describe("Automation model options", () => {
  test("always offers the normalized free starter model", () => {
    expect(automationModelOptions([])).toEqual([{
      providerId: "opencode",
      modelId: "big-pickle",
      providerName: "OpenCode Zen",
      modelName: "Big Pickle",
      accessKind: "free",
    }])
  })

  test("expands the member's managed OpenWork aliases even when Den stores no model rows", () => {
    const options = automationModelOptions([
      provider({ id: "lpr_member_openwork", source: "openwork", name: "OpenWork Models" }),
    ])

    expect(options.some((option) => option.providerId === "openwork" && option.modelId === "z-ai/glm-5.2")).toBe(true)
    expect(options.some((option) => option.providerId === "lpr_member_openwork")).toBe(false)
  })

  test("keeps authorized custom providers on their concrete Den provider IDs", () => {
    const options = automationModelOptions([
      provider({
        id: "lpr_team",
        source: "custom",
        name: "Team Provider",
        models: [{ id: "team-model", name: "Team Model", config: {}, createdAt: "2026-08-03T00:00:00.000Z" }],
      }),
    ])

    expect(options).toContainEqual({
      providerId: "lpr_team",
      modelId: "team-model",
      providerName: "Team Provider",
      modelName: "Team Model",
      accessKind: "authorized_custom",
    })
  })
})
