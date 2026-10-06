import {
  LICENSE_CACHE_TTL_BOUNDS,
  LICENSE_CACHE_TTL_SECONDS,
  normalizeLicenseCheckResponse,
  type LicenseCheckRequestV2,
  type LicenseCheckResponseAny,
  type LicenseEntitlement,
} from "@openwork/license-contracts/license"
import { computeTransitionStart, type EntitlementSnapshot } from "@openwork/license-contracts/org-modules"
import type { OrganizationModules } from "@openwork-ee/den-db/organization-modules"
import type { ModuleLogger } from "../logger"
import type { OrgModuleRow } from "../org-row"
import type { LicenseClient, LicenseRequestContext, LicenseScope } from "./license-client"
import type { InstanceSnapshotStore, LeaseStore, OrgEntitlementStore } from "./stores"

export type RefreshOutcome =
  | { readonly kind: "updated" | "unchanged" }
  | { readonly kind: "skipped"; readonly why: "fresh" | "inflight" | "lease_held" | "backoff" | "disabled" }
  | { readonly kind: "unavailable"; readonly error: string }
  | { readonly kind: "rejected"; readonly status: 401 | 403 }

export interface EntitlementRefresherOptions {
  readonly client: LicenseClient
  readonly request: LicenseRequestContext
  readonly orgStore: OrgEntitlementStore
  readonly instanceStore: InstanceSnapshotStore
  /** Self-hosted instance key fingerprint; `null` when no key is configured. */
  readonly instanceFingerprint: string | null
  readonly leases?: LeaseStore
  readonly writeThrottleMs: number
  readonly jitterRatio: number
  readonly clock: () => Date
  readonly random: () => number
  readonly logger: ModuleLogger
  /** After a Cloud snapshot write commits. */
  readonly onOrgWritten: (before: OrgModuleRow, after: OrganizationModules) => void
  /** After the instance snapshot changes in memory. */
  readonly onInstanceSnapshot: (snapshot: EntitlementSnapshot) => void
}

const BACKOFF_INITIAL_MS = 60_000
const BACKOFF_MAX_MS = LICENSE_CACHE_TTL_BOUNDS.max * 1000
const MAX_TRACKED_SCOPES = 50_000

function clampTtlSeconds(seconds: number): number {
  return Math.min(LICENSE_CACHE_TTL_BOUNDS.max, Math.max(LICENSE_CACHE_TTL_BOUNDS.min, seconds))
}

