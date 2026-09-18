import { AUTOMATION_FREE_MODEL, type AutomationExecutionTarget } from "@openwork/types/automations"
import type { AutomationAuthorityFailure } from "./authority.js"

type ModelSelection = { providerId: string; modelId: string }
type ModelAccessFailure = Pick<AutomationAuthorityFailure, "code" | "reason">

/**
 * Published desktop clients accepted the legacy free model and did not apply
 * provider model filters. Model-attention v1 covers the Zen rollout, not the
 * newer provider filtering behavior. Den enforces filters for Cloud; Desktop
 * enforces them through its workspace runtime preflight without changing the
 * published Den admission contract.
 * Membership, provider grants, and removed models remain fail-closed for every
 * client generation; authority checks them before classifying a filter failure.
 */
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
