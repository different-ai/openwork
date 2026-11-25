import type { ProviderProfileId } from "./contracts/profile.js"
import { createDefaultScenario, createFaultScenario, type EnterpriseMcpScenario } from "./contracts/scenario.js"
import { getFaultDefinition, listFaultDefinitions } from "./faults/catalog.js"

export function createCliScenario(
  profileId: ProviderProfileId,
  activeFaultId: string | undefined,
): EnterpriseMcpScenario {
  if (activeFaultId === undefined) return createDefaultScenario(profileId)

  const fault = getFaultDefinition(activeFaultId)
  if (!fault || !fault.applicableProfiles.includes(profileId)) {
    const validIds = listFaultDefinitions(profileId).map((definition) => definition.id).join(", ")
    throw new Error(`Invalid ACTIVE_FAULT_ID '${activeFaultId}' for profile '${profileId}'. Valid ids: ${validIds}`)
  }

  return createFaultScenario(profileId, fault.id)
}
