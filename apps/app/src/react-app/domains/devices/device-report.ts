import {
  COMPUTER_DISCONNECTED_ERROR,
  REMOTE_DEVICE_COMPUTER_READINESS,
  REMOTE_DEVICE_REPORT_INTERVAL_SECONDS,
  remoteDeviceDesktopReportSchema,
  type RemoteDeviceDesktopReport,
} from "@openwork/types/den/remote-devices"
import type { ComputerDevicesSnapshot, DesktopDeviceIdentity } from "@openwork/types/desktop-ipc"

import { DenApiError, isDenSessionRevokedError } from "@/app/lib/den"

type ReportedComputerUse = RemoteDeviceDesktopReport["computerUse"]
type ReportedComputer = NonNullable<ReportedComputerUse>["computers"][number]
type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

/** A change waits this long, so a permission flipping twice is one report. */
export const DEVICE_REPORT_CHANGE_DEBOUNCE_MS = 5_000
/** Changes are reported at most this often. */
export const DEVICE_REPORT_CHANGE_GAP_MS = 30_000
/** How often the desktop looks for a change while its window is visible. */
export const DEVICE_REPORT_POLL_MS = 60_000
/** Waits after a first, second and every later failed report. */
export const DEVICE_REPORT_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000] as const
const RATE_LIMIT_FALLBACK_SECONDS = 60
const MAX_COMPUTERS = 12

const bounded = (value: string | null | undefined, max: number) => (value ?? "").trim().slice(0, max).trim()
const isReadiness = (value: string | null): value is (typeof REMOTE_DEVICE_COMPUTER_READINESS)[number] =>
  REMOTE_DEVICE_COMPUTER_READINESS.some((known) => known === value)

/** How long to wait after `failures` failed reports in a row. */
export function deviceReportBackoffMs(failures: number): number {
  return DEVICE_REPORT_BACKOFF_MS[Math.min(Math.max(1, Math.floor(failures)), DEVICE_REPORT_BACKOFF_MS.length) - 1]
}

/**
 * The computer use part of a report: names and readiness only. Null while
 * computer use is off or the desktop could not say.
 */
export function reportedComputerUse(snapshot: ComputerDevicesSnapshot | null): ReportedComputerUse {
  if (!snapshot || snapshot.enabled !== true || !Array.isArray(snapshot.computers)) return null
  const computers: ReportedComputer[] = []
  for (const computer of snapshot.computers.slice(0, MAX_COMPUTERS)) {
    const id = computer.id.trim()
    if (!id || id.length > 64 || (computer.placement !== "local" && computer.placement !== "remote")) continue
    const readiness = isReadiness(computer.readiness) ? computer.readiness : null
    const externalId = computer.externalId?.trim() ?? ""
    const named = (computer.provider === "freestyle" || computer.provider === "daytona") && externalId.length > 0 && externalId.length <= 160
    computers.push({
      id,
      label: bounded(computer.label, 80) || id,
      placement: computer.placement,
      readiness,
      detail: readiness === null || readiness === "ready" ? null : bounded(computer.detail, 300) || null,
      provider: named ? computer.provider : null,
      externalId: named ? externalId : null,
    })
  }
  const selectedId = snapshot.selectedId?.trim() ?? ""
  const permissions = snapshot.permissions
  return {
    enabled: true,
    remoteEnabled: snapshot.remoteEnabled === true,
    selectedId: selectedId && selectedId.length <= 64 ? selectedId : null,
    computers,
    permissions: permissions && typeof permissions.accessibility === "boolean" && typeof permissions.screenRecording === "boolean"
      ? { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording }
      : null,
  }
}

/**
 * What this desktop tells its organization about itself. Null when it has no
 * install id yet or runs on a platform the list does not name: nothing is sent.
 * `fallbackInstallId` is the install's own runner id, for the moment before its
 * runner is configured.
 */
export function buildDeviceReport(
  identity: DesktopDeviceIdentity,
  snapshot: ComputerDevicesSnapshot | null,
  fallbackInstallId: string | null = null,
): RemoteDeviceDesktopReport | null {
  const base = {
    installId: identity.installId?.trim() || fallbackInstallId?.trim() || "",
    label: bounded(identity.label, 80) || "Computer",
    platform: identity.platform,
    appVersion: bounded(identity.appVersion, 80) || "unknown",
    osVersion: bounded(identity.osVersion, 80) || null,
    arch: bounded(identity.arch, 32) || null,
  }
  const full = remoteDeviceDesktopReportSchema.safeParse({ ...base, computerUse: reportedComputerUse(snapshot) })
  if (full.success) return full.data
  // A computer the list cannot name must not hide the desktop itself.
  const plain = remoteDeviceDesktopReportSchema.safeParse({ ...base, computerUse: null })
  return plain.success ? plain.data : null
}

/**
 * Changes when something a person would notice changes: computer use on or
 * off, the computer chats use, a computer's readiness, a permission, the list.
 * Readiness sentences are left out, so rewording is not a change.
 */
export function deviceReportKey(computerUse: ReportedComputerUse): string {
  if (!computerUse) return "off"
  return JSON.stringify([
    computerUse.remoteEnabled,
    computerUse.selectedId,
    computerUse.permissions ? [computerUse.permissions.accessibility, computerUse.permissions.screenRecording] : null,
    computerUse.computers.map((computer) => [computer.id, computer.label, computer.placement, computer.readiness, computer.provider, computer.externalId]),
  ])
}

