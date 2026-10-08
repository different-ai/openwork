import type { DenOrgLlmProvider } from "@/app/lib/den"
import { getModelBehaviorSummary } from "@/app/lib/model-behavior"
import type { ModelOption, ProviderListItem } from "@/app/types"
import type { AutomationModel } from "@openwork/types/automations"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import {
  automationModelOptions as sharedAutomationModelOptions,
  findAutomationModelOption,
  type AutomationModelOption,
} from "@openwork/types/automation-models"

/** providerId → modelId → the local runtime's model record. */
export type AutomationProviderCatalog = Record<string, Record<string, ProviderListItem["models"][string]>>

export type { AutomationModelOption }

export type ResolvedProposalModel = {
  model: AutomationModel
  resolution: "exact" | "mapped" | "default" | "unavailable"
}

export type AutomationModelAvailability = {
  includeFreeStarter?: boolean
  includeCloudDefault?: boolean
  /** The executing desktop workspace's runtime catalog; when given, only models it can run are offered. */
  catalog?: AutomationProviderCatalog
}

/**
 * Den's usable-provider response is already scoped to the active member; the shared helper keeps the submitted
 * value normalized to the IDs the server revalidates.
 */
export function automationModelOptions(
  providers: readonly DenOrgLlmProvider[],
  options: AutomationModelAvailability = {},
): AutomationModelOption[] {
  const { catalog, ...shared } = options
  return sharedAutomationModelOptions(providers, shared)
    .filter((model) => catalog === undefined || Boolean(catalog[model.providerId]?.[model.modelId]))
}

export { findAutomationModelOption }

/** A runtime's connected providers as an Automation catalog: providerId → modelId → model record. */
export function automationProviderCatalog(
  providers: readonly ProviderListItem[] | undefined,
): AutomationProviderCatalog {
  const catalog: AutomationProviderCatalog = {}
  for (const provider of providers ?? []) catalog[provider.id] = { ...(provider.models ?? {}) }
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
  if (!proposed) return {
    model: freeModel,
    resolution: findAutomationModelOption(options, freeModel) ? "default" : "unavailable",
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
 * the run, so they come from the local provider catalog.
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
