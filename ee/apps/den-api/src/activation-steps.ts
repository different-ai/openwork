import { ACTIVATION_STEP_IDS, answeredInDetail, type ActivationState, type ActivationStep } from "@openwork/types/den/activation"

/**
 * The Get set up checklist computed from its facts (see activation.ts for where each fact comes from). Pure, so the
 * rules are unit-tested without a database: a step checks off only when it actually worked, and a step the person
 * cannot do names who can (DESIGN P4).
 */

/** Everything the steps are computed from; gathered by `readActivationFacts` in activation.ts. */
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
    /** The organization provides models centrally (Den/managed models), so the member has a provider without setting one up themselves. */
    orgProvided: boolean
    /** The member may add their own model provider (desktop policy `allowCustomProviders` !== false). False when the org allows only its own providers, so the step is never an un-completable blocker. */
    canConfigure: boolean
  }
  gateway: { canManage: boolean; hasProvider: boolean; providerName: string | null }
  readyConnectionName: string | null
  ownerName: string | null
  dismissed: boolean
}

function owner(facts: Pick<ActivationFacts, "ownerName">) {
  return facts.ownerName?.trim() || "Your workspace owner"
}

/** The checklist from its facts: one step per recipe item, in recipe order. */
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
        return {
          id,
          done,
          ...(done ? { detail: `${joined} joined, ${pending} invited` } : {}),
          ...(!done && !canInvite ? { lockedReason: `${owner(facts)} can invite people` } : {}),
        }
      }
      case "use_skill":
        return { id, done: facts.skillUsed }
      case "own_provider": {
        const { reportedOnDevice, addedProviderName, orgProvided, canConfigure } = facts.ownProvider
        // The member has a model provider to use once they set one up, the organization provides
        // models centrally, or the organization has disabled setting up personal providers (so the
        // step is never an un-completable blocker for someone who cannot act on it).
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
      case "connector":
        return {
          id,
          done: facts.readyConnectionName !== null,
          ...(facts.readyConnectionName ? { detail: `${facts.readyConnectionName} connected` } : {}),
        }
    }
  }
  return { steps: ACTIVATION_STEP_IDS.map(step), dismissed: facts.dismissed }
}