export type DeviceReportOutcome =
  | { kind: "sent"; deviceId: string; reportAfterSeconds: number }
  /** 429: wait as long as the server said. */
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  /** The organization does not have the feature: stop until that changes. */
  | { kind: "feature_off" }
  /** This computer was disconnected from the organization: stop until someone signs in on it again. */
  | { kind: "disconnected" }
  /** Den did not accept the sign-in: have it checked, and wait like any failure. */
  | { kind: "sign_in_refused" }
  | { kind: "failed" }

/** What a report Den did not accept means for the reporter. */
export function deviceReportFailure(error: unknown): DeviceReportOutcome {
  if (!(error instanceof DenApiError)) return { kind: "failed" }
  if (error.status === 429) return { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds ?? null }
  if (error.status === 404 && error.code === "feature_disabled") return { kind: "feature_off" }
  if (error.status === 403 && error.code === COMPUTER_DISCONNECTED_ERROR) return { kind: "disconnected" }
  if (isDenSessionRevokedError(error)) return { kind: "sign_in_refused" }
  return { kind: "failed" }
}

export type DeviceReporterOptions = {
  readIdentity: () => Promise<DesktopDeviceIdentity>
  readSnapshot: () => Promise<ComputerDevicesSnapshot>
  fallbackInstallId?: () => string | null
  send: (report: RemoteDeviceDesktopReport) => Promise<DeviceReportOutcome>
  /** The id Den lists this desktop under. */
  onReported: (deviceId: string) => void
  /** Den refuses this computer: nothing more is sent by this reporter. */
  onDisconnected?: () => void
  /** Den refused the sign-in the report was sent with. */
  onSignInRefused?: () => void
  now?: () => number
  timers?: Timers
}

/**
 * Keeps this desktop current in its organization's devices list: once at
 * start, again when the server asks (every few minutes), and sooner when
 * `check()` sees its computer use changed. Failures are silent: it waits and
 * tries again, and stops for good when the organization has the feature off
 * or this computer was disconnected from it.
 * One reporter serves one sign-in; make a new one when the organization or
 * the feature changes.
 */
export function createDeviceReporter(options: DeviceReporterOptions) {
  const now = options.now ?? Date.now
  const timers: Timers = options.timers
    ?? { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  let stopped = false
  let halted = false
  let sending = false
  let timer: unknown
  /** What the last accepted report said about computer use. */
  let sentKey: string | null = null
  let lastSendAt = Number.NEGATIVE_INFINITY
  /** When to report even though nothing changed. */
  let heartbeatAt = 0
  /** A 429 or a failure: nothing is sent before this. */
  let notBefore = 0
  /** When a difference from the last accepted report was first seen. */
  let changedAt: number | null = null
  let failures = 0

  function plan() {
    if (timer !== undefined) timers.clear(timer)
    timer = undefined
    if (stopped || halted || sending) return
    const changeDue = changedAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(changedAt + DEVICE_REPORT_CHANGE_DEBOUNCE_MS, lastSendAt + DEVICE_REPORT_CHANGE_GAP_MS)
    const due = Math.max(Math.min(heartbeatAt, changeDue), notBefore)
    timer = timers.set(() => { timer = undefined; void report() }, Math.max(0, due - now()))
  }

  async function report() {
    if (stopped || halted || sending) return
    sending = true
    lastSendAt = now()
    let outcome: DeviceReportOutcome = { kind: "failed" }
    let key: string | null = null
    try {
      const [identity, snapshot] = await Promise.all([options.readIdentity(), options.readSnapshot().catch(() => null)])
      const built = stopped ? null : buildDeviceReport(identity, snapshot, options.fallbackInstallId?.() ?? null)
      if (built) {
        key = deviceReportKey(built.computerUse)
        outcome = await options.send(built)
      }
    } catch { /* Counted as a failed report below. */ }
    sending = false
    if (stopped) return
    if (outcome.kind === "sent") {
      failures = 0
      notBefore = 0
      sentKey = key
      changedAt = null
      const seconds = Number.isFinite(outcome.reportAfterSeconds) ? outcome.reportAfterSeconds : REMOTE_DEVICE_REPORT_INTERVAL_SECONDS
      heartbeatAt = now() + Math.max(DEVICE_REPORT_CHANGE_GAP_MS, seconds * 1000)
      options.onReported(outcome.deviceId)
    } else if (outcome.kind === "feature_off") {
      halted = true
    } else if (outcome.kind === "disconnected") {
      halted = true
      options.onDisconnected?.()
    } else if (outcome.kind === "rate_limited") {
      const seconds = outcome.retryAfterSeconds !== null && Number.isFinite(outcome.retryAfterSeconds) && outcome.retryAfterSeconds > 0 ? outcome.retryAfterSeconds : RATE_LIMIT_FALLBACK_SECONDS
      notBefore = now() + seconds * 1000
    } else {
      failures += 1
      notBefore = now() + deviceReportBackoffMs(failures)
      if (outcome.kind === "sign_in_refused") options.onSignInRefused?.()
    }
    plan()
  }

  return {
    start() {
      plan()
    },
    /** Looks at computer use now; a difference from the last report is sent shortly. */
    async check() {
      // Before the first accepted report, the pending one already carries the current state.
      if (stopped || halted || sending || sentKey === null) return
      let key: string
      // An unreadable moment is not a change.
      try { key = deviceReportKey(reportedComputerUse(await options.readSnapshot())) } catch { return }
      if (stopped || halted || sentKey === null) return
      if (key === sentKey) changedAt = null
      else changedAt ??= now()
      plan()
    },
    stop() {
      stopped = true
      if (timer !== undefined) timers.clear(timer)
      timer = undefined
    },
  }
}
