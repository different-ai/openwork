import type { EntitlementSnapshot, OrganizationModules } from "@openwork/license-contracts/org-modules"
import { afterEach, describe, expect, test, vi } from "vitest"
import { EntitlementRefresher, type EntitlementRefresherOptions } from "./entitlement/refresher"
import { licenseKeyFingerprint, type LeaseStore } from "./entitlement/stores"
import { createModuleRuntime } from "./runtime"
import {
  createFakeClock,
  createFakeLicenseClient,
  createMemoryInstanceSnapshotStore,
  createMemoryLeaseStore,
  createMemoryLogger,
  createMemoryOrgEntitlementStore,
  createMemoryOrgRowLoader,
  testEntitlementSnapshot,
  testInstanceConfig,
  testLicenseResponse,
  testOrganizationModules,
  testOrgRow,
  type FakeLicenseStep,
} from "./testing"

const request = { baseUrl: "https://den.example.com", instanceId: "pod-1", version: "1.2.3", currentUsers: async () => 7 }
const row = testOrgRow({ id: "org_a" })

function refresher(script: readonly FakeLicenseStep[], overrides: Partial<EntitlementRefresherOptions> = {}) {
  const clock = createFakeClock()
  const client = createFakeLicenseClient(script)
  const orgStore = createMemoryOrgEntitlementStore()
  const instanceStore = createMemoryInstanceSnapshotStore()
  const writes: OrganizationModules[] = []
  const instanceSnapshots: EntitlementSnapshot[] = []
  const value = new EntitlementRefresher({
    client,
    request,
    orgStore,
    instanceStore,
    instanceFingerprint: null,
    writeThrottleMs: 3_600_000,
    jitterRatio: 0.1,
    clock: clock.now,
    random: () => 0.5,
    logger: createMemoryLogger(),
    onOrgWritten: (_before, after) => writes.push(after),
    onInstanceSnapshot: (snapshot) => instanceSnapshots.push(snapshot),
    ...overrides,
  })
  return { refresher: value, clock, client, orgStore, instanceStore, writes, instanceSnapshots }
}

const ok: FakeLicenseStep = { kind: "ok", response: testLicenseResponse({ modules: { auditLogs: true } }) }

afterEach(() => {
  vi.useRealTimers()
})

