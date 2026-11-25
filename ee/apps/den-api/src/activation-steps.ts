import { ACTIVATION_STEP_IDS, answeredInDetail, type ActivationState, type ActivationStep } from "@openwork/types/den/activation"

export type ActivationFacts = {
  firstResponse: { done: boolean; durationMs: number | null }
  invite: {
    canInvite: boolean
    invitedByMe: number
    teammates: number
    joined: number
    pending: number
  }
  skillUsed: boolean
  ownProvider: {
    reportedOnDevice: boolean
    addedProviderName: string | null
    orgProvided: boolean
    canConfigure: boolean
  }
  gateway: { canManage: boolean; hasProvider: boolean; providerName: string | null }
  readyConnectionName: string | null
  connectionOnDevice: boolean
  localSetup: boolean
  ownerName: string | null
  dismissed: boolean
}

function owner(facts: Pick<ActivationFacts, "ownerName">) {
  return facts.ownerName?.trim() || "Your workspace owner"
}

export function computeActivationState(facts: ActivationFacts): ActivationState {
  const step = (id: ActivationStep["id"]): ActivationStep => {
    switch (id) {
      case "first_response":
        return {
          id,
          done: facts.firstResponse.done,
          ...(facts.firstResponse.done && facts.firstResponse.durationMs !== null ? { detail: answeredInDetail(facts.firstResponse.durationMs) } : {}),
        }
      case "invite_teammate": {
        const { canInvite, invitedByMe, teammates, joined, pending } = facts.invite
        const done = canInvite ? invitedByMe > 0 : teammates > 0
        const optional = facts.localSetup && !done && teammates === 0
        return {
          id,
          done,
          ...(done ? { detail: `${joined} joined, ${pending} invited` } : {}),
          ...(!done && !canInvite ? { lockedReason: `${owner(facts)} can invite people` } : {}),
          ...(optional ? { optional: true } : {}),
        }
      }
      case "use_skill":
        return { id, done: facts.skillUsed }
      case "own_provider": {
        const { reportedOnDevice, addedProviderName, orgProvided, canConfigure } = facts.ownProvider
        const done = reportedOnDevice || addedProviderName !== null || orgProvided || !canConfigure
        const detail = reportedOnDevice
          ? "Your key, on this device"
          : addedProviderName !== null
            ? `${addedProviderName} added`
            : orgProvided
              ? "Models from your organization"
              : !canConfigure
                ? "Your team manages models"
                : null
        return { id, done, ...(detail ? { detail } : {}) }
      }
      case "gateway_provider": {
        const done = facts.gateway.hasProvider
        return {
          id,
          done,
          ...(done && facts.gateway.providerName ? { detail: `${facts.gateway.providerName} on AI Gateway` } : {}),
          ...(!done && !facts.gateway.canManage ? { lockedReason: `${owner(facts)} manages AI Gateway` } : {}),
        }
      }
      case "connector": {
        const onDevice = facts.localSetup && facts.connectionOnDevice
        const detail = facts.readyConnectionName ? `${facts.readyConnectionName} connected` : onDevice ? "Connected on this device" : null
        return { id, done: facts.readyConnectionName !== null || onDevice, ...(detail ? { detail } : {}) }
      }
    }
  }
  return { steps: ACTIVATION_STEP_IDS.map(step), dismissed: facts.dismissed }
}
