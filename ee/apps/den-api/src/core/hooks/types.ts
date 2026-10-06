import type { createDenDb } from "@openwork-ee/den-db"

// Switch to W0-01's `ModuleId` once the module contracts merge.
export type CoreHookModuleId = string

type DenDb = ReturnType<typeof createDenDb>["db"]
export type CoreTx = Parameters<Parameters<DenDb["transaction"]>[0]>[0]

export type CoreHookPhase =
  | "guard"
  | "tx"
  | "participant"
  | "postCommit"
  | "contributor"
  | "resolver"
  | "decorator"
  | "middleware"

export const CORE_HOOK_ORDER = {
  lock: 100,
  guard: 200,
  security: 300,
  cleanup: 400,
  default: 500,
  sync: 800,
} as const

export type CoreHookRegistrant = "legacy" | "core" | CoreHookModuleId

export type CoreHookErrorPolicy = "propagate" | "isolate"

export type CoreHookAlwaysRun = "cleanup" | "consistency"

export interface CoreHookRejection {
  code: string
  status: number
  message: string
  details?: Readonly<Record<string, unknown>>
}

// Every point input is an object. Org-scoped points carry `organizationId`;
// points dispatched inside a transaction carry `tx` so the module-state source
// can read `organization.modules` under the caller's lock.
export interface CoreHookInputBase {
  organizationId?: string | null
  tx?: CoreTx
}

export interface CoreHookRegistrationBase<P extends string> {
  point: P
  // "<registrant>/<owner>/<name>", globally unique across every phase.
  id: string
  registrant: CoreHookRegistrant
  // Owning module. Undefined means Core-owned (or legacy): always runs.
  moduleId?: CoreHookModuleId
  // Lower runs first. Ties break by id.
  order?: number
  // Runs whatever the module state; post-commit security hooks retry and never fail the request.
  security?: boolean
  alwaysRun?: CoreHookAlwaysRun
}

export type AfterCommit = (callback: () => Promise<void>) => void
