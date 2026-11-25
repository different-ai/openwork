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

export const DEVICE_REPORT_CHANGE_DEBOUNCE_MS = 5_000
export const DEVICE_REPORT_CHANGE_GAP_MS = 30_000
export const DEVICE_REPORT_POLL_MS = 60_000
export const DEVICE_REPORT_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000] as const
const RATE_LIMIT_FALLBACK_SECONDS = 60
const MAX_COMPUTERS = 12

const bounded = (value: string | null | undefined, max: number) => (value ?? "").trim().slice(0, max).trim()
const isReadiness = (value: string | null): value is (typeof REMOTE_DEVICE_COMPUTER_READINESS)[number] =>
  REMOTE_DEVICE_COMPUTER_READINESS.some((known) => known === value)

export function deviceReportBackoffMs(failures: number): number {
  return DEVICE_REPORT_BACKOFF_MS[Math.min(Math.max(1, Math.floor(failures)), DEVICE_REPORT_BACKOFF_MS.length) - 1]
}

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
  const plain = remoteDeviceDesktopReportSchema.safeParse({ ...base, computerUse: null })
  return plain.success ? plain.data : null
}

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
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "feature_off" }
  | { kind: "disconnected" }
  | { kind: "sign_in_refused" }
  | { kind: "failed" }

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
  onReported: (deviceId: string) => void
  onDisconnected?: () => void
  onSignInRefused?: () => void
  now?: () => number
  timers?: Timers
}

export function createDeviceReporter(options: DeviceReporterOptions) {
  const now = options.now ?? Date.now
  const timers: Timers = options.timers
    ?? { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  let stopped = false
  let halted = false
  let sending = false
  let timer: unknown
  let sentKey: string | null = null
  let lastSendAt = Number.NEGATIVE_INFINITY
  let heartbeatAt = 0
  let notBefore = 0
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
    } catch {}
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
    async check() {
      if (stopped || halted || sending || sentKey === null) return
      let key: string
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
