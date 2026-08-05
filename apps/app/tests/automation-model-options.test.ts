import { describe, expect, test } from "bun:test"
import type { DenOrgLlmProvider } from "../src/app/lib/den"
import {
  automationModelOptions,
  automationPickerOptions,
  describeAutomationModel,
} from "../src/react-app/domains/automations/automation-model-options"

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

  test("labels a stored model for people, and falls back to raw identity when access is gone", () => {
    const options = automationModelOptions([
      provider({
        id: "lpr_team",
        source: "custom",
        name: "Team Provider",
        models: [{ id: "team-model", name: "Team Model", config: {}, createdAt: "2026-08-03T00:00:00.000Z" }],
      }),
    ])

    expect(describeAutomationModel({ providerId: "lpr_team", modelId: "team-model" }, options))
      .toBe("Team Provider · Team Model")
    expect(describeAutomationModel({ providerId: "lpr_team", modelId: "team-model", variant: "high" }, options))
      .toBe("Team Provider · Team Model · high")
    // A revoked model must stay inspectable rather than render as a blank.
    expect(describeAutomationModel({ providerId: "lpr_gone", modelId: "vanished" }, options))
      .toBe("lpr_gone/vanished")
  })

  test("offers the runtime's reasoning levels for the selected model only", () => {
    const options = automationModelOptions([
      provider({
        id: "lpr_team",
        source: "custom",
        name: "Team Provider",
        models: [{ id: "team-model", name: "Team Model", config: {}, createdAt: "2026-08-03T00:00:00.000Z" }],
      }),
    ])
    const catalog = {
      lpr_team: {
        "team-model": {
          id: "team-model",
          name: "Team Model",
          variants: { low: {}, high: {} },
        },
      },
    } as never

    const picker = automationPickerOptions({
      options,
      catalog,
      selected: { providerId: "lpr_team", modelId: "team-model", variant: "high" },
    })
    const selected = picker.find((option) => option.modelID === "team-model")
    const free = picker.find((option) => option.modelID === "big-pickle")

    expect(selected?.behaviorValue).toBe("high")
    expect(selected?.behaviorOptions?.map((option) => option.value)).toContain("low")
    expect(selected?.isFree).toBe(false)
    // The free starter model is absent from the local catalog here, so it
    // still lists — just without reasoning levels.
    expect(free?.isFree).toBe(true)
    expect(free?.behaviorOptions).toEqual([])
  })
})
