import { AUTOMATION_FREE_MODEL, type AutomationExecutionTarget } from "@openwork/types/automations"
import type { AutomationAuthorityFailure } from "./authority.js"

type ModelSelection = { providerId: string; modelId: string }
type ModelAccessFailure = Pick<AutomationAuthorityFailure, "code" | "reason">

export function shouldApplyAutomationModelAccessFailure(input: {
  model: ModelSelection
  failure: ModelAccessFailure
  modelAttentionCapable: boolean
  executionTarget?: AutomationExecutionTarget
}): boolean {
  if (input.failure.code === "model_access_lost" && input.failure.reason === "provider_model_disabled") {
    return input.executionTarget === "cloud"
  }
  if (input.modelAttentionCapable) return true
  return input.failure.code !== "model_access_lost"
    || input.model.providerId !== AUTOMATION_FREE_MODEL.providerId
    || input.model.modelId !== AUTOMATION_FREE_MODEL.modelId
}
