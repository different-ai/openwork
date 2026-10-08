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
  resolution: "exact" | "mapped" | "default" | "fallback"
}

/**
 * Den's usable-provider response is already scoped to the active member; the shared helper keeps the submitted
 * value normalized to the IDs the server revalidates.
 */
export function automationModelOptions(
  providers: readonly DenOrgLlmProvider[],
  options: { includeFreeStarter?: boolean; includeCloudDefault?: boolean } = {},
): AutomationModelOption[] {
  return sharedAutomationModelOptions(providers, options)
}

export { findAutomationModelOption }

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
