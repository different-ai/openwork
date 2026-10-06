import { mapModuleIds } from "@openwork/license-contracts"
import { MODULE_IDS, type Deployment, type ModuleId } from "@openwork/license-contracts/modules"
import type { AvailabilityMap, AvailabilityValue } from "@openwork/license-contracts/resolver"
import type { InstanceConfig } from "./config"

export type AvailabilityProbe = (config: InstanceConfig, deployment: Deployment) => AvailabilityValue

type InfraKey = keyof InstanceConfig["infra"]

/** Thrown by a probe whose infrastructure input this process doesn't know. */
export class UnknownInfrastructureError extends Error {
  readonly infra: InfraKey
  constructor(infra: InfraKey) {
    super(`Instance infrastructure "${infra}" is not known in this process.`)
    this.name = "UnknownInfrastructureError"
    this.infra = infra
  }
}

function infra(config: InstanceConfig, key: InfraKey): boolean {
  const value = config.infra[key]
  if (value === undefined) throw new UnknownInfrastructureError(key)
  return value
}

function when(condition: boolean, reason: string): AvailabilityValue {
  return condition ? true : { reason }
}

const available: AvailabilityProbe = () => true

/**
 * Legacy-period availability (00-legacy-mapping §E.4 column A). D19: a
 * deprecated flag set to `false` still means "unavailable". Module plans
 * tighten these in their manifests (G9); manifests reuse this table instead
 * of re-implementing it.
 */
const LEGACY_PROBES: Partial<Record<ModuleId, AvailabilityProbe>> = {
  aiGateway: (config) => when(infra(config, "gatewayEnabled"), "gateway_disabled"),
  automations: (config) => when(config.deprecatedFlags.automationsRuntimeEnabled, "automations_runtime_disabled"),
  "automations.headless": (config) => when(infra(config, "headlessRunnerConfigured"), "headless_runner_not_configured"),
  "automations.remoteSessions": (config) => when(
    config.deprecatedFlags.automationsRuntimeEnabled || (config.orgMode === "multi_org" && infra(config, "cloudRuntimeAvailable")),
    "remote_sessions_unavailable",
  ),
  mcpApps: (config) => when(config.deprecatedFlags.appMcpServersEnabled, "app_mcp_servers_disabled"),
  workbot: (config) => when(infra(config, "workbotConfigured"), "workbot_not_configured"),
  "slackAssistant.headless": (config) => when(infra(config, "headlessRunnerConfigured"), "headless_runner_not_configured"),
  freeInference: (config) => when(infra(config, "freeInferenceConfigured"), "free_inference_disabled"),
}

export const AVAILABILITY_PROBES: Readonly<Record<ModuleId, AvailabilityProbe>> = Object.freeze(
  mapModuleIds((id) => LEGACY_PROBES[id] ?? available),
)

export interface AvailabilitySnapshot {
  /** Bumps on recompute (config reload); part of the memo key. */
  readonly version: number
  readonly computedAt: string
  /** Every ModuleId present. */
  readonly map: AvailabilityMap
}

let snapshotVersion = 0

/**
 * Instance availability, computed once at boot. Modules outside
 * `observable` are reported available: the process trusts den-api for them
 * and never gates on them. A probe of an observable module whose
 * infrastructure input is unknown throws (misconfigured image).
 */
export function computeInstanceAvailability(input: {
  config: InstanceConfig
  deployment: Deployment
  observable?: "all" | readonly ModuleId[]
  probes?: Partial<Record<ModuleId, AvailabilityProbe>>
  now?: Date
}): AvailabilitySnapshot {
  const observable = input.observable ?? "all"
  const isObservable = (id: ModuleId) => observable === "all" || observable.includes(id)
  const map: Record<ModuleId, AvailabilityValue> = mapModuleIds((id) => {
    if (!isObservable(id)) return true
    const probe = input.probes?.[id] ?? AVAILABILITY_PROBES[id]
    const value = probe(input.config, input.deployment)
    return value === true ? true : Object.freeze({ reason: value.reason })
  })
  snapshotVersion += 1
  return Object.freeze({
    version: snapshotVersion,
    computedAt: (input.now ?? new Date()).toISOString(),
    map: Object.freeze(map),
  })
}

export function unavailableModules(snapshot: AvailabilitySnapshot): ModuleId[] {
  return MODULE_IDS.filter((id) => snapshot.map[id] !== true)
}
