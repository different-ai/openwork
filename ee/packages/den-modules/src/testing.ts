import type { LicenseCheckResponseAny } from "@openwork/license-contracts/license"
import type { EntitlementSnapshot, OrganizationModules } from "@openwork/license-contracts/org-modules"
import type { LicenseCheckResult, LicenseClient, LicenseScope } from "./entitlement/license-client"
import type { InstanceSnapshotStore, LeaseStore, OrgEntitlementStore, OrgRowLoader } from "./entitlement/stores"
import type { InstanceConfig } from "./instance/config"
import type { ModuleLogger } from "./logger"
import type { OrgModuleRow } from "./org-row"

export interface FakeClock {
  readonly now: () => Date
  set(value: Date | string): void
  advance(ms: number): void
}

export function createFakeClock(start: Date | string = "2026-10-06T12:00:00.000Z"): FakeClock {
  let current = new Date(start).getTime()
  return {
    now: () => new Date(current),
    set: (value) => {
      current = new Date(value).getTime()
    },
    advance: (ms) => {
      current += ms
    },
  }
}

export interface LoggedEvent {
  readonly level: "info" | "warn" | "error"
  readonly event: string
  readonly fields: Record<string, unknown>
}

export function createMemoryLogger(): ModuleLogger & { readonly events: LoggedEvent[]; named(event: string): LoggedEvent[] } {
  const events: LoggedEvent[] = []
  return {
    events,
    named: (event) => events.filter((entry) => entry.event === event),
    info: (event, fields) => {
      events.push({ level: "info", event, fields })
    },
    warn: (event, fields) => {
      events.push({ level: "warn", event, fields })
    },
    error: (event, fields) => {
      events.push({ level: "error", event, fields })
    },
  }
}

/** Every infrastructure input known and present; every deprecated flag at den-api's default. */
export function testInstanceConfig(overrides: {
  orgMode?: InstanceConfig["orgMode"]
  infra?: Partial<InstanceConfig["infra"]>
  deprecatedFlags?: Partial<InstanceConfig["deprecatedFlags"]>
} = {}): InstanceConfig {
  return {
    orgMode: overrides.orgMode ?? "multi_org",
    infra: {
      gatewayEnabled: true,
      headlessRunnerConfigured: true,
      workbotConfigured: true,
      cloudRuntimeAvailable: true,
      freeInferenceConfigured: true,
      ...overrides.infra,
    },
    deprecatedFlags: {
      planGatingEnabled: false,
      automationsRuntimeEnabled: true,
      automationsDesktopEnabled: false,
      appMcpServersEnabled: true,
      dashboardsDesktopEnabled: false,
      openworkWebEnabled: false,
      auditCaptureEnabled: true,
      auditVisibilityEnabled: true,
      auditSelfHostedEnabled: false,
      slackAssistantWorkerEnabled: true,
      ...overrides.deprecatedFlags,
    },
  }
}

export function testOrgRow(input: { id?: string; metadata?: unknown; modules?: unknown } = {}): OrgModuleRow {
  return { id: input.id ?? "org_test", metadata: input.metadata ?? null, modules: input.modules ?? null }
}

export function testOrganizationModules(overrides: Partial<OrganizationModules> = {}): OrganizationModules {
  return { schemaVersion: 1, revision: 1, disabled: [], updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: null, ...overrides }
}

/** A valid v2 license answer. */
export function testLicenseResponse(overrides: Partial<Extract<LicenseCheckResponseAny, { schemaVersion: 2 }>> = {}): LicenseCheckResponseAny {
  return {
    schemaVersion: 2,
    licenseId: "lic_test",
    kind: "standard",
    status: "active",
    modules: {},
    featureFlags: {},
    maxUsers: 100,
    expiresAt: null,
    invalidatedAt: null,
    checkedAt: "2026-10-06T12:00:00.000Z",
    cacheTtlSeconds: 300,
    ...overrides,
  }
}

export function testEntitlementSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    schemaVersion: 1,
    payload: testLicenseResponse(),
    lastVerifiedAt: "2026-10-06T12:00:00.000Z",
    nextRefreshAt: "2026-10-06T12:05:00.000Z",
    transitionStartedAt: null,
    credentialRejectedAt: null,
    ...overrides,
  }
}

export type FakeLicenseStep = LicenseCheckResult | ((scope: LicenseScope) => LicenseCheckResult | Promise<LicenseCheckResult>)

/** Answers each check with the next scripted step; the last step repeats. */
export function createFakeLicenseClient(script: readonly FakeLicenseStep[]): LicenseClient & { readonly calls: LicenseScope[] } {
  const calls: LicenseScope[] = []
  return {
    calls,
    async check(_request, scope) {
      calls.push(scope)
      const step = script[Math.min(calls.length - 1, script.length - 1)]
      if (step === undefined) return { kind: "unavailable", error: "no scripted answer" }
      return typeof step === "function" ? step(scope) : step
    },
  }
}

export function createMemoryOrgEntitlementStore(initial: Record<string, OrganizationModules> = {}): OrgEntitlementStore & {
  readonly docs: Map<string, OrganizationModules>
  readonly writes: Array<{ organizationId: string; snapshot: EntitlementSnapshot }>
} {
  const docs = new Map(Object.entries(initial))
  const writes: Array<{ organizationId: string; snapshot: EntitlementSnapshot }> = []
  return {
    docs,
    writes,
    async persist(organizationId, next) {
      const current = docs.get(organizationId) ?? testOrganizationModules({ revision: 0 })
      const modules = { ...current, revision: current.revision + 1, entitlement: next }
      docs.set(organizationId, modules)
      writes.push({ organizationId, snapshot: next })
      return { status: "written", modules }
    },
  }
}

export function createMemoryInstanceSnapshotStore(initial: Record<string, EntitlementSnapshot> = {}): InstanceSnapshotStore & {
  readonly rows: Map<string, EntitlementSnapshot>
} {
  const rows = new Map(Object.entries(initial))
  return {
    rows,
    async load(fingerprint) {
      return rows.get(fingerprint) ?? null
    },
    async save(fingerprint, snapshot) {
      rows.clear()
      rows.set(fingerprint, snapshot)
    },
  }
}

export function createMemoryLeaseStore(clock: () => Date): LeaseStore & { readonly acquired: string[] } {
  const leases = new Map<string, number>()
  const acquired: string[] = []
  return {
    acquired,
    async acquire(key, ttlMs) {
      const nowMs = clock().getTime()
      const until = leases.get(key)
      if (until !== undefined && until > nowMs) return false
      leases.set(key, nowMs + ttlMs)
      acquired.push(key)
      return true
    },
  }
}

export function createMemoryOrgRowLoader(rows: readonly OrgModuleRow[]): OrgRowLoader & { readonly loads: string[] } {
  const loads: string[] = []
  return {
    loads,
    async load(organizationId) {
      loads.push(organizationId)
      return rows.find((row) => row.id === organizationId) ?? null
    },
  }
}
