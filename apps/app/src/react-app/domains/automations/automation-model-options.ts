import type { DenOrgLlmProvider } from "@/app/lib/den"
import { getModelBehaviorSummary } from "@/app/lib/model-behavior"
import type { ModelOption, ProviderListItem } from "@/app/types"
import type { AutomationModel } from "@openwork/types/automations"
import { AUTOMATION_FREE_MODEL, isDenAuthorizedAutomationProvider } from "@openwork/types/automations"
import {
  automationModelOptions as sharedAutomationModelOptions,
  compareAutomationModelOptions,
  findAutomationModelOption,
  type AutomationModelOption,
} from "@openwork/types/automation-models"

export type AutomationCatalogModel = ProviderListItem["models"][string] & { providerName?: string }

export type AutomationProviderCatalog = Record<string, Record<string, AutomationCatalogModel>>

export type { AutomationModelOption }

export type ResolvedProposalModel = {
  model: AutomationModel
  resolution: "exact" | "mapped" | "default" | "unavailable"
}

export type AutomationModelAvailability = {
  includeFreeStarter?: boolean
  includeCloudDefault?: boolean
  catalog?: AutomationProviderCatalog
}

export function automationModelOptions(
  providers: readonly DenOrgLlmProvider[],
  options: AutomationModelAvailability = {},
): AutomationModelOption[] {
  const { catalog, ...shared } = options
  const fromDen = sharedAutomationModelOptions(providers, shared)
  if (catalog === undefined) return fromDen
  return [
    ...fromDen.filter((model) => Boolean(catalog[model.providerId]?.[model.modelId])),
    ...desktopRuntimeModelOptions(catalog),
  ].sort(compareAutomationModelOptions)
}

function desktopRuntimeModelOptions(catalog: AutomationProviderCatalog): AutomationModelOption[] {
  return Object.entries(catalog)
    .filter(([providerId]) => !isDenAuthorizedAutomationProvider(providerId))
    .flatMap(([providerId, models]) => Object.entries(models).map(([modelId, model]): AutomationModelOption => ({
      providerId,
      modelId,
      providerName: model.providerName?.trim() || providerId,
      modelName: model.name?.trim() || modelId,
      logoProviderId: providerId,
      accessKind: "desktop_runtime",
    })))
}

export { findAutomationModelOption }

export function automationProviderCatalog(
  providers: readonly ProviderListItem[] | undefined,
): AutomationProviderCatalog {
  const catalog: AutomationProviderCatalog = {}
  for (const provider of providers ?? []) {
    catalog[provider.id] = Object.fromEntries(Object.entries(provider.models ?? {})
      .map(([modelId, model]) => [modelId, { ...model, providerName: provider.name }]))
  }
  return catalog
}

export function resolveProposalModel(
  proposed: AutomationModel | undefined,
  providers: readonly DenOrgLlmProvider[],
  availability: AutomationModelAvailability = {},
): ResolvedProposalModel {
  const freeModel: AutomationModel = {
    providerId: AUTOMATION_FREE_MODEL.providerId,
    modelId: AUTOMATION_FREE_MODEL.modelId,
    variant: null,
  }
  const options = automationModelOptions(providers, availability)
  if (!proposed) {
    if (findAutomationModelOption(options, freeModel)) return { model: freeModel, resolution: "default" }
    const first = options[0]
    return first
      ? { model: { providerId: first.providerId, modelId: first.modelId, variant: null }, resolution: "default" }
      : { model: freeModel, resolution: "unavailable" }
  }

  if (findAutomationModelOption(options, proposed)) {
    return { model: proposed, resolution: "exact" }
  }

  const matches = providers.filter((candidate) =>
    candidate.source !== "openwork"
    && candidate.providerId === proposed.providerId
    && candidate.models.some((model) => model.id === proposed.modelId))
  const provider = matches.length === 1 ? matches[0] : undefined
  if (provider && findAutomationModelOption(options, { providerId: provider.id, modelId: proposed.modelId })) {
    return {
      model: {
        providerId: provider.id,
        modelId: proposed.modelId,
        variant: proposed.variant ?? null,
      },
      resolution: "mapped",
    }
  }

  return { model: proposed, resolution: "unavailable" }
}

export function describeAutomationModel(
  model: AutomationModel,
  options: readonly AutomationModelOption[],
) {
  const option = findAutomationModelOption(options, model)
  const name = option ? `${option.providerName} · ${option.modelName}` : `${model.providerId}/${model.modelId}`
  return model.variant ? `${name} · ${model.variant}` : name
}

export function automationPickerOptions(input: {
  options: readonly AutomationModelOption[]
  catalog: AutomationProviderCatalog
  selected: AutomationModel
}): ModelOption[] {
  return input.options.map((option) => {
    const isSelected = option.providerId === input.selected.providerId
      && option.modelId === input.selected.modelId
    const model = input.catalog[option.providerId]?.[option.modelId]
    const summary = getModelBehaviorSummary(
      option.providerId,
      model,
      isSelected ? input.selected.variant ?? null : null,
      option.providerName,
    )
    return {
      providerID: option.providerId,
      modelID: option.modelId,
      title: option.modelName,
      description: option.providerName,
      behaviorTitle: summary.title,
      behaviorLabel: summary.label,
      behaviorDescription: summary.description,
      behaviorValue: summary.value,
      behaviorOptions: summary.options,
      isFree: option.accessKind === "free",
    }
  })
}
