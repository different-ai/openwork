import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import type { AutomationAuthorityFailure } from "./authority.js"

type ModelSelection = { providerId: string; modelId: string }
type ModelAccessFailure = Pick<AutomationAuthorityFailure, "code" | "reason">

/**
 * Published desktop clients accepted the legacy free model and did not apply
 * provider model filters. Apply these new admission failures only after the
 * caller or runner advertises model attention (Cloud is always capable).
 * Membership, provider grants, and removed models remain fail-closed for every
 * client generation; authority checks them before classifying a filter failure.
 */
export function shouldApplyAutomationModelAccessFailure(input: {
  model: ModelSelection
  failure: ModelAccessFailure
  modelAttentionCapable: boolean
}): boolean {
  if (input.modelAttentionCapable) return true
  if (input.failure.code === "model_access_lost" && input.failure.reason === "provider_model_disabled") return false
  return input.failure.code !== "model_access_lost"
    || input.model.providerId !== AUTOMATION_FREE_MODEL.providerId
    || input.model.modelId !== AUTOMATION_FREE_MODEL.modelId
}
