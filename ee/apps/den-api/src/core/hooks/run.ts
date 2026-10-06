import type { CoreHookModuleStateSource } from "./module-state.js"
import type { CoreHookInputBase, CoreHookRegistrationBase } from "./types.js"

export type CoreHookScope =
  | { kind: "org"; organizationId: string; tx?: CoreHookInputBase["tx"] }
  | { kind: "instance" }

// Instance-scoped points (Better Auth middleware, boot config, resolvers)
// carry no organization fields at all.
function isOrgScopedInput(input: object): input is CoreHookInputBase {
  return "organizationId" in input
}

export function coreHookScope(input: object): CoreHookScope {
  if (!isOrgScopedInput(input)) return { kind: "instance" }
  return typeof input.organizationId === "string" && input.organizationId.length > 0
    ? { kind: "org", organizationId: input.organizationId, tx: input.tx }
    : { kind: "instance" }
}

// The skip rule. Core-owned (and legacy) hooks, security hooks and always-run
// hooks run whatever the module state; everything else runs only while its
// module is effective for the org (org-scoped points) or available on the
// instance (org-less points).
export async function shouldRunCoreHook(
  registration: Pick<CoreHookRegistrationBase<string>, "moduleId" | "security" | "alwaysRun">,
  scope: CoreHookScope,
  source: CoreHookModuleStateSource,
): Promise<boolean> {
  const moduleId = registration.moduleId
  if (moduleId === undefined || registration.security === true || registration.alwaysRun !== undefined) {
    return true
  }
  if (scope.kind === "org") {
    return source.isEffective({ organizationId: scope.organizationId, moduleId, tx: scope.tx })
  }
  return source.isAvailable(moduleId)
}

export function compareCoreHookRegistrations(
  left: Pick<CoreHookRegistrationBase<string>, "id" | "order">,
  right: Pick<CoreHookRegistrationBase<string>, "id" | "order">,
  defaultOrder: number,
) {
  const byOrder = (left.order ?? defaultOrder) - (right.order ?? defaultOrder)
  if (byOrder !== 0) return byOrder
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
