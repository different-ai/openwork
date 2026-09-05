import type { DenOrgLlmProvider } from "@/app/lib/den"
import { getModelBehaviorSummary } from "@/app/lib/model-behavior"
import type { ModelOption, ProviderListItem } from "@/app/types"
import type { AutomationModel } from "@openwork/types/automations"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import { openWorkModelConfigurations } from "@openwork/types/den/inference"

/** providerId → modelId → the local runtime's model record. */
export type AutomationProviderCatalog = Record<string, Record<string, ProviderListItem["models"][string]>>

export type AutomationModelOption = {
  providerId: string
  modelId: string
  providerName: string
  modelName: string
  accessKind: "free" | "openwork_managed" | "authorized_custom"
}

export type ResolvedProposalModel = {
  model: AutomationModel
  resolution: "exact" | "mapped" | "default" | "fallback"
}

const freeStarterModel: AutomationModelOption = {
  ...AUTOMATION_FREE_MODEL,
  accessKind: "free",
}

function openWorkManagedModels(provider: DenOrgLlmProvider): AutomationModelOption[] {
  return Object.entries(openWorkModelConfigurations())
    .map(([modelId, model]) => ({
      providerId: "openwork",
      modelId,
      providerName: provider.name,
      modelName: model.name,
      accessKind: "openwork_managed" as const,
    }))
}

function authorizedProviderModels(provider: DenOrgLlmProvider): AutomationModelOption[] {
  return provider.models.map((model) => ({
    providerId: provider.id,
    modelId: model.id,
    providerName: provider.name,
    modelName: model.name,
    accessKind: "authorized_custom" as const,
  }))
}

/**
 * Den's usable-provider response is already scoped to the active member. Keep
 * the submitted value normalized to the same IDs the server revalidates:
 * `opencode`, `openwork`, or the concrete `lpr_*` provider record.
 */
export function automationModelOptions(
  providers: readonly DenOrgLlmProvider[],
  options: { includeFreeStarter?: boolean } = {},
): AutomationModelOption[] {
  const managed = providers.flatMap((provider) => provider.source === "openwork"
    ? openWorkManagedModels(provider)
    : authorizedProviderModels(provider))

  return [
    ...(options.includeFreeStarter === false ? [] : [freeStarterModel]),
    ...managed,
  ].sort((left, right) => {
    const kindOrder = ["free", "openwork_managed", "authorized_custom"]
    return kindOrder.indexOf(left.accessKind) - kindOrder.indexOf(right.accessKind)
      || left.providerName.localeCompare(right.providerName)
      || left.modelName.localeCompare(right.modelName)
  })
}

export function automationProviderCatalog(
  providers: readonly ProviderListItem[] | undefined,
): AutomationProviderCatalog {
  const catalog: AutomationProviderCatalog = {}
  for (const provider of providers ?? []) catalog[provider.id] = { ...(provider.models ?? {}) }
  return catalog
}

export function findAutomationModelOption(
  options: readonly AutomationModelOption[],
  model: Pick<AutomationModel, "providerId" | "modelId">,
) {
  return options.find((option) =>
    option.providerId === model.providerId && option.modelId === model.modelId) ?? null
}

export function resolveProposalModel(
  proposed: AutomationModel | undefined,
  providers: readonly DenOrgLlmProvider[],
): ResolvedProposalModel {
  const freeModel: AutomationModel = {
    providerId: AUTOMATION_FREE_MODEL.providerId,
    modelId: AUTOMATION_FREE_MODEL.modelId,
    variant: null,
  }
  if (!proposed) return { model: freeModel, resolution: "default" }

  if (findAutomationModelOption(automationModelOptions(providers), proposed)) {
    return { model: proposed, resolution: "exact" }
  }

  const provider = providers.find((candidate) =>
    candidate.source !== "openwork"
    && candidate.providerId === proposed.providerId
    && candidate.models.some((model) => model.id === proposed.modelId))
  if (provider) {
    return {
      model: {
        providerId: provider.id,
        modelId: proposed.modelId,
        variant: proposed.variant ?? null,
      },
      resolution: "mapped",
    }
  }

  return { model: freeModel, resolution: "fallback" }
}

/**
 * Human label for a stored Automation model. Falls back to the raw identity
 * only when the model is no longer among the ones this member can use, so a
 * revoked model stays inspectable instead of rendering as a blank.
 */
export function describeAutomationModel(
  model: AutomationModel,
  options: readonly AutomationModelOption[],
) {
  const option = findAutomationModelOption(options, model)
  const name = option ? `${option.providerName} · ${option.modelName}` : `${model.providerId}/${model.modelId}`
  return model.variant ? `${name} · ${model.variant}` : name
}

/**
 * Presents the member's authorized Automation models in the shape the shared
 * model picker renders, so an Automation is configured with the same control
 * and the same reasoning levels as a chat.
 *
 * Reasoning variants are a property of the desktop runtime that will execute
 * the run, so they come from the local provider catalog. A model Den authorizes
 * but the local runtime does not know still lists — without variants.
 */
export function automationPickerOptions(input: {
  options: readonly AutomationModelOption[]
  catalog: AutomationProviderCatalog
  selected: AutomationModel
}): ModelOption[] {
  return input.options.map((option) => {
    const isSelected = option.providerId === input.selected.providerId
      && option.modelId === input.selected.modelId
    const model = input.catalog[option.providerId]?.[option.modelId]
    const summary = model
      ? getModelBehaviorSummary(
        option.providerId,
        model,
        isSelected ? input.selected.variant ?? null : null,
        option.providerName,
      )
      : null
    return {
      providerID: option.providerId,
      modelID: option.modelId,
      title: option.modelName,
      description: option.providerName,
      behaviorTitle: summary?.title ?? "Reasoning",
      behaviorLabel: summary?.label ?? "Default",
      behaviorDescription: summary?.description ?? "",
      behaviorValue: summary?.value ?? null,
      behaviorOptions: summary?.options ?? [],
      isFree: option.accessKind === "free",
    }
  })
}
