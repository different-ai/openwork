import type { DenOrgLlmProvider } from "@/app/lib/den"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"

export type AutomationModelOption = {
  providerId: string
  modelId: string
  providerName: string
  modelName: string
  accessKind: "free" | "openwork_managed" | "authorized_custom"
}

const freeStarterModel: AutomationModelOption = {
  ...AUTOMATION_FREE_MODEL,
  accessKind: "free",
}

function openWorkManagedModels(provider: DenOrgLlmProvider): AutomationModelOption[] {
  return Object.entries(INFERENCE_MODEL_ALIASES)
    .filter(([, model]) => model.enabled)
    .map(([modelId, model]) => ({
      providerId: "openwork",
      modelId,
      providerName: provider.name,
      modelName: model.displayName.replace(/^OpenWork:\s*/, ""),
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
export function automationModelOptions(providers: readonly DenOrgLlmProvider[]): AutomationModelOption[] {
  const managed = providers.flatMap((provider) => provider.source === "openwork"
    ? openWorkManagedModels(provider)
    : authorizedProviderModels(provider))

  return [freeStarterModel, ...managed].sort((left, right) => {
    const kindOrder = ["free", "openwork_managed", "authorized_custom"]
    return kindOrder.indexOf(left.accessKind) - kindOrder.indexOf(right.accessKind)
      || left.providerName.localeCompare(right.providerName)
      || left.modelName.localeCompare(right.modelName)
  })
}