describe("EntitlementRefresher", () => {
  test("skips a fresh snapshot", async () => {
    const { refresher: subject, client } = refresher([ok])
    const fresh = testEntitlementSnapshot({ nextRefreshAt: "2026-10-06T12:04:00.000Z" })
    expect(await subject.maybeRefreshOrg(row, fresh)).toEqual({ kind: "skipped", why: "fresh" })
    expect(client.calls).toEqual([])
  })

  test("singleflight: concurrent calls make one check", async () => {
    const { refresher: subject, client } = refresher([ok])
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => subject.maybeRefreshOrg(row, null)))
    expect(client.calls).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.kind === "updated")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.kind === "skipped")).toHaveLength(9)
  })

  test("a held lease skips; refreshOrgNow bypasses the lease", async () => {
    const held: LeaseStore = { acquire: async () => false }
    const { refresher: subject, client } = refresher([ok], { leases: held })
    expect(await subject.maybeRefreshOrg(row, null)).toEqual({ kind: "skipped", why: "lease_held" })
    expect(client.calls).toEqual([])
    expect(await subject.refreshOrgNow(row, testEntitlementSnapshot({ nextRefreshAt: "2027-01-01T00:00:00.000Z" }))).toEqual({ kind: "updated" })
  })

  test("the lease is held for the jittered TTL", async () => {
    const clock = createFakeClock()
    const leases = createMemoryLeaseStore(clock.now)
    const acquire = vi.spyOn(leases, "acquire")
    const { refresher: subject } = refresher([ok], { leases, clock: clock.now, random: () => 1 })
    await subject.maybeRefreshOrg(row, null)
    expect(acquire).toHaveBeenCalledWith("den-modules:entitlement:org:org_a", 330_000)
  })

  test("ok: changed → write; unchanged within the hour → no write; after the hour → write", async () => {
    const { refresher: subject, clock, orgStore, writes } = refresher([ok])
    expect(await subject.maybeRefreshOrg(row, null)).toEqual({ kind: "updated" })
    expect(orgStore.writes).toHaveLength(1)
    const stored = orgStore.writes[0]?.snapshot
    expect(stored).toMatchObject({ lastVerifiedAt: "2026-10-06T12:00:00.000Z", nextRefreshAt: "2026-10-06T12:05:00.000Z", transitionStartedAt: null, credentialRejectedAt: null })
    expect(writes).toHaveLength(1)
    clock.advance(10 * 60_000)
    expect(await subject.maybeRefreshOrg(row, stored ?? null)).toEqual({ kind: "unchanged" })
    expect(orgStore.writes).toHaveLength(1)
    clock.advance(60 * 60_000)
    expect(await subject.maybeRefreshOrg(row, stored ?? null)).toEqual({ kind: "unchanged" })
    expect(orgStore.writes).toHaveLength(2)
    expect(orgStore.writes[1]?.snapshot.lastVerifiedAt).toBe(clock.now().toISOString())
  })

  test("unavailable: no write, lastVerifiedAt unchanged, backoff doubles", async () => {
    const { refresher: subject, clock, orgStore } = refresher([{ kind: "unavailable", error: "timeout" }])
    const current = testEntitlementSnapshot({ nextRefreshAt: "2026-10-06T11:00:00.000Z" })
    expect(await subject.maybeRefreshOrg(row, current)).toEqual({ kind: "unavailable", error: "timeout" })
    expect(orgStore.writes).toEqual([])
    expect(subject.backoffOf({ organizationId: "org_a" })?.delayMs).toBe(60_000)
    expect(await subject.maybeRefreshOrg(row, current)).toEqual({ kind: "skipped", why: "backoff" })
    clock.advance(60_000)
    await subject.maybeRefreshOrg(row, current)
    expect(subject.backoffOf({ organizationId: "org_a" })?.delayMs).toBe(120_000)
    expect(current.lastVerifiedAt).toBe("2026-10-06T12:00:00.000Z")
  })

  test("rejected: persists the transition start; the resolver reports grace, then license_expired", async () => {
    const clock = createFakeClock()
    const orgStore = createMemoryOrgEntitlementStore()
    const current = testEntitlementSnapshot({ payload: testLicenseResponse({ modules: { auditLogs: true } }), nextRefreshAt: "2026-10-06T11:59:00.000Z" })
    const document = testOrganizationModules({ entitlement: current })
    const modules = createModuleRuntime({
      deployment: "cloud",
      instance: testInstanceConfig(),
      clock: clock.now,
      isProduction: false,
      logger: createMemoryLogger(),
      entitlementMode: "license",
      orgRows: createMemoryOrgRowLoader([testOrgRow({ id: "org_a", modules: document })]),
      license: { client: createFakeLicenseClient([{ kind: "rejected", status: 401 }]), request, orgStore, instanceStore: createMemoryInstanceSnapshotStore() },
    })
    expect(await modules.refreshEntitlementNow({ organizationId: "org_a" })).toEqual({ kind: "rejected", status: 401 })
    const persisted = orgStore.writes[0]?.snapshot
    expect(persisted).toMatchObject({ credentialRejectedAt: clock.now().toISOString(), transitionStartedAt: clock.now().toISOString(), lastVerifiedAt: current.lastVerifiedAt })
    const after = testOrgRow({ id: "org_a", modules: { ...document, revision: 2, entitlement: persisted } })
    expect(modules.isOn(after, "auditLogs")).toBe(true)
    clock.advance(30 * 24 * 60 * 60_000)
    expect(modules.stateOf(after, "auditLogs")).toEqual({ state: "off", reason: "license_expired" })
  })

  test("a trial that has expired switches licensed modules off at once after the refresh", async () => {
    const clock = createFakeClock()
    const orgStore = createMemoryOrgEntitlementStore()
    const expiredTrial = testLicenseResponse({ kind: "trial", status: "expired", expiresAt: "2026-10-06T11:00:00.000Z", modules: { auditLogs: true } })
    const { refresher: subject } = refresher([{ kind: "ok", response: expiredTrial }], { clock: clock.now, orgStore })
    expect(await subject.maybeRefreshOrg(row, null)).toEqual({ kind: "updated" })
    const persisted = orgStore.writes[0]?.snapshot
    expect(persisted?.transitionStartedAt).toBe("2026-10-06T11:00:00.000Z")
    const modules = createModuleRuntime({
      deployment: "cloud",
      instance: testInstanceConfig(),
      clock: clock.now,
      isProduction: false,
      logger: createMemoryLogger(),
      entitlementMode: "license",
      license: { client: createFakeLicenseClient([ok]), request, orgStore, instanceStore: createMemoryInstanceSnapshotStore() },
    })
    expect(modules.resolveForRow(testOrgRow({ modules: testOrganizationModules({ entitlement: persisted }) })).modules.auditLogs).toEqual({ state: "off", reason: "license_expired" })
  })

  test("a healthy answer clears the transition start; a non-active one keeps the earliest", async () => {
    const { refresher: subject, orgStore } = refresher([ok])
    const unhealthy = testEntitlementSnapshot({ transitionStartedAt: "2026-10-01T00:00:00.000Z", nextRefreshAt: "2026-10-06T11:00:00.000Z" })
    await subject.maybeRefreshOrg(row, unhealthy)
    expect(orgStore.writes[0]?.snapshot.transitionStartedAt).toBeNull()
    const expired = refresher([{ kind: "ok", response: testLicenseResponse({ status: "expired", expiresAt: "2026-10-05T00:00:00.000Z" }) }])
    await expired.refresher.maybeRefreshOrg(row, unhealthy)
    expect(expired.orgStore.writes[0]?.snapshot.transitionStartedAt).toBe("2026-10-01T00:00:00.000Z")
  })

  test("jitter stays within ±10% of the TTL", async () => {
    for (const random of [0, 0.5, 1]) {
      const { refresher: subject, orgStore } = refresher([ok], { random: () => random })
      await subject.maybeRefreshOrg(row, null)
      const next = Date.parse(orgStore.writes[0]?.snapshot.nextRefreshAt ?? "") - Date.parse("2026-10-06T12:00:00.000Z")
      expect(next).toBeGreaterThanOrEqual(270_000)
      expect(next).toBeLessThanOrEqual(330_000)
    }
  })

  test("the stub client is a no-op", async () => {
    const { refresher: subject } = refresher([ok], { client: { disabled: true, check: async () => ({ kind: "disabled" }) } })
    expect(await subject.maybeRefreshOrg(row, null)).toEqual({ kind: "skipped", why: "disabled" })
  })

  test("instance: loads the stored snapshot, refreshes on a timer and reschedules", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T12:00:00.000Z") })
    const fingerprint = licenseKeyFingerprint("key", "https://den.example.com/")
    const stored = testEntitlementSnapshot({ nextRefreshAt: "2026-10-06T12:01:00.000Z" })
    const instanceStore = createMemoryInstanceSnapshotStore({ [fingerprint]: stored })
    const { refresher: subject, client, instanceSnapshots } = refresher([ok], { instanceFingerprint: fingerprint, instanceStore, clock: () => new Date() })
    await subject.loadInstance()
    expect(subject.instanceSnapshot).toEqual(stored)
    subject.startInstanceTimer()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(client.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.calls).toEqual([{ instance: true }])
    expect(instanceSnapshots).toHaveLength(2)
    expect(instanceStore.rows.get(fingerprint)?.payload).toMatchObject({ modules: { auditLogs: true } })
    await vi.advanceTimersByTimeAsync(330_000)
    expect(client.calls).toHaveLength(2)
    subject.close()
  })

  test("licenseKeyFingerprint is a hex SHA-256 bound to the base URL", () => {
    expect(licenseKeyFingerprint("key", "https://den.example.com/")).toMatch(/^[0-9a-f]{64}$/)
    expect(licenseKeyFingerprint("key", "https://den.example.com/")).toBe(licenseKeyFingerprint("key", "https://den.example.com"))
    expect(licenseKeyFingerprint("key", "https://a.example.com")).not.toBe(licenseKeyFingerprint("key", "https://b.example.com"))
  })
})

