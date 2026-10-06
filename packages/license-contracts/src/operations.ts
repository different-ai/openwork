import type { ModuleState } from "./resolver"

export type OperationActor = { readonly ownerOrSuperAdmin: boolean }

/**
 * Whether one operation of a module may run. `on` allows, `off` denies, and
 * `restricted` applies the module's transition policy for the operation
 * (a missing key means `other`; a missing `other` means deny).
 */
export function evaluateModuleOperation(
  state: ModuleState,
  operation: string | undefined,
  actor: OperationActor,
): "allow" | "deny" {
  if (state.state === "on") return "allow"
  if (state.state === "off") return "deny"
  const policy = state.operations[operation ?? "other"] ?? state.operations.other ?? "deny"
  if (policy === "allow") return "allow"
  if (policy === "owner_only") return actor.ownerOrSuperAdmin ? "allow" : "deny"
  return "deny"
}
