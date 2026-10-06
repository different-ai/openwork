import type { Deployment, ModuleId } from "@openwork/license-contracts/modules"
import {
  resolveModules,
  type EffectiveModules,
  type EntitlementInput,
  type ModuleState,
  type ResolverInputs,
} from "@openwork/license-contracts/resolver"
import type { EntitlementSnapshot } from "@openwork/license-contracts/org-modules"
import { parseDevOverride } from "./entitlement/dev-override"
import type { LicenseClient, LicenseRequestContext } from "./entitlement/license-client"
import { EntitlementRefresher, type RefreshOutcome } from "./entitlement/refresher"
import { licenseEntitlementInput, orgSnapshotNeedsRefresh, type EntitlementMode } from "./entitlement/sources"
import {
  createDenDbInstanceSnapshotStore,
  createDenDbOrgEntitlementStore,
  createDenDbOrgRowLoader,
  licenseKeyFingerprint,
  type DenModulesDatabase,
  type InstanceSnapshotStore,
  type LeaseStore,
  type OrgEntitlementStore,
  type OrgRowLoader,
} from "./entitlement/stores"
import { computeInstanceAvailability, type AvailabilitySnapshot } from "./instance/availability"
import type { InstanceConfig } from "./instance/config"
import { legacyEntitlementInput, prepareOrg, type PreparedOrg } from "./legacy/adapter"
import { legacyInputsDigest, extractLegacyOrgInputs } from "./legacy/inputs"
import { legacyPlanAllows, type LegacyPlanOperation } from "./legacy/mapping"
import { createConsoleModuleLogger, type ModuleLogger } from "./logger"
import { EffectiveModulesMemo, internEffectiveModules } from "./memo"
import { parseOrgModulesDocument, revisionKey, type OrgModuleRow, type OrgModulesDocument } from "./org-row"
import { ShadowComparator, type LegacyOracle, type ShadowInspection } from "./shadow"
import { diffEffectiveModules, TransitionDispatcher, type ModuleTransitionListener, type TransitionCause } from "./transitions"

export interface LicenseRuntimeOptions {
  readonly client: LicenseClient
  readonly request: LicenseRequestContext
  /** Default: the den-db store (Cloud). */
  readonly orgStore?: OrgEntitlementStore
  /** Default: the den-db store (self-hosted). */
  readonly instanceStore?: InstanceSnapshotStore
  /** Self-hosted; absent → entitlement `none` (D14). */
  readonly licenseKey?: string
  /** Absent → per-replica singleflight only. */
  readonly leases?: LeaseStore
  /** Default 3_600_000: advance `lastVerifiedAt` in storage at most hourly. */
  readonly writeThrottleMs?: number
  /** Default 0.1, on `nextRefreshAt` and the lease TTL. */
  readonly jitterRatio?: number
}

export interface ModuleRuntimeOptions {
  readonly deployment: Deployment
  readonly instance: InstanceConfig
  /** Default `"all"`; the gateway passes the modules it can observe. */
  readonly availabilityObservable?: "all" | readonly ModuleId[]
  /** den-db handle: org reads by id and the default entitlement stores. */
  readonly database?: DenModulesDatabase
  /** Test seam replacing the den-db org read. */
  readonly orgRows?: OrgRowLoader
  /** Default `"legacy"`. */
  readonly entitlementMode?: EntitlementMode
  /** Raw `DEN_LICENSE_DEV_OVERRIDE`; required iff `devOverride`. */
  readonly devOverride?: string
  /** Required iff `license`. */
  readonly license?: LicenseRuntimeOptions
  /** Ids whose legacy gates already read the resolver (W0-04). Each module plan adds its own. */
  readonly toggleWiredModules?: readonly ModuleId[]
  /** Defaults 10_000 entries / 600_000 ms. */
  readonly memo?: { readonly maxEntries?: number; readonly maxTtlMs?: number }
  readonly shadow?: {
    readonly enabled?: boolean
    /** Default 1.0. */
    readonly sampleRate?: number
    /** Default 100. */
    readonly maxLogsPerMinute?: number
    /** Default 3_600_000. */
    readonly perKeyIntervalMs?: number
  }
  readonly clock?: () => Date
  /** Test seam for sampling and jitter. */
  readonly random?: () => number
  readonly logger?: ModuleLogger
  /** Guards dev override and the stub license client. */
  readonly isProduction: boolean
}