describe("license mode in the runtime", () => {
  test("Cloud: a brand-new org uses cloudFreeFallback and schedules a refresh without blocking", async () => {
    const clock = createFakeClock()
    const orgStore = createMemoryOrgEntitlementStore()
    const client = createFakeLicenseClient([ok])
    const modules = createModuleRuntime({
      deployment: "cloud",
      instance: testInstanceConfig(),
      clock: clock.now,
      isProduction: false,
      logger: createMemoryLogger(),
      entitlementMode: "license",
      license: { client, request, orgStore, instanceStore: createMemoryInstanceSnapshotStore() },
    })
    const effective = modules.getEffectiveModules(testOrgRow({ id: "org_new" }))
    expect(effective.entitlementSource).toBe("cloudFreeFallback")
    await new Promise((resolve) => setImmediate(resolve))
    expect(client.calls).toEqual([{ organizationId: "org_new" }])
    expect(orgStore.docs.get("org_new")?.entitlement).toBeDefined()
  })

  test("self-hosted: no license key means entitlement none", async () => {
    const modules = createModuleRuntime({
      deployment: "selfHosted",
      instance: testInstanceConfig(),
      isProduction: false,
      logger: createMemoryLogger(),
      entitlementMode: "license",
      license: { client: createFakeLicenseClient([ok]), request, orgStore: createMemoryOrgEntitlementStore(), instanceStore: createMemoryInstanceSnapshotStore() },
    })
    await modules.start()
    expect(modules.getEffectiveModules(testOrgRow()).entitlementSource).toBe("none")
    expect(modules.isOn(testOrgRow(), "installLinks")).toBe(false)
    expect(await modules.refreshEntitlementNow({ instance: true })).toEqual({ kind: "skipped", why: "disabled" })
    await modules.close()
  })
})
