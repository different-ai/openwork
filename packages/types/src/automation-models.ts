import { AUTOMATION_CLOUD_DEFAULT_MODEL, AUTOMATION_FREE_MODEL } from "./automations"
import { INFERENCE_MODEL_ALIASES } from "./den/inference"

/**
 * The models an Automation can use, from Den's usable-provider list
 * (`GET /v1/llm-providers`). Shared by the desktop editor, its Calendar and
 * Workbot's Calendar so every surface offers the same models with the same IDs
 * the server revalidates: `opencode`, `openwork`, a concrete `lpr_*` record, or
 * the cloud default.
 */

export type AutomationModelOption = {
  providerId: string
  modelId: string
  providerName: string
  modelName: string
  /** The catalog provider family (e.g. "anthropic") for the logo; the record id is often opaque. */
  logoProviderId?: string
  accessKind: "free" | "openwork_managed" | "authorized_custom" | "cloud_default"
}

/** The fields of a Den usable provider this needs. */
export type AutomationModelProvider = {
  id: string
  source: string
  providerId?: string
  name: string
  models: ReadonlyArray<{ id: string; name: string }>
}

const freeStarterModel: AutomationModelOption = { ...AUTOMATION_FREE_MODEL, logoProviderId: "opencode", accessKind: "free" }

export const cloudDefaultModelOption: AutomationModelOption = { ...AUTOMATION_CLOUD_DEFAULT_MODEL, logoProviderId: "openwork", accessKind: "cloud_default" }

const KIND_ORDER: ReadonlyArray<AutomationModelOption["accessKind"]> = ["cloud_default", "free", "openwork_managed", "authorized_custom"]

export function automationModelOptions(
  providers: readonly AutomationModelProvider[],
  options: { includeFreeStarter?: boolean; includeCloudDefault?: boolean } = {},
): AutomationModelOption[] {
  const fromProviders = providers.flatMap((provider): AutomationModelOption[] => provider.source === "openwork"
    ? Object.entries(INFERENCE_MODEL_ALIASES)
        .filter(([, model]) => model.enabled)
        .map(([modelId, model]) => ({
          providerId: "openwork",
          modelId,
          providerName: provider.name,
          modelName: model.displayName.replace(/^OpenWork:\s*/, ""),
          logoProviderId: "openwork",
          accessKind: "openwork_managed",
        }))
    : provider.models.map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        providerName: provider.name,
        modelName: model.name,
        logoProviderId: provider.providerId,
        accessKind: "authorized_custom",
      })))
  return [
    ...(options.includeCloudDefault ? [cloudDefaultModelOption] : []),
    ...(options.includeFreeStarter === false ? [] : [freeStarterModel]),
    ...fromProviders,
  ].sort((left, right) => KIND_ORDER.indexOf(left.accessKind) - KIND_ORDER.indexOf(right.accessKind)
    || left.providerName.localeCompare(right.providerName)
    || left.modelName.localeCompare(right.modelName))
}

export function findAutomationModelOption(
  options: readonly AutomationModelOption[],
  model: { providerId: string; modelId: string },
): AutomationModelOption | null {
  return options.find((option) => option.providerId === model.providerId && option.modelId === model.modelId) ?? null
}
