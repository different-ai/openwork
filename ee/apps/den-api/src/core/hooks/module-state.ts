import type { CoreHookModuleId, CoreTx } from "./types.js"

// W0-03 installs the real source at boot. Until then every module is on and
// available, which is today's behavior.
export interface CoreHookModuleStateSource {
  isEffective(input: { organizationId: string; moduleId: CoreHookModuleId; tx?: CoreTx }): Promise<boolean>
  // Instance-level, for points without an organization.
  isAvailable(moduleId: CoreHookModuleId): boolean
}

export const alwaysOnModuleStateSource: CoreHookModuleStateSource = {
  isEffective: async () => true,
  isAvailable: () => true,
}
