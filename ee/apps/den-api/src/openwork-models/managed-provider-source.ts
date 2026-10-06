import { organizationAllowsManagedModels, registerManagedLlmProviderSource, type ManagedLlmProviderSource } from "../inference-shared/public.js"
import { assertOrganizationManagedModelsAllowed } from "../organization-metadata.js"
import { repairMemberInferenceAccessIfNeeded } from "./member-keys.js"

/** Delivers the member's `ow_inf_` key to the desktop through its `source='openwork'` provider row. */
export const openWorkModelsManagedProviderSource: ManagedLlmProviderSource = {
  source: "openwork",
  async beforeUsableList(input) {
    await repairMemberInferenceAccessIfNeeded(input)
  },
  rowsAllowed: organizationAllowsManagedModels,
  assertConnectable: assertOrganizationManagedModelsAllowed,
}

export function registerOpenWorkModelsManagedProviderSource() {
  registerManagedLlmProviderSource(openWorkModelsManagedProviderSource)
}
