import type { Deployment, ModuleId } from "@openwork/license-contracts/modules"
import type { EffectiveModules, ModuleState } from "@openwork/license-contracts/resolver"
import type { InstanceConfig } from "./instance/config"
import type { PreparedOrg } from "./legacy/adapter"
import { legacyDisabledModules } from "./legacy/inputs"
import { legacyPlanAllows, matchKnownDivergence, type LegacyPlanOperation } from "./legacy/mapping"
import type { ModuleLogger } from "./logger"
import type { OrgModuleRow } from "./org-row"

/** What the resolver path says, for one org, as an oracle sees it. */
export interface ShadowView {
  state(id: ModuleId): ModuleState
  /** Legacy operation-level plan gate (§C), computed by the adapter. */
  planAllows(operation: LegacyPlanOperation): boolean
}

/** A legacy helper, unchanged, compared with the resolver path. */
export interface LegacyOracle {
  /** e.g. `org.capabilities.mcpConnections`. */
  readonly id: string
  /** The module this oracle is about (divergence classification, logs). */
  readonly moduleId: ModuleId
  /** Today's helper. */
  readonly legacy: (row: OrgModuleRow) => boolean
  /** The resolver-side answer to compare with. Default: `state(moduleId) !== off`. */
  readonly resolved?: (view: ShadowView) => boolean
}

/** Effective state is on (or restricted). */
export function usable(state: ModuleState): boolean {
  return state.state !== "off"
}

const NOT_GRANTED_REASONS: ReadonlySet<string> = new Set(["not_on_deployment", "not_available", "not_entitled", "license_expired"])

/**
 * Entitled and available, ignoring org opt-outs and dependencies: the level
 * of today's raw capability checks (00-legacy-mapping §H.1 "entitlement").
 */
export function granted(state: ModuleState): boolean {
  return state.state !== "off" || !NOT_GRANTED_REASONS.has(state.reason)
}

export interface ShadowOptions {
  readonly enabled: boolean
  readonly sampleRate: number
  readonly maxLogsPerMinute: number
  readonly perKeyIntervalMs: number
}

export interface ShadowInspection {
  readonly effective: EffectiveModules
  readonly prepared: PreparedOrg
  readonly deployment: Deployment
  readonly config: InstanceConfig
}

const LEGACY_KILL_SWITCHES: ReadonlyArray<"connect" | "installLinks"> = ["connect", "installLinks"]
const MAX_RATE_KEYS = 20_000
const MINUTE_MS = 60_000

/**
 * Sampled, rate-limited, fire-and-forget comparison of legacy helpers with
 * the resolver path. Logs ids and booleans only. Never throws and never
 * awaits on the request path.
 */
export class ShadowComparator {
  private readonly oracles: LegacyOracle[] = []
  private readonly lastLogged = new Map<string, number>()
  private windowStart = 0
  private windowCount = 0
  private dropped = 0
  private readonly failuresLogged = new Set<string>()

  constructor(
    private readonly options: ShadowOptions,
    private readonly inspect: (row: OrgModuleRow) => ShadowInspection,
    private readonly logger: ModuleLogger,
    private readonly clock: () => Date,
    private readonly random: () => number = Math.random,
    private readonly defer: (task: () => void) => void = queueMicrotask,
  ) {}

  register(oracles: readonly LegacyOracle[]): void {
    for (const oracle of oracles) {
      if (this.oracles.some((existing) => existing.id === oracle.id)) throw new Error(`Legacy oracle ${oracle.id} is registered twice`)
      this.oracles.push(oracle)
    }
  }

  get registeredOracleIds(): string[] {
    return this.oracles.map((oracle) => oracle.id)
  }