function sortedRecord(record: Readonly<Record<string, boolean>>): Array<[string, boolean]> {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The parts of an answer that change what the resolver does (not `checkedAt`). */
function entitlementFingerprint(license: LicenseEntitlement): string {
  return JSON.stringify([
    license.licenseId,
    license.status,
    license.kind,
    sortedRecord(license.modules),
    sortedRecord(license.featureFlags),
    license.maxUsers,
    license.expiresAt,
    license.invalidatedAt,
  ])
}

function scopeKey(scope: LicenseScope): string {
  return "organizationId" in scope ? `org:${scope.organizationId}` : "instance"
}

/**
 * Stale-while-revalidate refresh of entitlement snapshots (discovery §7.3,
 * §7.4). Singleflight per scope and replica, an optional cross-replica lease
 * held for the TTL, jittered TTLs, doubling failure backoff and an hourly
 * write throttle. `lastVerifiedAt` only advances on success, and a rejected
 * credential persists the transition start, so failures and restarts can
 * never extend grace.
 */
export class EntitlementRefresher {
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>()
  private readonly backoff = new Map<string, { until: number; delayMs: number }>()
  private readonly freshUntil = new Map<string, number>()
  private instance: EntitlementSnapshot | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(private readonly options: EntitlementRefresherOptions) {}

  get instanceSnapshot(): EntitlementSnapshot | null {
    return this.instance
  }

  /** Request path: never awaited by the caller. */
  maybeRefreshOrg(row: OrgModuleRow, current: EntitlementSnapshot | null): Promise<RefreshOutcome> {
    return this.refresh({ organizationId: row.id }, current, false, (next) => this.persistOrg(row, next))
  }

  /** Operators and the Phase 5 invalidation webhook: bypasses freshness, backoff and the lease, not the singleflight. */
  refreshOrgNow(row: OrgModuleRow, current: EntitlementSnapshot | null): Promise<RefreshOutcome> {
    return this.refresh({ organizationId: row.id }, current, true, (next) => this.persistOrg(row, next))
  }

  refreshInstance(force: boolean): Promise<RefreshOutcome> {
    if (this.options.instanceFingerprint === null) return Promise.resolve({ kind: "skipped", why: "disabled" })
    return this.refresh({ instance: true }, this.instance, force, (next) => this.persistInstance(next))
  }

  /** Loads the persisted instance snapshot (self-hosted, license key configured). */
  async loadInstance(): Promise<void> {
    const fingerprint = this.options.instanceFingerprint
    if (fingerprint === null) return
    const snapshot = await this.options.instanceStore.load(fingerprint)
    if (snapshot) {
      this.instance = snapshot
      this.options.onInstanceSnapshot(snapshot)
    }
  }

  /** Schedules the instance refresh at the snapshot's `nextRefreshAt` (or now), rescheduling after each attempt. */
  startInstanceTimer(): void {
    if (this.options.instanceFingerprint === null || this.closed) return
    const next = this.instance ? Date.parse(this.instance.nextRefreshAt) : Number.NaN
    this.schedule(Number.isNaN(next) ? 0 : next - this.options.clock().getTime())
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refreshInstance(false).then(
        () => this.reschedule(),
        (error: unknown) => {
          this.options.logger.error("den_modules_instance_refresh_failed", { error: error instanceof Error ? error.message : String(error) })
          this.reschedule()
        },
      )
    }, Math.max(0, delayMs))
    this.timer.unref?.()
  }

  private reschedule(): void {
    const nowMs = this.options.clock().getTime()
    const key = scopeKey({ instance: true })
    const candidates = [this.freshUntil.get(key), this.backoff.get(key)?.until].filter((value): value is number => value !== undefined && value > nowMs)
    this.schedule(candidates.length > 0 ? Math.min(...candidates) - nowMs : LICENSE_CACHE_TTL_SECONDS * 1000)
  }

  private jitter(value: number): number {
    const ratio = Math.min(1, Math.max(0, this.options.jitterRatio))
    return Math.round(value * (1 + (this.options.random() * 2 - 1) * ratio))
  }

  private refresh(
    scope: LicenseScope,
    current: EntitlementSnapshot | null,
    force: boolean,
    persist: (next: EntitlementSnapshot) => Promise<boolean>,
  ): Promise<RefreshOutcome> {
    if (this.options.client.disabled) return Promise.resolve({ kind: "skipped", why: "disabled" })
    const key = scopeKey(scope)
    const running = this.inflight.get(key)
    if (running) return force ? running : Promise.resolve({ kind: "skipped", why: "inflight" })
    const nowMs = this.options.clock().getTime()
    if (!force) {
      const fresh = Math.max(this.freshUntil.get(key) ?? 0, current ? Date.parse(current.nextRefreshAt) || 0 : 0)
      if (fresh > nowMs) return Promise.resolve({ kind: "skipped", why: "fresh" })
      const failing = this.backoff.get(key)
      if (failing && failing.until > nowMs) return Promise.resolve({ kind: "skipped", why: "backoff" })
    }
    const attempt = this.attempt(key, scope, current, force, persist).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, attempt)
    return attempt
  }

  private async attempt(
    key: string,
    scope: LicenseScope,
    current: EntitlementSnapshot | null,
    force: boolean,
    persist: (next: EntitlementSnapshot) => Promise<boolean>,
  ): Promise<RefreshOutcome> {
    const { leases, request, client } = this.options
    if (!force && leases) {
      const ttlSeconds = current ? clampTtlSeconds(current.payload.cacheTtlSeconds) : LICENSE_CACHE_TTL_SECONDS
      if (!(await leases.acquire(`den-modules:entitlement:${key}`, this.jitter(ttlSeconds * 1000)))) return { kind: "skipped", why: "lease_held" }
    }
    let result: Awaited<ReturnType<LicenseClient["check"]>>
    try {
      const body: LicenseCheckRequestV2 = {
        schemaVersion: 2,
        baseUrl: request.baseUrl,
        currentUsers: await request.currentUsers(scope),
        instanceId: request.instanceId,
        version: request.version,
        ...("organizationId" in scope ? { organizationId: scope.organizationId } : {}),
      }
      result = await client.check(body, scope)
    } catch (error) {
      result = { kind: "unavailable", error: error instanceof Error ? error.message : String(error) }
    }
    const now = this.options.clock()
    switch (result.kind) {
      case "disabled":
        return { kind: "skipped", why: "disabled" }
      case "unavailable":
        this.enterBackoff(key, now.getTime())
        this.options.logger.warn("den_modules_entitlement_unavailable", { scope: key, error: result.error })
        return { kind: "unavailable", error: result.error }
      case "rejected": {
        this.enterBackoff(key, now.getTime())
        this.options.logger.warn("den_modules_entitlement_rejected", { scope: key, status: result.status })
        if (!current) return { kind: "rejected", status: result.status }
        const nowIso = now.toISOString()
        const next: EntitlementSnapshot = {
          ...current,
          credentialRejectedAt: current.credentialRejectedAt ?? nowIso,
          transitionStartedAt: current.transitionStartedAt ?? nowIso,
        }
        if (next.credentialRejectedAt !== current.credentialRejectedAt || next.transitionStartedAt !== current.transitionStartedAt) {
          await this.safePersist(key, persist, next)
        }
        return { kind: "rejected", status: result.status }
      }
      case "ok": {
        this.backoff.delete(key)
        const { next, changed } = this.nextSnapshot(current, result.response, now)
        this.remember(this.freshUntil, key, Date.parse(next.nextRefreshAt))
        const stale = !current || now.getTime() - Date.parse(current.lastVerifiedAt) >= this.options.writeThrottleMs
        if (!changed && !stale) return { kind: "unchanged" }
        if (!(await this.safePersist(key, persist, next))) return { kind: "unavailable", error: "persist_failed" }
        return { kind: changed ? "updated" : "unchanged" }
      }
    }
  }

  /**
   * The next snapshot after a successful check. The transition start persists
   * while the license stays unhealthy (earliest observation wins) and clears
   * once it is healthy again; `credentialRejectedAt` clears only when the
   * server says `active`.
   */
  private nextSnapshot(current: EntitlementSnapshot | null, response: LicenseCheckResponseAny, now: Date): { next: EntitlementSnapshot; changed: boolean } {
    const license = normalizeLicenseCheckResponse(response)
    const nowIso = now.toISOString()
    const credentialRejectedAt = license.status === "active" ? null : current?.credentialRejectedAt ?? null
    const computed = computeTransitionStart({ source: "license", license, lastVerifiedAt: nowIso, transitionStartedAt: null, credentialRejectedAt }, now)
    const transitionStartedAt = computed === null ? null : current?.transitionStartedAt ?? computed
    const next: EntitlementSnapshot = {
      schemaVersion: 1,
      payload: response,
      lastVerifiedAt: nowIso,
      nextRefreshAt: new Date(now.getTime() + this.jitter(clampTtlSeconds(license.cacheTtlSeconds) * 1000)).toISOString(),
      transitionStartedAt,
      credentialRejectedAt,
    }
    const changed = !current
      || entitlementFingerprint(normalizeLicenseCheckResponse(current.payload)) !== entitlementFingerprint(license)
      || current.transitionStartedAt !== transitionStartedAt
      || current.credentialRejectedAt !== credentialRejectedAt
    return { next, changed }
  }

  private async safePersist(key: string, persist: (next: EntitlementSnapshot) => Promise<boolean>, next: EntitlementSnapshot): Promise<boolean> {
    try {
      if (await persist(next)) return true
    } catch (error) {
      this.options.logger.error("den_modules_entitlement_persist_failed", { scope: key, error: error instanceof Error ? error.message : String(error) })
    }
    this.enterBackoff(key, this.options.clock().getTime())
    return false
  }

  private async persistOrg(row: OrgModuleRow, next: EntitlementSnapshot): Promise<boolean> {
    const result = await this.options.orgStore.persist(row.id, next)
    if (result.status !== "written") {
      this.options.logger.warn("den_modules_entitlement_persist_skipped", { organizationId: row.id, status: result.status })
      return false
    }
    this.options.onOrgWritten(row, result.modules)
    return true
  }

  private async persistInstance(next: EntitlementSnapshot): Promise<boolean> {
    const fingerprint = this.options.instanceFingerprint
    if (fingerprint === null) return false
    await this.options.instanceStore.save(fingerprint, next)
    this.instance = next
    this.options.onInstanceSnapshot(next)
    return true
  }

  private enterBackoff(key: string, nowMs: number): void {
    const previous = this.backoff.get(key)
    const delayMs = previous ? Math.min(previous.delayMs * 2, BACKOFF_MAX_MS) : BACKOFF_INITIAL_MS
    this.remember(this.backoff, key, { until: nowMs + delayMs, delayMs })
  }

  /** Inspection for tests and diagnostics. */
  backoffOf(scope: LicenseScope): { until: number; delayMs: number } | undefined {
    return this.backoff.get(scopeKey(scope))
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > MAX_TRACKED_SCOPES) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
  }
}