export interface ModuleRuntime {
  readonly deployment: Deployment
  readonly entitlementMode: EntitlementMode
  readonly availability: AvailabilitySnapshot
  /** Loads the instance snapshot (self-hosted, license mode) and starts its refresh timer. No-op otherwise. */
  start(): Promise<void>
  close(): Promise<void>

  /** Request path. Sync, memoized, never awaits I/O. May schedule a background refresh (license mode). */
  getEffectiveModules(row: OrgModuleRow): EffectiveModules
  /** Jobs and helpers without a row: one SELECT of `organizationModuleStateColumns`, then `getEffectiveModules`. */
  getEffectiveModulesForOrgId(organizationId: string): Promise<EffectiveModules | null>
  /** Transaction callers holding a locked row: no memo, no refresh, no transition events. */
  resolveForRow(row: OrgModuleRow, options?: { now?: Date }): EffectiveModules
  stateOf(row: OrgModuleRow, id: ModuleId): ModuleState
  isOn(row: OrgModuleRow, id: ModuleId): boolean
  isUsable(row: OrgModuleRow, id: ModuleId): boolean
  /** Legacy operation-level plan gates (00-legacy-mapping §C), for module code until Phase 5. */
  planAllows(row: OrgModuleRow, operation: LegacyPlanOperation): boolean
  /**
   * Org-independent state for instance-only routes. Resolved for a synthetic
   * org with no metadata and no document, so only the deployment,
   * availability and (self-hosted license mode) instance entitlement reasons
   * are meaningful; per-org grants read as `not_entitled` in legacy mode.
   */
  instanceState(id: ModuleId): ModuleState
  toggleWired(id: ModuleId): boolean

  onModuleTransition(listener: ModuleTransitionListener): () => void
  /** Writers call this after commit (W0-04 toggle, legacy kill-switch writes, the refresher). Emits with a cause. */
  recordModulesWrite(input: { before: OrgModuleRow; after: OrgModuleRow; cause: TransitionCause }): void

  registerLegacyOracles(oracles: readonly LegacyOracle[]): void
  /** Fire-and-forget, sampled, rate-limited. Never throws. */
  shadowCompare(row: OrgModuleRow): void
  /** Synchronous shadow comparison for tests and offline checks; returns mismatching oracle ids. */
  shadowCompareNow(row: OrgModuleRow): string[]

  refreshEntitlementNow(target: { organizationId: string } | { instance: true }): Promise<RefreshOutcome>
}

const SYNTHETIC_INSTANCE_ROW: OrgModuleRow = Object.freeze({ id: "(instance)", metadata: null, modules: null })

