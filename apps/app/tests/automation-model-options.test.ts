import { describe, expect, test } from "bun:test"
import type { DenOrgLlmProvider } from "../src/app/lib/den"
import {
  automationModelOptions,
  automationPickerOptions,
  describeAutomationModel,
  resolveProposalModel,
} from "../src/react-app/domains/automations/automation-model-options"

function provider(input: Partial<DenOrgLlmProvider> & Pick<DenOrgLlmProvider, "id" | "name" | "source">): DenOrgLlmProvider {
  return {
    providerId: input.id,
    providerConfig: {},
    models: [],
    hasApiKey: true,
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

  test("removes the free starter model when desktop policy disables OpenCode Zen", () => {
    expect(automationModelOptions([], { includeFreeStarter: false })).toEqual([])
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
    // still lists with a Default recovery path, without invented reasoning levels.
    expect(free?.isFree).toBe(true)
    expect(free?.behaviorOptions?.map((option) => option.value)).toEqual([null])
  })

  test("preserves unknown saved settings only on the selected identity, even before runtime metadata arrives", () => {
    const options = automationModelOptions([
      provider({ id: "lpr_one", source: "custom", name: "One",
        models: [{ id: "same-model", name: "One model", config: {}, createdAt: null }] }),
      provider({ id: "lpr_two", source: "custom", name: "Two",
        models: [{ id: "same-model", name: "Two model", config: {}, createdAt: null }] }),
    ])
    const selected = { providerId: "lpr_one", modelId: "same-model", variant: "retired" }
    const picker = automationPickerOptions({ options, catalog: {}, selected })
    expect(picker.find((option) => option.providerID === "lpr_one")).toMatchObject({
      behaviorValue: "retired", behaviorLabel: '"retired" (not in current catalog)',
    })
    expect(picker.find((option) => option.providerID === "lpr_one")?.behaviorOptions?.map((option) => option.value)).toEqual([null])
    expect(picker.find((option) => option.providerID === "lpr_two")?.behaviorValue).toBeNull()
    expect(selected.variant).toBe("retired")
  })
})

describe("Automation proposal model resolution", () => {
  const customProvider = provider({
    id: "lpr_abc",
    providerId: "deepseek",
    source: "custom",
    name: "DeepSeek",
    models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", config: {}, createdAt: null }],
  })

  test("defaults an omitted model to the free starter model", () => {
    expect(resolveProposalModel(undefined, [])).toEqual({
      model: { providerId: "opencode", modelId: "big-pickle", variant: null },
      resolution: "default",
    })
  })

  test("preserves exact custom, free, and managed model identities", () => {
    const custom = { providerId: "lpr_abc", modelId: "deepseek-v4-flash", variant: "high" }
    expect(resolveProposalModel(custom, [customProvider])).toEqual({ model: custom, resolution: "exact" })

    const free = { providerId: "opencode", modelId: "big-pickle", variant: "low" }
    expect(resolveProposalModel(free, [])).toEqual({ model: free, resolution: "exact" })

    const managedProvider = provider({ id: "lpr_managed", source: "openwork", name: "OpenWork Models" })
    const managedOption = automationModelOptions([managedProvider]).find((option) => option.accessKind === "openwork_managed")
    expect(managedOption).toBeDefined()
    if (!managedOption) throw new Error("Expected an enabled OpenWork managed model")
    const managed = { providerId: managedOption.providerId, modelId: managedOption.modelId, variant: "high" }
    expect(resolveProposalModel(managed, [managedProvider])).toEqual({ model: managed, resolution: "exact" })
  })

  test("maps an upstream provider key only when the concrete Den provider is unambiguous", () => {
    const first = provider({ ...customProvider, id: "lpr_first" })
    const second = provider({ ...customProvider, id: "lpr_second" })
    expect(resolveProposalModel(
      { providerId: "deepseek", modelId: "deepseek-v4-flash", variant: "high" },
      [first],
    )).toEqual({
      model: { providerId: "lpr_first", modelId: "deepseek-v4-flash", variant: "high" },
      resolution: "mapped",
    })
    const proposed = { providerId: "deepseek", modelId: "deepseek-v4-flash", variant: "high" }
    expect(resolveProposalModel(proposed, [first, second])).toEqual({ model: proposed, resolution: "unavailable" })
  })

  test("does not map through OpenWork provider records", () => {
    const managed = provider({
      ...customProvider,
      id: "lpr_managed",
      source: "openwork",
    })
    expect(resolveProposalModel(
      { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      [managed],
    )).toEqual({
      model: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      resolution: "unavailable",
    })
  })

  test("never substitutes a free or paid model when a selection is unavailable", () => {
    for (const providerId of ["unknown", "deepseek", "lpr_abc"]) {
      const model = { providerId, modelId: "missing", variant: "high" }
      expect(resolveProposalModel(model, [customProvider])).toEqual({ model, resolution: "unavailable" })
    }
    expect(resolveProposalModel(undefined, [customProvider], { includeFreeStarter: false }).resolution).toBe("unavailable")
    const free = { providerId: "opencode", modelId: "big-pickle" }
    expect(resolveProposalModel(free, [customProvider], { includeFreeStarter: false }))
      .toEqual({ model: free, resolution: "unavailable" })
  })

  test("filters current runtime availability and provider restrictions without substituting a model", () => {
    const proposed = { providerId: "lpr_abc", modelId: "deepseek-v4-flash", variant: "high" }
    expect(resolveProposalModel(proposed, [customProvider], { catalog: {} }))
      .toEqual({ model: proposed, resolution: "unavailable" })
    expect(automationModelOptions([customProvider], { catalog: {} })).toEqual([])
    expect(automationModelOptions([customProvider], { includeFreeStarter: false })).toHaveLength(1)
    expect(automationModelOptions([{ ...customProvider, providerConfig: { blacklist: [proposed.modelId] } }], { includeFreeStarter: false })).toEqual([])
    expect(automationModelOptions([{ ...customProvider, providerConfig: { whitelist: ["different"] } }], { includeFreeStarter: false })).toEqual([])
    expect(automationModelOptions([{ ...customProvider, providerConfig: { whitelist: [] } }], { includeFreeStarter: false })).toEqual([])
    expect(automationModelOptions([{ ...customProvider, providerConfig: { blacklist: [] } }], { includeFreeStarter: false })).toHaveLength(1)
  })
})