  compare(row: OrgModuleRow): void {
    if (!this.options.enabled) return
    try {
      if (this.options.sampleRate < 1 && this.random() >= this.options.sampleRate) return
      this.defer(() => this.run(row))
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /** Synchronous comparison (tests, offline scripts). Returns the mismatching oracle ids. */
  run(row: OrgModuleRow): string[] {
    const mismatches: string[] = []
    try {
      const inspection = this.inspect(row)
      const view: ShadowView = {
        state: (id) => inspection.effective.modules[id],
        planAllows: (operation) => legacyPlanAllows(operation, inspection.prepared.legacy, inspection.config),
      }
      for (const oracle of this.oracles) {
        if (this.compareOne(row, oracle, view, inspection)) mismatches.push(oracle.id)
      }
      this.checkMirror(row, inspection)
    } catch (error) {
      this.reportFailure(error)
    }
    return mismatches
  }

  private compareOne(row: OrgModuleRow, oracle: LegacyOracle, view: ShadowView, inspection: ShadowInspection): boolean {
    let legacy: boolean
    let resolved: boolean
    try {
      legacy = oracle.legacy(row)
      resolved = oracle.resolved ? oracle.resolved(view) : usable(view.state(oracle.moduleId))
    } catch (error) {
      this.reportFailure(error, oracle.id)
      return false
    }
    if (legacy === resolved) return false
    const state = view.state(oracle.moduleId)
    const divergence = matchKnownDivergence(oracle.moduleId, {
      inputs: inspection.prepared.legacy,
      config: inspection.config,
      deployment: inspection.deployment,
      disabled: inspection.prepared.disabled,
    })
    const fields: Record<string, unknown> = {
      organizationId: row.id,
      oracle: oracle.id,
      moduleId: oracle.moduleId,
      legacy,
      resolved,
      state: state.state,
      reason: state.state === "off" ? state.reason : null,
      requires: state.state === "off" && state.reason === "requires" ? state.requires : null,
      knownDivergence: divergence?.code ?? null,
      disabledSource: inspection.prepared.disabledSource,
      modulesRevision: inspection.prepared.document.status === "valid" ? inspection.prepared.document.doc.revision : null,
      deployment: inspection.deployment,
    }
    if (this.allow(`${row.id}|${oracle.id}`)) {
      if (divergence) this.logger.info("den_modules_shadow_mismatch", fields)
      else this.logger.warn("den_modules_shadow_mismatch", fields)
    }
    return true
  }

  /**
   * R7 replaces the `legacyCapabilities` mirror: the column's kill switches
   * must equal the metadata ones while only system writes (backfill and the
   * W0-02 dual-write, `updatedBy === null`) have touched the document. Catches
   * a missed dual-write.
   */
  private checkMirror(row: OrgModuleRow, inspection: ShadowInspection): void {
    const document = inspection.prepared.document
    if (document.status !== "valid" || document.doc.updatedBy !== null) return
    const fromMetadata = legacyDisabledModules(inspection.prepared.legacy)
    for (const moduleId of LEGACY_KILL_SWITCHES) {
      const column = document.doc.disabled.includes(moduleId)
      const metadata = fromMetadata.includes(moduleId)
      if (column === metadata) continue
      if (!this.allow(`${row.id}|mirror:${moduleId}`)) continue
      this.logger.warn("den_modules_legacy_mirror_mismatch", {
        organizationId: row.id,
        moduleId,
        columnDisabled: column,
        metadataDisabled: metadata,
        modulesRevision: document.doc.revision,
      })
    }
  }

  private allow(key: string): boolean {
    const nowMs = this.clock().getTime()
    if (nowMs - this.windowStart >= MINUTE_MS) {
      if (this.dropped > 0) this.logger.warn("den_modules_shadow_dropped", { dropped: this.dropped, windowStartedAt: new Date(this.windowStart).toISOString() })
      this.windowStart = nowMs
      this.windowCount = 0
      this.dropped = 0
    }
    const last = this.lastLogged.get(key)
    if (last !== undefined && nowMs - last < this.options.perKeyIntervalMs) return false
    if (this.windowCount >= this.options.maxLogsPerMinute) {
      this.dropped += 1
      return false
    }
    this.windowCount += 1
    this.lastLogged.delete(key)
    this.lastLogged.set(key, nowMs)
    while (this.lastLogged.size > MAX_RATE_KEYS) {
      const oldest = this.lastLogged.keys().next()
      if (oldest.done) break
      this.lastLogged.delete(oldest.value)
    }
    return true
  }

  private reportFailure(error: unknown, oracle?: string): void {
    const key = oracle ?? "(runtime)"
    if (this.failuresLogged.has(key)) return
    this.failuresLogged.add(key)
    this.logger.error("den_modules_shadow_failed", {
      oracle: oracle ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
