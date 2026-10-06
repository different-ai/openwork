import {
  LICENSE_TRANSITION_MS,
  LICENSE_VERIFICATION_GRACE_MS,
  type LicenseEntitlement,
  type LicenseKind,
  type LicenseStatus,
} from "./license"
import { mapModuleIds, type ModuleId } from "./module-ids"
import {
  CLOUD_FREE_PLAN_MODULES,
  computeModuleTopoOrder,
  hardEdges,
  MODULE_DEFINITIONS,
  MODULE_TOPO_ORDER,
  type Deployment,
  type ModuleDefinition,
  type TransitionOperationPolicy,
} from "./modules"

export const MODULE_OFF_REASONS = [
  "not_on_deployment",
  "not_available",
  "not_entitled",
  "license_expired",
  "disabled_by_org",
  "requires",
] as const

export type ModuleOffReason = (typeof MODULE_OFF_REASONS)[number]

export type ModuleOffState =
  | { readonly state: "off"; readonly reason: "requires"; readonly requires: ModuleId }
  | { readonly state: "off"; readonly reason: "not_available"; readonly detail: string }
  | { readonly state: "off"; readonly reason: Exclude<ModuleOffReason, "requires" | "not_available"> }

export type ModuleRestrictedState = {
  readonly state: "restricted"
  readonly until: string
  readonly operations: Readonly<Record<string, TransitionOperationPolicy>>
}

export type ModuleState = { readonly state: "on" } | ModuleRestrictedState | ModuleOffState

/** `true` = infrastructure configured. A missing key is `not_available` with detail `unknown`. */
export type AvailabilityValue = true | { readonly reason: string }
export type AvailabilityMap = Readonly<Partial<Record<ModuleId, AvailabilityValue>>>

export type LicenseEntitlementInput = {
  readonly source: "license"
  readonly license: LicenseEntitlement
  /** Last successful verification. Never advanced by failures or restarts. */
  readonly lastVerifiedAt: string
  /** First observed transition start, persisted so restarts can't extend grace. */
  readonly transitionStartedAt: string | null
  /** A 401/403 from the license server: a rejected credential, never an outage. */
  readonly credentialRejectedAt: string | null
}

export type EntitlementInput =
  /** Self-hosted without a license key: Core only (D14). */
  | { readonly source: "none" }
  /** Cloud org without a license snapshot yet (§7.4): `CLOUD_FREE_PLAN_MODULES`. */
  | { readonly source: "cloudFreeFallback" }
  /** Legacy adapter, dev override or license UI previews. Missing keys fall back to `free`. */
  | {
      readonly source: "static"
      readonly modules: Readonly<Partial<Record<ModuleId, boolean>>>
      readonly featureFlags?: Readonly<Record<string, boolean>>
    }
  | LicenseEntitlementInput

export interface ResolverInputs {
  readonly deployment: Deployment
  readonly availability: AvailabilityMap
  readonly entitlement: EntitlementInput
  /** `organization.modules.disabled`; unknown ids are ignored. */
  readonly disabled: readonly string[]
  readonly now: Date
}

export interface EffectiveModulesLicense {
  readonly status: LicenseStatus
  readonly kind: LicenseKind
  readonly isTrial: boolean
  readonly expiresAt: string | null
  readonly transition: null | { readonly startedAt: string; readonly endsAt: string }
}

export interface EffectiveModules {
  readonly version: 1
  /** `inputs.now` as ISO. */
  readonly computedAt: string
  /** Earliest future time boundary that can change the result; caps memo TTLs (§7.3). */
  readonly validUntil: string | null
  readonly deployment: Deployment
  readonly entitlementSource: EntitlementInput["source"]
  readonly license: EffectiveModulesLicense | null
  readonly modules: Readonly<Record<ModuleId, ModuleState>>
  readonly featureFlags: Readonly<Record<string, boolean>>
}

type TransitionPhase = { phase: "active" } | { phase: "restricted"; until: string } | { phase: "ended" }

interface LicenseTransition {
  readonly startedAtMs: number | null
  readonly isTrial: boolean
  readonly validUntilMs: number | null
}

function toMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function earlier(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/** Every instant that starts (or will start) the license transition. */
function transitionCandidates(input: LicenseEntitlementInput): number[] {
  const { license } = input
  const checkedAt = toMs(license.checkedAt)
  const candidates: Array<number | null> = [
    toMs(input.credentialRejectedAt),
    toMs(input.transitionStartedAt),
  ]
  const lastVerifiedAt = toMs(input.lastVerifiedAt)
  if (lastVerifiedAt !== null) candidates.push(lastVerifiedAt + LICENSE_VERIFICATION_GRACE_MS)
  switch (license.status) {
    case "active":
      candidates.push(toMs(license.expiresAt))
      break
    case "expired":
      candidates.push(earlier(toMs(license.expiresAt), checkedAt))
      break
    case "suspended":
    case "revoked":
      candidates.push(earlier(toMs(license.invalidatedAt), checkedAt))
      break
  }
  return candidates.filter((candidate): candidate is number => candidate !== null)
}

function startOf(candidates: readonly number[], nowMs: number): number | null {
  let start: number | null = null
  for (const candidate of candidates) {
    if (candidate <= nowMs) start = earlier(start, candidate)
  }
  return start
}

/**
 * The transition start (T0) these inputs imply at `now`, or `null` when the
 * license is healthy. Callers persist the first observed value as
 * `transitionStartedAt`.
 */
export function computeTransitionStart(input: LicenseEntitlementInput, now: Date): string | null {
  const start = startOf(transitionCandidates(input), now.getTime())
  return start === null ? null : new Date(start).toISOString()
}

function licenseTransition(input: LicenseEntitlementInput, nowMs: number): LicenseTransition {
  const candidates = transitionCandidates(input)
  const startedAtMs = startOf(candidates, nowMs)
  const isTrial = input.license.isTrial
  let validUntilMs: number | null = null
  for (const candidate of candidates) {
    if (candidate > nowMs) validUntilMs = earlier(validUntilMs, candidate)
  }
  if (startedAtMs !== null && !isTrial && startedAtMs + LICENSE_TRANSITION_MS > nowMs) {
    validUntilMs = earlier(validUntilMs, startedAtMs + LICENSE_TRANSITION_MS)
  }
  return { startedAtMs, isTrial, validUntilMs }
}

function transitionPhase(definition: ModuleDefinition, transition: LicenseTransition | null, nowMs: number): TransitionPhase {
  if (definition.entitlement !== "licensed" || transition === null || transition.startedAtMs === null) return { phase: "active" }
  if (transition.isTrial) return { phase: "ended" }
  const endsAtMs = transition.startedAtMs + LICENSE_TRANSITION_MS
  switch (definition.expiryPolicy) {
    case "immediate":
      return { phase: "ended" }
    case "continue":
      return nowMs < endsAtMs ? { phase: "active" } : { phase: "ended" }
    case "restricted":
      return nowMs < endsAtMs ? { phase: "restricted", until: new Date(endsAtMs).toISOString() } : { phase: "ended" }
    case "n/a":
      return { phase: "active" }
  }
}

function isEntitled(id: ModuleId, definition: ModuleDefinition, entitlement: EntitlementInput): boolean {
  const free = definition.entitlement === "free"
  switch (entitlement.source) {
    case "none":
      return false
    case "cloudFreeFallback":
      return free || CLOUD_FREE_PLAN_MODULES[id]
    case "static":
      return entitlement.modules[id] ?? free
    case "license":
      return free || entitlement.license.modules[id] === true
  }
}

function availabilityDetail(value: AvailabilityValue | undefined): string | null {
  if (value === true) return null
  return value?.reason ?? "unknown"
}

/**
 * Pure module resolution (discovery §6.3). Never reads the clock: the same
 * inputs always give the same output.
 */
export function resolveModules(
  inputs: ResolverInputs,
  definitions: Readonly<Record<ModuleId, ModuleDefinition>> = MODULE_DEFINITIONS,
): EffectiveModules {
  const nowMs = inputs.now.getTime()
  const { entitlement } = inputs
  const transition = entitlement.source === "license" ? licenseTransition(entitlement, nowMs) : null
  const disabled = new Set(inputs.disabled)
  const order = definitions === MODULE_DEFINITIONS ? MODULE_TOPO_ORDER : computeModuleTopoOrder(definitions)
  const states = new Map<ModuleId, ModuleState>()

  for (const id of order) {
    const definition = definitions[id]
    states.set(id, resolveOne(id, definition))
  }

  function resolveOne(id: ModuleId, definition: ModuleDefinition): ModuleState {
    if (!definition.deployments.includes(inputs.deployment)) return { state: "off", reason: "not_on_deployment" }
    const unavailable = availabilityDetail(inputs.availability[id])
    if (unavailable !== null) return { state: "off", reason: "not_available", detail: unavailable }
    if (!isEntitled(id, definition, entitlement)) return { state: "off", reason: "not_entitled" }
    const phase = transitionPhase(definition, transition, nowMs)
    if (phase.phase === "ended") return { state: "off", reason: "license_expired" }
    if (definition.orgToggle === "optOut" && disabled.has(id)) return { state: "off", reason: "disabled_by_org" }
    for (const dependency of hardEdges(definition)) {
      if (states.get(dependency)?.state === "off") return { state: "off", reason: "requires", requires: dependency }
    }
    if (phase.phase === "restricted") {
      return { state: "restricted", until: phase.until, operations: definition.transitionOperations ?? { other: "deny" } }
    }
    return { state: "on" }
  }

  const modules = mapModuleIds((id) => {
    const state = states.get(id)
    if (state === undefined) throw new Error(`Module ${id} was not resolved`)
    return state
  })

  let license: EffectiveModulesLicense | null = null
  let featureFlags: Readonly<Record<string, boolean>> = {}
  if (entitlement.source === "license") {
    const startedAtMs = transition?.startedAtMs ?? null
    const endsAtMs = startedAtMs === null ? null : entitlement.license.isTrial ? startedAtMs : startedAtMs + LICENSE_TRANSITION_MS
    license = {
      status: entitlement.license.status,
      kind: entitlement.license.kind,
      isTrial: entitlement.license.isTrial,
      expiresAt: entitlement.license.expiresAt,
      transition:
        startedAtMs === null || endsAtMs === null
          ? null
          : { startedAt: new Date(startedAtMs).toISOString(), endsAt: new Date(endsAtMs).toISOString() },
    }
    featureFlags = entitlement.license.featureFlags
  } else if (entitlement.source === "static") {
    featureFlags = entitlement.featureFlags ?? {}
  }

  const validUntilMs = transition?.validUntilMs ?? null
  return {
    version: 1,
    computedAt: inputs.now.toISOString(),
    validUntil: validUntilMs === null ? null : new Date(validUntilMs).toISOString(),
    deployment: inputs.deployment,
    entitlementSource: entitlement.source,
    license,
    modules,
    featureFlags,
  }
}

/** `state === "on"`. */
export function isModuleOn(effective: EffectiveModules, id: ModuleId): boolean {
  return effective.modules[id].state === "on"
}

/** `on` or `restricted`. */
export function isModuleUsable(effective: EffectiveModules, id: ModuleId): boolean {
  return effective.modules[id].state !== "off"
}

export { evaluateModuleOperation, type OperationActor } from "./operations"