export function createModuleRuntime(options: ModuleRuntimeOptions): ModuleRuntime {
  const logger = options.logger ?? createConsoleModuleLogger()
  const clock = options.clock ?? (() => new Date())
  const random = options.random ?? Math.random
  const mode: EntitlementMode = options.entitlementMode ?? "legacy"
  const { deployment, instance: config } = options

  const devOverride = mode === "devOverride" ? requireDevOverride(options) : null
  if (mode === "license") requireLicense(options)

  const availability = computeInstanceAvailability({
    config,
    deployment,
    observable: options.availabilityObservable,
    now: clock(),
  })
  const memo = new EffectiveModulesMemo(options.memo?.maxEntries ?? 10_000, options.memo?.maxTtlMs ?? 600_000)
  const transitions = new TransitionDispatcher(logger)
  const toggleWiredModules = new Set<ModuleId>(options.toggleWiredModules ?? [])
  const reportedInvalid = new Set<string>()
  let instanceVersion = 0
  let instanceStateCache: { version: number; value: EffectiveModules } | null = null

  const orgRows = options.orgRows ?? (options.database ? createDenDbOrgRowLoader(options.database) : null)
  const refresher = mode === "license" ? createRefresher() : null

  function createRefresher(): EntitlementRefresher {
    const license = requireLicense(options)
    const orgStore = license.orgStore ?? (options.database ? createDenDbOrgEntitlementStore(options.database) : null)
    const instanceStore = license.instanceStore ?? (options.database ? createDenDbInstanceSnapshotStore(options.database) : null)
    if (!orgStore || !instanceStore) throw new Error("License mode needs a database or explicit entitlement stores.")
    const licenseKey = license.licenseKey?.trim()
    return new EntitlementRefresher({
      client: license.client,
      request: license.request,
      orgStore,
      instanceStore,
      instanceFingerprint: deployment === "selfHosted" && licenseKey ? licenseKeyFingerprint(licenseKey, license.request.baseUrl) : null,
      leases: license.leases,
      writeThrottleMs: license.writeThrottleMs ?? 3_600_000,
      jitterRatio: license.jitterRatio ?? 0.1,
      clock,
      random,
      logger,
      onOrgWritten: (before, after) => recordModulesWrite({ before, after: { id: before.id, metadata: before.metadata, modules: after }, cause: "entitlement_refresh" }),
      onInstanceSnapshot: () => {
        instanceVersion += 1
      },
    })
  }

  function documentOf(row: OrgModuleRow): OrgModulesDocument {
    const document = parseOrgModulesDocument(row)
    if (document.status === "invalid" && !reportedInvalid.has(row.id)) {
      if (reportedInvalid.size < 10_000) reportedInvalid.add(row.id)
      logger.warn("den_modules_document_invalid", { organizationId: row.id, issues: document.issues.slice(0, 5) })
    }
    return document
  }

  function entitlementFor(prepared: PreparedOrg): EntitlementInput {
    switch (mode) {
      case "legacy":
        return legacyEntitlementInput(prepared.legacy, config)
      case "devOverride":
        return devOverride ?? legacyEntitlementInput(prepared.legacy, config)
      case "license":
        return licenseEntitlementInput({
          deployment,
          document: prepared.document,
          instanceSnapshot: refresher?.instanceSnapshot ?? null,
          hasLicenseKey: Boolean(options.license?.licenseKey?.trim()),
        })
    }
  }

  function inputsFor(prepared: PreparedOrg, now: Date): ResolverInputs {
    return { deployment, availability: availability.map, entitlement: entitlementFor(prepared), disabled: prepared.disabled, now }
  }

  function prepare(row: OrgModuleRow): PreparedOrg {
    return prepareOrg(row.metadata, documentOf(row))
  }

  function memoKey(row: OrgModuleRow): string {
    return `${revisionKey(row)}|${availability.version}.${instanceVersion}|${legacyInputsDigest(extractLegacyOrgInputs(row.metadata))}`
  }

  function resolveForRow(row: OrgModuleRow, resolveOptions: { now?: Date } = {}): EffectiveModules {
    return resolveModules(inputsFor(prepare(row), resolveOptions.now ?? clock()))
  }

  function getEffectiveModules(row: OrgModuleRow): EffectiveModules {
    const now = clock()
    const nowMs = now.getTime()
    const key = memoKey(row)
    const hit = memo.get(row.id, key, nowMs)
    if (hit) return hit
    const previous = memo.peek(row.id)?.value
    const prepared = prepare(row)
    const value = internEffectiveModules(resolveModules(inputsFor(prepared, now)))
    if (previous) transitions.emit(row.id, diffEffectiveModules(previous, value), "observed", now)
    memo.set(row.id, key, value, nowMs)
    if (refresher && deployment === "cloud" && orgSnapshotNeedsRefresh(prepared.document, nowMs)) {
      const current = prepared.document.status === "valid" ? prepared.document.doc.entitlement ?? null : null
      refresher.maybeRefreshOrg(row, current).catch((error: unknown) => {
        logger.error("den_modules_entitlement_refresh_failed", { organizationId: row.id, error: error instanceof Error ? error.message : String(error) })
      })
    }
    return value
  }

  function recordModulesWrite(input: { before: OrgModuleRow; after: OrgModuleRow; cause: TransitionCause }): void {
    memo.delete(input.after.id)
    try {
      const now = clock()
      const before = resolveForRow(input.before, { now })
      const after = resolveForRow(input.after, { now })
      transitions.emit(input.after.id, diffEffectiveModules(before, after), input.cause, now)
    } catch (error) {
      logger.error("den_modules_record_write_failed", { organizationId: input.after.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  function inspect(row: OrgModuleRow): ShadowInspection {
    return { effective: getEffectiveModules(row), prepared: prepare(row), deployment, config }
  }

  const shadow = new ShadowComparator(
    {
      enabled: options.shadow?.enabled ?? true,
      sampleRate: options.shadow?.sampleRate ?? 1,
      maxLogsPerMinute: options.shadow?.maxLogsPerMinute ?? 100,
      perKeyIntervalMs: options.shadow?.perKeyIntervalMs ?? 3_600_000,
    },
    inspect,
    logger,
    clock,
    random,
  )

  async function currentOrgSnapshot(organizationId: string): Promise<{ row: OrgModuleRow; current: EntitlementSnapshot | null } | null> {
    if (!orgRows) throw new Error("Module runtime has no database to read organizations from.")
    const row = await orgRows.load(organizationId)
    if (!row) return null
    const document = documentOf(row)
    return { row, current: document.status === "valid" ? document.doc.entitlement ?? null : null }
  }

  return {
    deployment,
    entitlementMode: mode,
    availability,
    async start() {
      if (!refresher) return
      await refresher.loadInstance()
      refresher.startInstanceTimer()
    },
    async close() {
      refresher?.close()
      memo.clear()
    },
    getEffectiveModules,
    async getEffectiveModulesForOrgId(organizationId) {
      if (!orgRows) throw new Error("Module runtime has no database to read organizations from.")
      const row = await orgRows.load(organizationId)
      return row ? getEffectiveModules(row) : null
    },
    resolveForRow,
    stateOf: (row, id) => getEffectiveModules(row).modules[id],
    isOn: (row, id) => getEffectiveModules(row).modules[id].state === "on",
    isUsable: (row, id) => getEffectiveModules(row).modules[id].state !== "off",
    planAllows: (row, operation) => legacyPlanAllows(operation, extractLegacyOrgInputs(row.metadata), config),
    instanceState(id) {
      if (!instanceStateCache || instanceStateCache.version !== instanceVersion) {
        instanceStateCache = { version: instanceVersion, value: internEffectiveModules(resolveForRow(SYNTHETIC_INSTANCE_ROW)) }
      }
      return instanceStateCache.value.modules[id]
    },
    toggleWired: (id) => toggleWiredModules.has(id),
    onModuleTransition: (listener) => transitions.subscribe(listener),
    recordModulesWrite,
    registerLegacyOracles: (oracles) => shadow.register(oracles),
    shadowCompare: (row) => shadow.compare(row),
    shadowCompareNow: (row) => shadow.run(row),
    async refreshEntitlementNow(target) {
      if (!refresher) return { kind: "skipped", why: "disabled" }
      if ("instance" in target) return refresher.refreshInstance(true)
      const found = await currentOrgSnapshot(target.organizationId)
      if (!found) return { kind: "unavailable", error: "organization_not_found" }
      return refresher.refreshOrgNow(found.row, found.current)
    },
  }
}

function requireDevOverride(options: ModuleRuntimeOptions): EntitlementInput {
  if (options.isProduction) throw new Error("DEN_LICENSE_DEV_OVERRIDE is a development tool and is refused in production.")
  if (!options.devOverride?.trim()) throw new Error("Entitlement mode devOverride needs DEN_LICENSE_DEV_OVERRIDE.")
  return parseDevOverride(options.devOverride)
}

function requireLicense(options: ModuleRuntimeOptions): LicenseRuntimeOptions {
  const license = options.license
  if (!license) throw new Error("Entitlement mode license needs license options.")
  if (options.isProduction && license.client.disabled) {
    throw new Error("Entitlement mode license has no license client yet (Phase 5); it is refused outside development.")
  }
  return license
}

